import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  createId,
  db,
  type ContentMeta,
  type PackageLogEntry,
  type StagedPackage,
  type StagedPackageStatus,
} from '../utils/db'
import type { OfflinePackage } from '../types/offline'
import {
  buildWrites,
  decisionAllowed,
  evaluatePackage,
  isConflictResolved,
  parsePackageText,
  type ConflictDecision,
  type ConflictRecord,
  type LocalPlace,
  type LocalScan,
  type LocalSheet,
} from '../utils/offlineMerge'
import {
  canonicalOfLocalPlace,
  canonicalOfLocalScan,
  canonicalOfLocalSheet,
} from '../utils/offlineMerge'
import { hashCanonical } from '../utils/hash'

export interface ImportResult {
  staged: StagedPackage
  duplicate?: boolean
}

function nowIso(): string {
  return new Date().toISOString()
}

function makeLog(phase: PackageLogEntry['phase'], message: string): PackageLogEntry {
  return { at: nowIso(), phase, message }
}

function typeLabel(conflict: ConflictRecord): string {
  return conflict.type === 'sheet' ? '图幅' : conflict.type === 'scan' ? '扫描件' : '地名对照'
}

export const useOfflineStore = defineStore('offline', () => {
  const packages = ref<StagedPackage[]>([])
  const initialized = ref(false)
  const loading = ref(false)
  let initialization: Promise<void> | null = null

  const pendingPackages = computed(() =>
    packages.value.filter((staged) => staged.status !== '已合并' && staged.status !== '已丢弃'),
  )
  const pendingConflictCount = computed(() =>
    packages.value
      .filter((staged) => staged.status === '待处理冲突')
      .reduce((total, staged) => total + staged.conflicts.filter((item) => !isConflictResolved(item)).length, 0),
  )

  async function init(force = false): Promise<void> {
    if (initialized.value && !force) {
      return
    }
    if (!initialization || force) {
      loading.value = true
      initialization = db.offlinePackages
        .orderBy('updatedAt')
        .toArray()
        .then((rows) => {
          packages.value = rows.reverse()
          initialized.value = true
        })
        .finally(() => {
          loading.value = false
        })
    }
    await initialization
  }

  async function loadLocalSnapshot() {
    const [sheets, scans, placePairs, metas] = await Promise.all([
      db.sheets.toArray(),
      db.scans.toArray(),
      db.placePairs.toArray(),
      db.contentMeta.toArray(),
    ])
    // sourceKey 血缘单独存放于 contentMeta；评估前附到业务行上供按来源对齐。
    const metaByKey = new Map(metas.map((meta) => [meta.key, meta]))
    const attach = (table: ContentMeta['table']) => (row: { id: string; sourceKey?: string }) => {
      const meta = metaByKey.get(`${table}:${row.id}`)
      return meta && !row.sourceKey ? { ...row, sourceKey: meta.sourceKey } : row
    }
    return {
      localSheets: sheets.map(attach('sheets')) as LocalSheet[],
      localScans: scans.map(attach('scans')) as LocalScan[],
      localPlaces: placePairs.map(attach('placePairs')) as LocalPlace[],
    }
  }

  /** 重新跑一遍评估并持久化状态（本地数据变动或补证后调用）。 */
  async function reevaluate(packageId: string): Promise<StagedPackage> {
    const staged = await db.offlinePackages.get(packageId)
    if (!staged) {
      throw new Error('暂存包不存在。')
    }
    if (staged.status === '已合并' || staged.status === '已丢弃') {
      return staged
    }

    const snapshot = await loadLocalSnapshot()
    const result = evaluatePackage({
      pkg: staged.rawPackage as OfflinePackage,
      ...snapshot,
      savedConflicts: staged.conflicts,
    })

    const unresolved = result.plan.conflicts.filter((conflict) => !isConflictResolved(conflict))
    const nextStatus: StagedPackageStatus = result.errors.length
      ? '校验异常'
      : unresolved.length
        ? '待处理冲突'
        : '可合并'

    const logs = [...staged.logs]
    if (nextStatus !== staged.status) {
      logs.push(
        makeLog(
          '校验',
          nextStatus === '可合并'
            ? '整包校验通过、冲突均已处理，可以整包写入。'
            : nextStatus === '待处理冲突'
              ? `重新校验发现 ${unresolved.length} 项未决冲突，已留在待处理区。`
              : `重新校验未通过：${result.errors[0]}`,
        ),
      )
    }

    const next: StagedPackage = {
      ...staged,
      status: nextStatus,
      errors: result.errors,
      warnings: result.warnings,
      conflicts: result.plan.conflicts,
      items: result.plan.items,
      updatedAt: nowIso(),
      logs,
    }
    await db.offlinePackages.put(next)
    await replaceInMemory(next)
    return next
  }

  async function replaceInMemory(next: StagedPackage): Promise<void> {
    const index = packages.value.findIndex((item) => item.packageId === next.packageId)
    if (index >= 0) {
      packages.value.splice(index, 1, next)
    } else {
      packages.value.unshift(next)
    }
  }

  async function importPackageFromText(text: string, fileName: string): Promise<ImportResult> {
    await init()
    const parsed = parsePackageText(text)
    const receivedAt = nowIso()

    // 解析或信封坏掉也要保留原包，便于对方重新核对后续传。
    if (!parsed.ok) {
      const pkg = parsed as { ok: false; error: string }
      const packageId = `bad-${hashCanonical(text).slice(0, 16)}`
      const existing = await db.offlinePackages.get(packageId)
      if (existing) {
        return { staged: existing, duplicate: true }
      }
      const staged: StagedPackage = {
        packageId,
        origin: '未知来源',
        preparedAt: '',
        fileName,
        status: '校验异常',
        rawPackage: text,
        receivedAt,
        updatedAt: receivedAt,
        counts: { sheets: 0, scans: 0, placePairs: 0 },
        errors: [pkg.error],
        warnings: [],
        conflicts: [],
        logs: [makeLog('导入', `收到文件 ${fileName}。`), makeLog('校验', pkg.error)],
      }
      await db.offlinePackages.add(staged)
      await replaceInMemory(staged)
      return { staged }
    }

    const offlinePkg = parsed.pkg
    const manifest = offlinePkg.manifest
    const packageId = typeof manifest?.packageId === 'string' ? manifest.packageId : ''
    const previous = packageId ? await db.offlinePackages.get(packageId) : undefined
    if (previous) {
      // 同一包重复投递：已合并的绝不重复写；仍在待处理的也只保留原包一份。
      const sameDigest = previous.rawPackage && JSON.stringify(previous.rawPackage) === JSON.stringify(offlinePkg)
      if (!sameDigest) {
        const staged: StagedPackage = {
          ...previous,
          status: '校验异常',
          updatedAt: nowIso(),
          errors: [...previous.errors, `重新收到的包编号 ${packageId} 相同但内容不同，已拒收以免覆盖在办进度。`],
          logs: [
            ...previous.logs,
            makeLog('导入', `再次收到同编号文件 ${fileName}，内容与原包不一致，未替换原包。`),
          ],
        }
        await db.offlinePackages.put(staged)
        await replaceInMemory(staged)
        return { staged, duplicate: true }
      }
      return { staged: previous, duplicate: true }
    }

    const stagedSeed: StagedPackage = {
      packageId: packageId || `bad-${hashCanonical(text).slice(0, 16)}`,
      origin: offlinePkg.manifest?.origin ?? '未知来源',
      preparedAt: offlinePkg.manifest?.preparedAt ?? '',
      ...(offlinePkg.manifest?.note ? { note: offlinePkg.manifest.note } : {}),
      fileName,
      status: 'received',
      rawPackage: offlinePkg,
      receivedAt,
      updatedAt: receivedAt,
      counts: offlinePkg.manifest?.counts ?? {
        sheets: offlinePkg.sheets?.length ?? 0,
        scans: offlinePkg.scans?.length ?? 0,
        placePairs: offlinePkg.placePairs?.length ?? 0,
      },
      errors: [],
      warnings: [],
      conflicts: [],
      logs: [makeLog('导入', `收到来自「${offlinePkg.manifest?.origin ?? '未知来源'}」的校勘包 ${fileName}。`)],
    }
    await db.offlinePackages.put(stagedSeed)
    await replaceInMemory(stagedSeed)
    const staged = await reevaluate(stagedSeed.packageId)
    return { staged }
  }

  /** 冲突补证：留下处理说明与依据，裁定跟随本地当前散列；本地再被改动则裁定失效。 */
  async function resolveConflict(
    packageId: string,
    conflictId: string,
    decision: ConflictDecision,
    evidence: string,
  ): Promise<StagedPackage> {
    const staged = await db.offlinePackages.get(packageId)
    if (!staged) {
      throw new Error('暂存包不存在。')
    }
    const conflict = staged.conflicts.find((item) => item.id === conflictId)
    if (!conflict) {
      throw new Error('冲突项不存在。')
    }
    if (!decisionAllowed(conflict, decision)) {
      throw new Error('该冲突类型不允许此处理方式。')
    }
    if (!evidence.trim()) {
      throw new Error('请先填写补证说明再继续。')
    }

    // 裁定基准锁定当前本地内容散列。
    const snapshot = await loadLocalSnapshot()
    let currentLocalHash = conflict.localHash
    if (conflict.type === 'sheet') {
      const row = snapshot.localSheets.find((sheet) => sheet.id === conflict.localId)
      if (row) {
        currentLocalHash = hashCanonical(canonicalOfLocalSheet(row))
      }
    } else if (conflict.type === 'scan') {
      const row = snapshot.localScans.find((scan) => scan.id === conflict.localId)
      const sheet = snapshot.localSheets.find((item) => item.id === row?.sheetId)
      if (row && sheet) {
        currentLocalHash = hashCanonical(canonicalOfLocalScan(row, sheet.code))
      }
    } else {
      const row = snapshot.localPlaces.find((pair) => pair.id === conflict.localId)
      const sheet = snapshot.localSheets.find((item) => item.id === row?.sheetId)
      if (row && sheet) {
        currentLocalHash = hashCanonical(canonicalOfLocalPlace(row, sheet.code))
      }
    }

    const resolution = {
      decision,
      evidence: evidence.trim(),
      at: nowIso(),
      basedOnLocalHash: currentLocalHash,
    }
    const nextConflicts = staged.conflicts.map((item) =>
      item.id === conflictId ? { ...item, resolution } : item,
    )
    const decisionText =
      decision === 'keep-local'
        ? '保留馆员本地修改，不采用包项'
        : decision === 'take-package'
          ? '补证后采用协作馆包项'
          : '跳过该条，维持本地现状'
    const next: StagedPackage = {
      ...staged,
      conflicts: nextConflicts,
      updatedAt: nowIso(),
      logs: [
        ...staged.logs,
        makeLog('补证', `${typeLabel(conflict)}「${conflict.label}」：${decisionText}。依据：${evidence.trim()}`),
      ],
    }
    await db.offlinePackages.put(next)
    await replaceInMemory(next)
    return reevaluate(packageId)
  }

  async function discardConflictResolution(packageId: string, conflictId: string): Promise<StagedPackage> {
    const staged = await db.offlinePackages.get(packageId)
    if (!staged) {
      throw new Error('暂存包不存在。')
    }
    const conflict = staged.conflicts.find((item) => item.id === conflictId)
    const next: StagedPackage = {
      ...staged,
      conflicts: staged.conflicts.map((item) => {
        if (item.id !== conflictId) {
          return item
        }
        const { resolution: _omit, ...rest } = item
        return rest
      }),
      updatedAt: nowIso(),
      logs: conflict
        ? [...staged.logs, makeLog('补证', `已撤回「${conflict.label}」的处理说明，恢复为待处理。`)]
        : staged.logs,
    }
    await db.offlinePackages.put(next)
    await replaceInMemory(next)
    return reevaluate(packageId)
  }

  /** 事务内重建血缘散列，与业务写入同生共死。 */
  async function rebuildMetaInTransaction(
    origin: string,
    packageId: string,
  ): Promise<void> {
    const [existing, sheetRows, scanRows, pairRows] = await Promise.all([
      db.contentMeta.toArray(),
      db.sheets.toArray(),
      db.scans.toArray(),
      db.placePairs.toArray(),
    ])
    const codeById = new Map(sheetRows.map((sheet) => [sheet.id, sheet.code]))
    const existingByKey = new Map(existing.map((meta) => [meta.key, meta]))
    const now = nowIso()
    const rows: ContentMeta[] = []

    function push(
      table: ContentMeta['table'],
      localId: string,
      sourceKey: string,
      hash: string,
    ): void {
      const key = `${table}:${localId}`
      const previous = existingByKey.get(key)
      if (previous) {
        rows.push({ ...previous, sourceKey, hash, updatedAt: now })
      } else {
        rows.push({
          key,
          table,
          localId,
          sourceKey,
          origin,
          hash,
          mergedPackageId: packageId,
          updatedAt: now,
        })
      }
    }

    for (const sheet of sheetRows) {
      push('sheets', sheet.id, sheet.sourceKey ?? sheet.id, hashCanonical(canonicalOfLocalSheet(sheet)))
    }
    for (const scan of scanRows) {
      push(
        'scans',
        scan.id,
        scan.sourceKey ?? scan.id,
        hashCanonical(canonicalOfLocalScan(scan, codeById.get(scan.sheetId) ?? '')),
      )
    }
    for (const pair of pairRows) {
      push(
        'placePairs',
        pair.id,
        pair.sourceKey ?? pair.id,
        hashCanonical(canonicalOfLocalPlace(pair, codeById.get(pair.sheetId) ?? '')),
      )
    }

    const validKeys = new Set(rows.map((row) => row.key))
    const staleKeys = existing.map((meta) => meta.key).filter((key) => !validKeys.has(key))
    if (rows.length) {
      await db.contentMeta.bulkPut(rows)
    }
    if (staleKeys.length) {
      await db.contentMeta.bulkDelete(staleKeys)
    }
  }

  /**
   * 整包一次性写入：校验 + 无未决冲突是前置条件，
   * 所有业务表、血缘散列、暂存状态在同一个 IndexedDB 事务里提交，
   * 中途任何失败都整体回滚，原包与进度保留，重试不会多出记录。
   */
  async function commitPackage(packageId: string): Promise<StagedPackage> {
    await init()
    const staged = await db.offlinePackages.get(packageId)
    if (!staged) {
      throw new Error('暂存包不存在。')
    }
    if (staged.status === '已合并') {
      return staged
    }

    const pkg = staged.rawPackage as OfflinePackage
    const snapshot = await loadLocalSnapshot()
    const evaluation = evaluatePackage({ pkg, ...snapshot, savedConflicts: staged.conflicts })
    if (evaluation.errors.length) {
      return reevaluate(packageId)
    }
    const unresolved = evaluation.plan.conflicts.filter((conflict) => !isConflictResolved(conflict))
    if (unresolved.length) {
      return reevaluate(packageId)
    }

    const { writes, primaryDemotions } = buildWrites({
      pkg,
      plan: evaluation.plan,
      nextId: (kind: 'sheet' | 'scan' | 'placePair') => createId(kind),
    })

    let created = 0
    let updated = 0
    let skipped = 0
    for (const write of writes) {
      if (write.op === 'add') {
        created += 1
      } else if (write.op === 'put') {
        updated += 1
      } else {
        skipped += 1
      }
    }

    try {
      await db.transaction(
        'rw',
        db.sheets,
        db.scans,
        db.placePairs,
        db.contentMeta,
        db.offlinePackages,
        async () => {
          for (const demotion of primaryDemotions) {
            await db.scans
              .where('sheetId')
              .equals(demotion.sheetId)
              .and((scan) => scan.id !== demotion.exceptScanId)
              .modify({ isPrimary: false })
          }
          for (const write of writes) {
            if (write.op === 'skip') {
              continue
            }
            const table =
              write.table === 'sheets'
                ? db.sheets
                : write.table === 'scans'
                  ? db.scans
                  : db.placePairs
            if (write.op === 'add') {
              await table.add(write.row as never)
            } else {
              await table.put(write.row as never)
            }
          }
          await rebuildMetaInTransaction(staged.origin, packageId)

          const merged: StagedPackage = {
            ...staged,
            status: '已合并',
            errors: [],
            warnings: evaluation.warnings,
            conflicts: evaluation.plan.conflicts,
            mergedAt: nowIso(),
            updatedAt: nowIso(),
            logs: [
              ...staged.logs,
              makeLog(
                '写入',
                `整包写入完成：新增 ${created} 条、更新 ${updated} 条、按补证跳过 ${skipped} 条。`,
              ),
            ],
          }
          await db.offlinePackages.put(merged)
        },
      )
    } catch (error) {
      // 事务已整体回滚；只在包记录里留下失败说明，原包和进度原样保留。
      const failed = await db.offlinePackages.get(packageId)
      if (failed) {
        const next: StagedPackage = {
          ...failed,
          updatedAt: nowIso(),
          logs: [
            ...failed.logs,
            makeLog('保留', `写入中途失败，已整体回滚，未产生任何新记录：${(error as Error).message}`),
          ],
        }
        await db.offlinePackages.put(next)
        await replaceInMemory(next)
      }
      throw error
    }

    const merged = await db.offlinePackages.get(packageId)
    if (merged) {
      await replaceInMemory(merged)
    }
    return merged as StagedPackage
  }

  async function discardPackage(packageId: string): Promise<void> {
    const staged = await db.offlinePackages.get(packageId)
    if (!staged) {
      return
    }
    const next: StagedPackage = {
      ...staged,
      status: '已丢弃',
      updatedAt: nowIso(),
      logs: [...staged.logs, makeLog('移除', '包移至已丢弃；原始包与处理说明仍保留在本机。')],
    }
    await db.offlinePackages.put(next)
    await replaceInMemory(next)
  }

  return {
    packages,
    pendingPackages,
    pendingConflictCount,
    initialized,
    loading,
    init,
    importPackageFromText,
    reevaluate,
    resolveConflict,
    discardConflictResolution,
    commitPackage,
    discardPackage,
  }
})
