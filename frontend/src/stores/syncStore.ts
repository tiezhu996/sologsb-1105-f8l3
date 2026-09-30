import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { PlacePair } from '../types/placePair'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import type {
  ConflictResolution,
  CorrectionPack,
  PlacePayload,
  ScanPayload,
  SheetPayload,
  SyncConflict,
  SyncPackageRecord,
} from '../types/sync'
import { createId, db, plain } from '../utils/db'
import { usePlaceStore } from './placeStore'
import { useSheetStore } from './sheetStore'
import {
  conflictId,
  detectPlan,
  type DetectResult,
  itemContentHash,
  ledgerKey,
  PackValidationError,
  parseCorrectionPack,
  verifyChecksum,
} from '../utils/syncMerge'

export interface ReviewOutcome {
  ok: boolean
  state: SyncPackageRecord['state']
  message: string
  summary?: DetectResult
}

export interface ResolutionInput {
  resolution: ConflictResolution
  bindToCode?: string
  note?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

export const useSyncStore = defineStore('sync', () => {
  const packages = ref<SyncPackageRecord[]>([])
  const conflicts = ref<SyncConflict[]>([])
  /** 各包最近一次核验的写入计划统计（运行态）；待处理区与处理说明持久化在冲突仓库。 */
  const summaries = ref<Record<string, DetectResult>>({})
  const loading = ref(false)
  const initialized = ref(false)
  let initialization: Promise<void> | null = null

  const pendingConflicts = computed(() =>
    conflicts.value
      .filter((conflict) => conflict.status === 'pending')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  )

  const pendingCount = computed(() => pendingConflicts.value.length)
  const hasReadyOrFailed = computed(() =>
    packages.value.some((record) => record.state === 'ready' || record.state === 'failed'),
  )

  async function init(): Promise<void> {
    if (initialized.value) {
      return
    }
    if (!initialization) {
      loading.value = true
      initialization = Promise.all([
        db.syncPackages.toArray(),
        db.syncConflicts.toArray(),
      ])
        .then(([packageRows, conflictRows]) => {
          // 上次若停在“写入中”，视为中途失败：原包与进度保留，等待重试。
          packages.value = packageRows
            .map((record) =>
              record.state === 'applying'
                ? { ...record, state: 'failed' as const, message: '上次写入中途离开，原包与进度已保留，可重试。' }
                : record,
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          conflicts.value = conflictRows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          initialized.value = true
        })
        .finally(() => {
          loading.value = false
        })
    }
    await initialization
  }

  function getPackage(packageId: string): SyncPackageRecord | undefined {
    return packages.value.find((record) => record.packageId === packageId)
  }

  function conflictsForPackage(packageId: string): SyncConflict[] {
    return conflicts.value
      .filter((conflict) => conflict.packageId === packageId)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.sourceKey.localeCompare(b.sourceKey))
  }

  function pendingConflictsForPackage(packageId: string): SyncConflict[] {
    return pendingConflicts.value.filter((conflict) => conflict.packageId === packageId)
  }

  function getSummary(packageId: string): DetectResult | undefined {
    return summaries.value[packageId]
  }

  async function upsertPackage(record: SyncPackageRecord): Promise<void> {
    await db.syncPackages.put(plain(record))
    const index = packages.value.findIndex((item) => item.packageId === record.packageId)
    if (index >= 0) {
      packages.value.splice(index, 1, record)
    } else {
      packages.value.unshift(record)
    }
  }

  /**
   * 导入校勘包：先解析拿到包号，再登记原包文本（整包保留），随后立刻核验。
   * 解析阶段失败说明文件本身不合法，不产生登记记录；校验失败会保留为“校验未通过”。
   * 同一 packageId 重复导入不会重复登记。
   */
  async function importPack(rawText: string): Promise<ReviewOutcome> {
    await init()
    let pack: CorrectionPack
    try {
      pack = parseCorrectionPack(rawText)
    } catch (error) {
      const message = error instanceof PackValidationError ? error.message : '校勘包无法解析'
      return { ok: false, state: 'invalid', message }
    }

    const existing = getPackage(pack.packageId)
    if (!existing) {
      const stamp = nowIso()
      await upsertPackage({
        packageId: pack.packageId,
        label: pack.label,
        origin: pack.origin,
        packedAt: pack.packedAt,
        state: 'received',
        rawText,
        appliedItems: [],
        createdAt: stamp,
        updatedAt: stamp,
      })
    }
    return reviewPackage(pack.packageId)
  }

  /**
   * 重新核验一个已登记的包（从保留的原包文本重新解析，不信任任何缓存）：
   * 整包校验通过后检测冲突并刷新待处理区；已补证且仍成立的冲突并入写入计划。
   */
  async function reviewPackage(packageId: string): Promise<ReviewOutcome> {
    await init()
    const record = getPackage(packageId)
    if (!record) {
      return { ok: false, state: 'invalid', message: '登记记录不存在' }
    }

    let pack: CorrectionPack
    try {
      pack = parseCorrectionPack(record.rawText)
    } catch (error) {
      const message = error instanceof PackValidationError ? error.message : '校勘包无法解析'
      const updated: SyncPackageRecord = { ...record, state: 'invalid', message, updatedAt: nowIso() }
      await upsertPackage(updated)
      return { ok: false, state: 'invalid', message }
    }

    const checksum = verifyChecksum(pack)
    if (!checksum.ok) {
      const updated: SyncPackageRecord = {
        ...record,
        state: 'invalid',
        pack: plain(pack),
        message: checksum.message,
        updatedAt: nowIso(),
      }
      await upsertPackage(updated)
      return { ok: false, state: 'invalid', message: checksum.message }
    }

    const [sheets, scans, places, ledgerEntries] = await Promise.all([
      db.sheets.toArray(),
      db.scans.toArray(),
      db.placePairs.toArray(),
      db.syncLedger.where('packageId').equals(packageId).toArray(),
    ])
    const packageConflicts = conflicts.value.filter((conflict) => conflict.packageId === packageId)
    const summary = detectPlan(pack, {
      sheets,
      scans,
      places,
      conflicts: packageConflicts,
      appliedKeys: new Set(ledgerEntries.map((entry) => entry.key)),
    })
    summaries.value = { ...summaries.value, [packageId]: summary }

    await persistReview(packageId, summary, packageConflicts)

    const alreadyApplied = record.state === 'applied'
    const nextState: SyncPackageRecord['state'] = alreadyApplied
      ? 'applied'
      : summary.conflictCount > 0
        ? 'conflicts'
        : 'ready'
    const message = alreadyApplied
      ? `原包复核通过；${summary.skipCount} 条均已写入，无重复记录。`
      : summary.conflictCount > 0
        ? `整包校验通过，但有 ${summary.conflictCount} 项冲突留在待处理区，补证后才能整包写入。`
        : `整包校验通过且无冲突：新增 ${summary.addCount} 条、更新 ${summary.updateCount} 条${
            summary.skipCount ? `、跳过已写入 ${summary.skipCount} 条` : ''
          }，可一起写入。`

    const updated: SyncPackageRecord = {
      ...record,
      state: nextState,
      pack: plain(pack),
      message,
      updatedAt: nowIso(),
    }
    await upsertPackage(updated)
    return { ok: nextState === 'ready' || nextState === 'applied', state: nextState, message, summary }
  }

  /**
   * 把检测结果落库：
   * - 仍挂起的冲突 upsert（补证失效的已处理项重新挂起，但保留馆员写过的说明）；
   * - 曾经挂起、如今自然消解的冲突（如图幅已补齐）自动标记并入，说明追加留痕。
   */
  async function persistReview(
    packageId: string,
    summary: DetectResult,
    packageConflicts: SyncConflict[],
  ): Promise<void> {
    const stamp = nowIso()
    const existingById = new Map(packageConflicts.map((conflict) => [conflict.id, conflict]))
    const pendingKeys = new Set(summary.pending.map((seed) => `${seed.kind}:${seed.sourceKey}`))
    const toPut: SyncConflict[] = []

    for (const seed of summary.pending) {
      const prior = existingById.get(seed.id)
      if (prior) {
        if (prior.status === 'resolved') {
          toPut.push({
            ...prior,
            status: 'pending',
            type: seed.type,
            item: plain(seed.item),
            localSnapshot: plain(seed.localSnapshot),
            resolution: undefined,
            bindToCode: undefined,
            resolvedAt: undefined,
            note: joinNote(prior.note, '此前补证已不成立，核验后重新挂起。'),
            updatedAt: stamp,
          })
        } else {
          toPut.push({
            ...prior,
            type: seed.type,
            item: plain(seed.item),
            localSnapshot: plain(seed.localSnapshot),
            updatedAt: stamp,
          })
        }
      } else {
        toPut.push({
          id: seed.id,
          packageId,
          kind: seed.kind,
          sourceKey: seed.sourceKey,
          type: seed.type,
          status: 'pending',
          sheetCode: seed.sheetCode,
          item: plain(seed.item),
          localSnapshot: plain(seed.localSnapshot),
          createdAt: stamp,
          updatedAt: stamp,
        })
      }
    }

    for (const conflict of packageConflicts) {
      const key = `${conflict.kind}:${conflict.sourceKey}`
      if (conflict.status === 'pending' && !pendingKeys.has(key)) {
        toPut.push({
          ...conflict,
          status: 'resolved',
          resolution: 'take',
          resolvedAt: stamp,
          note: joinNote(conflict.note, '复核时关联条件已具备，随整包一并写入。'),
          updatedAt: stamp,
        })
      }
    }

    if (toPut.length) {
      await db.syncConflicts.bulkPut(plain(toPut))
      const byId = new Map(toPut.map((conflict) => [conflict.id, conflict]))
      const next = conflicts.value
        .filter((conflict) => !byId.has(conflict.id))
        .concat(toPut)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      conflicts.value = next
    }
  }

  /** 馆员在待处理区补证：选定处理方式并写说明，随后立即重新核验。 */
  async function resolveConflict(
    packageId: string,
    kind: SyncConflict['kind'],
    sourceKey: string,
    input: ResolutionInput,
  ): Promise<ReviewOutcome> {
    await init()
    const id = conflictId(packageId, kind, sourceKey)
    const existing = await db.syncConflicts.get(id)
    if (!existing || existing.status !== 'pending') {
      return reviewPackage(packageId)
    }
    const stamp = nowIso()
    const next: SyncConflict = {
      ...existing,
      status: 'resolved',
      resolution: input.resolution,
      bindToCode: input.resolution === 'bind' ? input.bindToCode : undefined,
      note: input.note?.trim() || existing.note,
      resolvedAt: stamp,
      updatedAt: stamp,
    }
    await db.syncConflicts.put(plain(next))
    const index = conflicts.value.findIndex((conflict) => conflict.id === id)
    if (index >= 0) {
      conflicts.value.splice(index, 1, next)
    } else {
      conflicts.value.push(next)
    }
    return reviewPackage(packageId)
  }

  /** 把误操作或重新考虑的已处理项退回待处理。 */
  async function reopenConflict(
    packageId: string,
    kind: SyncConflict['kind'],
    sourceKey: string,
  ): Promise<ReviewOutcome> {
    await init()
    const id = conflictId(packageId, kind, sourceKey)
    const existing = await db.syncConflicts.get(id)
    if (existing && existing.status === 'resolved') {
      const stamp = nowIso()
      const next: SyncConflict = {
        ...existing,
        status: 'pending',
        resolution: undefined,
        bindToCode: undefined,
        resolvedAt: undefined,
        note: joinNote(existing.note, '已退回待处理，重新补证。'),
        updatedAt: stamp,
      }
      await db.syncConflicts.put(plain(next))
      const index = conflicts.value.findIndex((conflict) => conflict.id === id)
      if (index >= 0) {
        conflicts.value.splice(index, 1, next)
      }
    }
    return reviewPackage(packageId)
  }

  /**
   * 整包写入（唯一写入入口：编目台仍是本地唯一写入方）。
   * 全部条目在同一个 IndexedDB 事务内提交，任一失败整体回滚；
   * 台账逐条目登记，重试同一包时已入账条目自动跳过，不会多出记录。
   */
  async function applyPackage(packageId: string): Promise<ReviewOutcome> {
    await init()
    const record = getPackage(packageId)
    if (!record) {
      return { ok: false, state: 'invalid', message: '登记记录不存在' }
    }

    let pack: CorrectionPack
    try {
      pack = parseCorrectionPack(record.rawText)
    } catch (error) {
      const message = error instanceof PackValidationError ? error.message : '校勘包无法解析'
      await upsertPackage({ ...record, state: 'invalid', message, updatedAt: nowIso() })
      return { ok: false, state: 'invalid', message }
    }
    const checksum = verifyChecksum(pack)
    if (!checksum.ok) {
      await upsertPackage({ ...record, state: 'invalid', message: checksum.message, updatedAt: nowIso() })
      return { ok: false, state: 'invalid', message: checksum.message }
    }

    const [sheets, scans, places, ledgerEntries, packageConflicts] = await Promise.all([
      db.sheets.toArray(),
      db.scans.toArray(),
      db.placePairs.toArray(),
      db.syncLedger.where('packageId').equals(packageId).toArray(),
      db.syncConflicts.where('packageId').equals(packageId).toArray(),
    ])
    const summary = detectPlan(pack, {
      sheets,
      scans,
      places,
      conflicts: packageConflicts,
      appliedKeys: new Set(ledgerEntries.map((entry) => entry.key)),
    })
    summaries.value = { ...summaries.value, [packageId]: summary }
    if (summary.conflictCount > 0) {
      await persistReview(packageId, summary, packageConflicts)
      const message = `仍有 ${summary.conflictCount} 项冲突未处理，不能写入；冲突留在待处理区。`
      await upsertPackage({ ...record, state: 'conflicts', pack: plain(pack), message, updatedAt: nowIso() })
      return { ok: false, state: 'conflicts', message, summary }
    }

    const writable = summary.plan.filter((planned) => planned.mode !== 'skip')
    await upsertPackage({ ...record, state: 'applying', pack: plain(pack), updatedAt: nowIso() })

    try {
      await db.transaction(
        'rw',
        db.sheets,
        db.scans,
        db.placePairs,
        db.syncLedger,
        async () => {
          const localSheets = await db.sheets.toArray()
          const sheetIdByCode = new Map(localSheets.map((sheet) => [sheet.code, sheet.id]))

          // 第一阶段：图幅（新增 / 更新），为子项准备图幅号 → 本地 id 映射。
          for (const planned of writable) {
            if (planned.mode === 'add-sheet') {
              const payload = planned.item.payload as SheetPayload
              const id = createId('sheet')
              const row: Sheet = {
                id,
                sourceKey: planned.item.sourceKey,
                code: payload.code,
                title: payload.title,
                year: payload.year,
                scale: payload.scale,
                projection: payload.projection,
                sheetSizeCm: payload.sheetSizeCm,
                series: payload.series,
                neighborCodes: [...payload.neighborCodes],
                status: payload.status,
              }
              await db.sheets.add(plain(row))
              sheetIdByCode.set(payload.code, id)
            } else if (planned.mode === 'update-sheet') {
              const payload = planned.item.payload as SheetPayload
              await db.sheets.update(planned.recordId as string, {
                sourceKey: planned.item.sourceKey,
                code: payload.code,
                title: payload.title,
                year: payload.year,
                scale: payload.scale,
                projection: payload.projection,
                sheetSizeCm: payload.sheetSizeCm,
                series: payload.series,
                neighborCodes: [...payload.neighborCodes],
                status: payload.status,
              })
              sheetIdByCode.set(payload.code, planned.recordId as string)
            }
          }

          // 第二阶段：扫描件。
          for (const planned of writable) {
            if (planned.mode !== 'add-scan' && planned.mode !== 'update-scan') {
              continue
            }
            const payload = planned.item.payload as ScanPayload
            const sheetId = sheetIdByCode.get(planned.targetCode ?? payload.sheetCode)
            if (!sheetId) {
              throw new Error(`扫描件 ${planned.item.sourceKey} 关联的图幅 ${payload.sheetCode} 不存在`)
            }
            let recordId: string
            if (planned.mode === 'add-scan') {
              if (payload.isPrimary) {
                await db.scans.where('sheetId').equals(sheetId).modify({ isPrimary: false })
              }
              recordId = createId('scan')
              const row: ScanItem = {
                id: recordId,
                sourceKey: planned.item.sourceKey,
                sheetId,
                fileName: payload.fileName,
                resolutionDpi: payload.resolutionDpi,
                colorMode: payload.colorMode,
                pieces: payload.pieces,
                quality: payload.quality,
                storageNote: payload.storageNote,
                importedAt: payload.importedAt,
                isPrimary: payload.isPrimary,
              }
              await db.scans.add(plain(row))
            } else {
              recordId = planned.recordId as string
              if (payload.isPrimary) {
                await db.scans.where('sheetId').equals(sheetId).modify({ isPrimary: false })
              }
              await db.scans.update(recordId, {
                sourceKey: planned.item.sourceKey,
                sheetId,
                fileName: payload.fileName,
                resolutionDpi: payload.resolutionDpi,
                colorMode: payload.colorMode,
                pieces: payload.pieces,
                quality: payload.quality,
                storageNote: payload.storageNote,
                importedAt: payload.importedAt,
                isPrimary: payload.isPrimary,
              })
            }
            await db.syncLedger.add(
              plain({
                key: ledgerKey(packageId, 'scan', planned.item.sourceKey),
                packageId,
                kind: 'scan',
                sourceKey: planned.item.sourceKey,
                recordId,
                appliedAt: nowIso(),
              }),
            )
          }

          // 第三阶段：地名对照。
          for (const planned of writable) {
            if (planned.mode !== 'add-place' && planned.mode !== 'update-place') {
              continue
            }
            const payload = planned.item.payload as PlacePayload
            const sheetId = sheetIdByCode.get(planned.targetCode ?? payload.sheetCode)
            if (!sheetId) {
              throw new Error(`地名 ${planned.item.sourceKey} 关联的图幅 ${payload.sheetCode} 不存在`)
            }
            let recordId: string
            if (planned.mode === 'add-place') {
              recordId = createId('place')
              const row: PlacePair = {
                id: recordId,
                sourceKey: planned.item.sourceKey,
                sheetId,
                oldName: payload.oldName,
                newName: payload.newName,
                aliasList: [...payload.aliasList],
                placeType: payload.placeType,
                coordNote: payload.coordNote,
                certainty: payload.certainty,
              }
              await db.placePairs.add(plain(row))
            } else {
              recordId = planned.recordId as string
              await db.placePairs.update(recordId, {
                sourceKey: planned.item.sourceKey,
                sheetId,
                oldName: payload.oldName,
                newName: payload.newName,
                aliasList: [...payload.aliasList],
                placeType: payload.placeType,
                coordNote: payload.coordNote,
                certainty: payload.certainty,
              })
            }
            await db.syncLedger.add(
              plain({
                key: ledgerKey(packageId, 'place', planned.item.sourceKey),
                packageId,
                kind: 'place',
                sourceKey: planned.item.sourceKey,
                recordId,
                appliedAt: nowIso(),
              }),
            )
          }

          // 图幅台账最后登记。
          for (const planned of writable) {
            if (planned.mode !== 'add-sheet' && planned.mode !== 'update-sheet') {
              continue
            }
            const recordId =
              planned.mode === 'add-sheet'
                ? (sheetIdByCode.get((planned.item.payload as SheetPayload).code) as string)
                : (planned.recordId as string)
            await db.syncLedger.add(
              plain({
                key: ledgerKey(packageId, 'sheet', planned.item.sourceKey),
                packageId,
                kind: 'sheet',
                sourceKey: planned.item.sourceKey,
                recordId,
                appliedAt: nowIso(),
              }),
            )
          }
        },
      )
    } catch (error) {
      // 事务已整体回滚，业务表不留半截数据；原包、冲突与进度保留，可整体重试。
      const reason = error instanceof Error ? error.message : String(error)
      const failed: SyncPackageRecord = {
        ...record,
        state: 'failed',
        pack: plain(pack),
        message: `写入中途失败，已整体回滚，未写入任何条目：${reason}。原包与进度保留，可重试。`,
        updatedAt: nowIso(),
      }
      await upsertPackage(failed)
      return { ok: false, state: 'failed', message: failed.message ?? '写入失败' }
    }

    const ledgerKeys = writable.map((planned) => ledgerKey(packageId, planned.item.kind, planned.item.sourceKey))
    const appliedItems = Array.from(new Set([...record.appliedItems, ...ledgerKeys]))
    const message = `整包写入完成：新增 ${summary.addCount} 条、更新 ${summary.updateCount} 条${
      summary.skipCount ? `，跳过已写入 ${summary.skipCount} 条` : ''
    }。`
    const applied: SyncPackageRecord = {
      ...record,
      state: 'applied',
      pack: plain(pack),
      appliedItems,
      message,
      updatedAt: nowIso(),
    }
    await upsertPackage(applied)

    // 刷新业务页缓存，使新写入内容立即在编目台可见。
    await Promise.all([useSheetStore().reloadFromDb(), usePlaceStore().reloadFromDb()])

    return { ok: true, state: 'applied', message, summary }
  }

  /** 删除无法核验的登记（invalid 才允许）；台账始终保留，防止同包换次导入重复写入。 */
  async function removeInvalidPackage(packageId: string): Promise<void> {
    const record = getPackage(packageId)
    if (!record || record.state !== 'invalid') {
      return
    }
    await db.syncPackages.delete(packageId)
    packages.value = packages.value.filter((item) => item.packageId !== packageId)
    conflicts.value = conflicts.value.filter((conflict) => conflict.packageId !== packageId)
    await db.syncConflicts.where('packageId').equals(packageId).delete()
  }

  return {
    packages,
    conflicts,
    pendingConflicts,
    pendingCount,
    hasReadyOrFailed,
    loading,
    initialized,
    init,
    getPackage,
    conflictsForPackage,
    pendingConflictsForPackage,
    getSummary,
    importPack,
    reviewPackage,
    resolveConflict,
    reopenConflict,
    applyPackage,
    removeInvalidPackage,
  }
})

function joinNote(existing: string | undefined, addition: string): string {
  if (!existing) {
    return addition
  }
  return `${existing}\n${addition}`
}

/** 供打包 / 样例工具复用：条目内容哈希。 */
export { itemContentHash }
