/**
 * 离线校勘包合并引擎（纯逻辑，不接触 IndexedDB）。
 *
 * 合并纪律：
 * 1. 整包结构校验与逐件散列校验全部通过，才允许进入写入；
 * 2. 同一 sourceKey 的本地内容散列若既不等于包内 baseHash 也不等于新内容散列，
 *    说明馆员在协作馆打包之后又改过 —— 列为冲突，绝不自动覆盖；
 * 3. 只有「无未决冲突 + 无校验错误」时才生成整包写入计划，一次性提交。
 */
import {
  OFFLINE_PACKAGE_FORMAT,
  OFFLINE_PACKAGE_KIND,
  type OfflineItem,
  type OfflinePackage,
  type OfflinePlaceItem,
  type OfflineScanItem,
  type OfflineSheetItem,
} from '../types/offline'
import { hashCanonical } from './hash'
import type { PlacePair } from '../types/placePair'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'

/* ---------------------------------- 本地视图 ---------------------------------- */

export type LocalSheet = Sheet & { sourceKey?: string }
export type LocalScan = ScanItem & { sourceKey?: string }
export type LocalPlace = PlacePair & { sourceKey?: string }

/* --------------------------------- 规范内容体 --------------------------------- */

interface CanonicalSheet {
  code: string
  title: string
  year: number
  scale: string
  projection: string
  sheetSizeCm: string
  series: string
  neighborCodes: string[]
  status: string
}

interface CanonicalScan {
  sheetCode: string
  fileName: string
  resolutionDpi: number
  colorMode: string
  pieces: number
  quality: string
  storageNote: string
  importedAt: string
  isPrimary: boolean
}

interface CanonicalPlace {
  sheetCode: string
  oldName: string
  newName: string
  aliasList: string[]
  placeType: string
  coordNote: string
  certainty: string
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : []
}

export function canonicalSheet(payload: OfflineSheetItem): CanonicalSheet {
  return {
    code: String(payload.code ?? ''),
    title: String(payload.title ?? ''),
    year: Number(payload.year),
    scale: String(payload.scale ?? ''),
    projection: String(payload.projection ?? ''),
    sheetSizeCm: String(payload.sheetSizeCm ?? ''),
    series: String(payload.series ?? ''),
    neighborCodes: asStringArray(payload.neighborCodes),
    status: String(payload.status ?? ''),
  }
}

export function canonicalScan(payload: OfflineScanItem): CanonicalScan {
  return {
    sheetCode: String(payload.sheetCode ?? ''),
    fileName: String(payload.fileName ?? ''),
    resolutionDpi: Number(payload.resolutionDpi),
    colorMode: String(payload.colorMode ?? ''),
    pieces: Number(payload.pieces),
    quality: String(payload.quality ?? ''),
    storageNote: String(payload.storageNote ?? ''),
    importedAt: String(payload.importedAt ?? ''),
    isPrimary: Boolean(payload.isPrimary),
  }
}

export function canonicalPlace(payload: OfflinePlaceItem): CanonicalPlace {
  return {
    sheetCode: String(payload.sheetCode ?? ''),
    oldName: String(payload.oldName ?? ''),
    newName: String(payload.newName ?? ''),
    aliasList: asStringArray(payload.aliasList),
    placeType: String(payload.placeType ?? ''),
    coordNote: String(payload.coordNote ?? ''),
    certainty: String(payload.certainty ?? ''),
  }
}

export function canonicalOfItem(item: OfflineItem): CanonicalSheet | CanonicalScan | CanonicalPlace {
  if ('code' in item) {
    return canonicalSheet(item)
  }
  return 'fileName' in item ? canonicalScan(item) : canonicalPlace(item)
}

/** 本地图幅的规范内容体（与包内图幅同一套字段）。 */
export function canonicalOfLocalSheet(sheet: LocalSheet): CanonicalSheet {
  return {
    code: sheet.code,
    title: sheet.title,
    year: sheet.year,
    scale: sheet.scale,
    projection: sheet.projection,
    sheetSizeCm: sheet.sheetSizeCm,
    series: sheet.series,
    neighborCodes: [...sheet.neighborCodes],
    status: sheet.status,
  }
}

export function canonicalOfLocalScan(scan: LocalScan, sheetCode: string): CanonicalScan {
  return {
    sheetCode,
    fileName: scan.fileName,
    resolutionDpi: scan.resolutionDpi,
    colorMode: scan.colorMode,
    pieces: scan.pieces,
    quality: scan.quality,
    storageNote: scan.storageNote,
    importedAt: scan.importedAt,
    isPrimary: scan.isPrimary,
  }
}

export function canonicalOfLocalPlace(pair: LocalPlace, sheetCode: string): CanonicalPlace {
  return {
    sheetCode,
    oldName: pair.oldName,
    newName: pair.newName,
    aliasList: [...pair.aliasList],
    placeType: pair.placeType,
    coordNote: pair.coordNote,
    certainty: pair.certainty,
  }
}

/* -------------------------------- 包摘要散列 -------------------------------- */

/** 包摘要覆盖：去掉 packageHash 的清单 + 三类记录全集。 */
export function computePackageHash(pkg: OfflinePackage): string {
  const { packageHash: _omit, ...manifestDigest } = pkg.manifest
  return hashCanonical({
    kind: pkg.kind,
    format: pkg.format,
    manifest: manifestDigest,
    sheets: pkg.sheets.map(canonicalSheet),
    scans: pkg.scans.map(canonicalScan),
    placePairs: pkg.placePairs.map(canonicalPlace),
  })
}

/* ---------------------------------- 冲突记录 ---------------------------------- */

export type ConflictKind = 'content-mismatch' | 'code-collision'
export type ConflictDecision = 'keep-local' | 'take-package' | 'skip-item'

export interface FieldDiff {
  field: string
  label: string
  local: string
  incoming: string
}

export interface ConflictResolution {
  decision: ConflictDecision
  evidence: string
  at: string
  /** 裁定时本地内容散列；本地此后又被改动则裁定失效，需重新补证。 */
  basedOnLocalHash: string
}

export interface ConflictRecord {
  id: string
  packageId: string
  type: 'sheet' | 'scan' | 'placePair'
  sourceKey: string
  kind: ConflictKind
  label: string
  sheetCode: string
  baseHash: string
  incomingHash: string
  localId: string
  localHash: string
  fieldDiffs: FieldDiff[]
  resolution?: ConflictResolution
}

/* ---------------------------------- 评估结果 ---------------------------------- */

export interface EvaluatedItem {
  type: 'sheet' | 'scan' | 'placePair'
  sourceKey: string
  label: string
  sheetCode: string
  baseHash: string
  incomingHash: string
  payloadHashProvided: boolean
  /** create：本地缺号直接新增；noop：内容一致；update：基线干净可更新。 */
  action: 'create' | 'noop' | 'update' | 'conflict' | 'unresolved-link'
  localId?: string
  localHash?: string
  conflictId?: string
}

export interface EvaluationPlan {
  items: EvaluatedItem[]
  conflicts: ConflictRecord[]
}

export interface EvaluationResult {
  errors: string[]
  warnings: string[]
  plan: EvaluationPlan
  readyToMerge: boolean
}

/* ---------------------------------- 字段对照 ---------------------------------- */

const FIELD_LABELS: Record<string, string> = {
  code: '图幅号',
  title: '题名',
  year: '年代',
  scale: '比例尺',
  projection: '投影',
  sheetSizeCm: '图幅尺寸',
  series: '所属图组',
  neighborCodes: '邻接图号',
  status: '整理状态',
  fileName: '扫描文件名',
  resolutionDpi: '分辨率',
  colorMode: '色彩模式',
  pieces: '分块数',
  quality: '图像质量',
  storageNote: '存放位置',
  importedAt: '登记时间',
  isPrimary: '主用件',
  oldName: '古名',
  newName: '今名',
  aliasList: '异写',
  placeType: '地名类型',
  coordNote: '图上方位',
  certainty: '确定度',
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length ? value.join('、') : '（空）'
  }
  if (typeof value === 'boolean') {
    return value ? '是' : '否'
  }
  if (value === '' || value === null || value === undefined) {
    return '（空）'
  }
  return String(value)
}

function diffFields(local: Record<string, unknown>, incoming: Record<string, unknown>): FieldDiff[] {
  const diffs: FieldDiff[] = []
  for (const key of Object.keys(incoming)) {
    const left = displayValue(local[key])
    const right = displayValue(incoming[key])
    if (left !== right) {
      diffs.push({ field: key, label: FIELD_LABELS[key] ?? key, local: left, incoming: right })
    }
  }
  return diffs
}

/* ---------------------------------- 结构校验 ---------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireText(record: Record<string, unknown>, key: string, label: string, errors: string[], prefix = ''): void {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${prefix}${label}（${key}）缺失或不是非空文本。`)
  }
}

export function parsePackageText(text: string): { ok: true; pkg: OfflinePackage } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: '文件不是合法 JSON，无法解析为校勘包。' }
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: '校勘包顶层必须是对象。' }
  }
  return { ok: true, pkg: parsed as unknown as OfflinePackage }
}

/* ---------------------------------- 主流程 ---------------------------------- */

export interface EvaluateInput {
  pkg: OfflinePackage
  localSheets: LocalSheet[]
  localScans: LocalScan[]
  localPlaces: LocalPlace[]
  /** 暂存冲突里已保存的补证裁定（重试同一包时带回）。 */
  savedConflicts?: ConflictRecord[]
}

function itemLabel(type: EvaluatedItem['type'], canonical: Record<string, unknown>): string {
  if (type === 'sheet') {
    return `${canonical.code as string} · ${canonical.title as string}`
  }
  return String(canonical.oldName ?? canonical.fileName ?? '')
}

export function evaluatePackage(input: EvaluateInput): EvaluationResult {
  const { pkg } = input
  const errors: string[] = []
  const warnings: string[] = []
  const items: EvaluatedItem[] = []
  const conflicts: ConflictRecord[] = []

  /* 1. 信封与清单 */
  if (!isRecord(pkg) || pkg.kind !== OFFLINE_PACKAGE_KIND) {
    errors.push(`包标识不正确：期望 kind=${OFFLINE_PACKAGE_KIND}。`)
  }
  if (!isRecord(pkg) || typeof pkg.format !== 'number') {
    errors.push('包格式版本（format）缺失。')
  } else if (pkg.format > OFFLINE_PACKAGE_FORMAT) {
    errors.push(`包格式版本 v${pkg.format} 高于本台支持的 v${OFFLINE_PACKAGE_FORMAT}，请先升级编目台。`)
  }
  const manifest = isRecord(pkg) ? (pkg.manifest as unknown as Record<string, unknown>) : undefined
  if (!isRecord(manifest)) {
    errors.push('清单（manifest）缺失。')
  } else {
    requireText(manifest, 'packageId', '包编号', errors)
    requireText(manifest, 'origin', '来源馆', errors)
    requireText(manifest, 'preparedAt', '打包时间', errors)
    if (typeof manifest.packageHash !== 'string' || !manifest.packageHash.trim()) {
      errors.push('清单缺少整包摘要 packageHash。')
    }
  }

  const sheets = isRecord(pkg) && Array.isArray(pkg.sheets) ? pkg.sheets : []
  const scans = isRecord(pkg) && Array.isArray(pkg.scans) ? pkg.scans : []
  const places = isRecord(pkg) && Array.isArray(pkg.placePairs) ? pkg.placePairs : []
  if (!isRecord(pkg) || !Array.isArray(pkg.sheets) || !Array.isArray(pkg.scans) || !Array.isArray(pkg.placePairs)) {
    errors.push('包体必须包含 sheets、scans、placePairs 三个数组。')
  }

  const counts = manifest?.counts as Record<string, unknown> | undefined
  if (isRecord(counts)) {
    const expected: Array<[keyof OfflinePackage['manifest']['counts'], number]> = [
      ['sheets', sheets.length],
      ['scans', scans.length],
      ['placePairs', places.length],
    ]
    for (const [key, actual] of expected) {
      if (Number(counts[key]) !== actual) {
        errors.push(`清单计数 ${key}=${String(counts[key])} 与包内实际 ${actual} 条不符。`)
      }
    }
  } else if (manifest) {
    errors.push('清单缺少记录计数 counts。')
  }

  // 包结构已坏到无法继续时，后续散列与比对没有意义。
  if (errors.length > 0) {
    return { errors, warnings, plan: { items, conflicts }, readyToMerge: false }
  }

  /* 2. 整包摘要 */
  const packageId = String(manifest!.packageId)
  const actualPackageHash = computePackageHash(pkg)
  if (actualPackageHash !== manifest!.packageHash) {
    errors.push('整包摘要校验失败：包内容与 packageHash 不符，包可能已损坏或被改动。')
  }

  /* 3. 逐件结构与 payloadHash */
  const all: Array<{ type: EvaluatedItem['type']; item: OfflineItem }> = [
    ...sheets.map((item) => ({ type: 'sheet' as const, item })),
    ...scans.map((item) => ({ type: 'scan' as const, item })),
    ...places.map((item) => ({ type: 'placePair' as const, item })),
  ]

  const seenKeys = new Map<string, string>()
  for (const { type, item } of all) {
    if (!isRecord(item)) {
      errors.push(`${type} 中存在不是对象的记录。`)
      continue
    }
    const where = `[${type}/${String(item.sourceKey ?? '?')}] `
    requireText(item, 'sourceKey', '来源标识', errors, where)
    requireText(item, 'baseHash', '基线散列', errors, where)

    const canonical = canonicalOfItem(item) as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(canonical)) {
      if (key === 'neighborCodes' || key === 'aliasList') {
        if (!Array.isArray(value)) {
          errors.push(`${where}${FIELD_LABELS[key] ?? key} 必须是数组。`)
        }
        continue
      }
      if (typeof value === 'string' && value.trim() === '' && key !== 'sheetSizeCm' && key !== 'coordNote') {
        errors.push(`${where}${FIELD_LABELS[key] ?? key}（${key}）不能为空。`)
      }
    }
    if (type === 'sheet' && (typeof canonical.year !== 'number' || Number.isNaN(canonical.year))) {
      errors.push(`${where}年代必须是数字。`)
    }
    if (type === 'scan') {
      if (typeof canonical.resolutionDpi !== 'number' || Number.isNaN(canonical.resolutionDpi)) {
        errors.push(`${where}分辨率必须是数字。`)
      }
      if (typeof canonical.pieces !== 'number' || Number.isNaN(canonical.pieces)) {
        errors.push(`${where}分块数必须是数字。`)
      }
    }

    const payloadHash = typeof item.payloadHash === 'string' ? item.payloadHash : ''
    const incomingHash = hashCanonical(canonical)
    if (payloadHash) {
      if (payloadHash !== incomingHash) {
        errors.push(`${where}记录散列校验失败：内容与 payloadHash 不符。`)
      }
    } else {
      // 旧版本打包工具可能未逐件附散列：整包摘要仍能兜住完整性。
      warnings.push(`${where}未携带 payloadHash，已按旧包规则仅用整包摘要校验。`)
    }

    const duplicate = seenKeys.get(`${type}:${item.sourceKey}`)
    if (duplicate !== undefined) {
      errors.push(`${where}sourceKey 在包内重复（与「${duplicate}」相同）。`)
    } else {
      seenKeys.set(`${type}:${item.sourceKey}`, itemLabel(type, canonical))
    }
  }

  // 包内图幅号必须唯一，否则扫描件/地名无法按图幅号挂接。
  const packageCodeToSheet = new Map<string, OfflineSheetItem>()
  for (const sheetItem of sheets) {
    const code = String(sheetItem.code ?? '')
    if (packageCodeToSheet.has(code)) {
      errors.push(`包内图幅号重复：${code}。`)
    }
    packageCodeToSheet.set(code, sheetItem)
  }

  /* 4. 与本地内容比对 */
  const localSheetByKey = new Map<string, LocalSheet>()
  const localScanByKey = new Map<string, LocalScan>()
  const localPlaceByKey = new Map<string, LocalPlace>()
  for (const sheet of input.localSheets) {
    if (sheet.sourceKey) {
      localSheetByKey.set(sheet.sourceKey, sheet)
    }
  }
  for (const scan of input.localScans) {
    if (scan.sourceKey) {
      localScanByKey.set(scan.sourceKey, scan)
    }
  }
  for (const pair of input.localPlaces) {
    if (pair.sourceKey) {
      localPlaceByKey.set(pair.sourceKey, pair)
    }
  }
  const localSheetByCode = new Map(input.localSheets.map((sheet) => [sheet.code, sheet]))
  const localCodeById = new Map(input.localSheets.map((sheet) => [sheet.id, sheet.code]))

  const savedById = new Map((input.savedConflicts ?? []).map((conflict) => [conflict.id, conflict]))

  function carryResolution(
    conflictId: string,
  ): ConflictResolution | undefined {
    const saved = savedById.get(conflictId)?.resolution
    return saved
  }

  function registerItem(evaluated: EvaluatedItem): void {
    items.push(evaluated)
  }

  // 4a. 图幅
  for (const item of sheets) {
    const canonical = canonicalSheet(item)
    const incomingHash = hashCanonical(canonical)
    const label = itemLabel('sheet', canonical as unknown as Record<string, unknown>)
    const base: EvaluatedItem = {
      type: 'sheet',
      sourceKey: item.sourceKey,
      label,
      sheetCode: canonical.code,
      baseHash: item.baseHash,
      incomingHash,
      payloadHashProvided: Boolean(item.payloadHash),
      action: 'create',
    }

    const byKey = localSheetByKey.get(item.sourceKey)
    const byCode = localSheetByCode.get(canonical.code)

    // 真正的撞号：包 sourceKey 与同号本地记录各自指向不同记录
    //（本地同号记录带有另一个外部 sourceKey）。本地记录无外部来源
    //（升级老数据以本地 id 回填血缘）时按图幅号对齐为同一记录，不算撞号。
    if (byKey && byCode && byKey.id !== byCode.id) {
      const localCanonical = canonicalOfLocalSheet(byCode)
      const localHash = hashCanonical(localCanonical)
      const conflictId = `${packageId}:sheet:${item.sourceKey}`
      const resolution = carryResolution(conflictId)
      const conflict: ConflictRecord = {
        id: conflictId,
        packageId,
        type: 'sheet',
        sourceKey: item.sourceKey,
        kind: 'code-collision',
        label,
        sheetCode: canonical.code,
        baseHash: item.baseHash,
        incomingHash,
        localId: byCode.id,
        localHash,
        fieldDiffs: diffFields(
          localCanonical as unknown as Record<string, unknown>,
          canonical as unknown as Record<string, unknown>,
        ),
        ...(resolution ? { resolution } : {}),
      }
      conflicts.push(conflict)
      registerItem({ ...base, action: 'conflict', localId: byCode.id, localHash, conflictId })
      continue
    }

    // 按 sourceKey 或图幅号对齐同一条本地记录（含无外部来源的升级老数据）。
    const matched = byKey ?? byCode

    if (!matched) {
      registerItem(base)
      continue
    }

    const localCanonical = canonicalOfLocalSheet(matched)
    const localHash = hashCanonical(localCanonical)
    if (localHash === incomingHash) {
      registerItem({ ...base, action: 'noop', localId: matched.id, localHash })
    } else if (localHash === item.baseHash) {
      registerItem({ ...base, action: 'update', localId: matched.id, localHash })
    } else {
      const conflictId = `${packageId}:sheet:${item.sourceKey}`
      const savedResolution = carryResolution(conflictId)
      const resolution =
        savedResolution && savedResolution.basedOnLocalHash === localHash ? savedResolution : undefined
      conflicts.push({
        id: conflictId,
        packageId,
        type: 'sheet',
        sourceKey: item.sourceKey,
        kind: 'content-mismatch',
        label,
        sheetCode: canonical.code,
        baseHash: item.baseHash,
        incomingHash,
        localId: matched.id,
        localHash,
        fieldDiffs: diffFields(
          localCanonical as unknown as Record<string, unknown>,
          canonical as unknown as Record<string, unknown>,
        ),
        ...(resolution ? { resolution } : {}),
      })
      registerItem({ ...base, action: 'conflict', localId: matched.id, localHash, conflictId })
    }
  }

  // 4b/4c. 扫描件与地名：按当时图幅号解析到本地图幅
  function resolveSheetCode(sheetCode: string): { sheetId?: string; inPackage: boolean; missing: boolean } {
    const packageSheet = packageCodeToSheet.get(sheetCode)
    if (packageSheet) {
      const local = localSheetByKey.get(packageSheet.sourceKey) ?? localSheetByCode.get(sheetCode)
      return { sheetId: local?.id, inPackage: true, missing: false }
    }
    const local = localSheetByCode.get(sheetCode)
    return local ? { sheetId: local.id, inPackage: false, missing: false } : { inPackage: false, missing: true }
  }

  function evaluateChild(
    type: 'scan' | 'placePair',
    item: OfflineScanItem | OfflinePlaceItem,
    canonical: CanonicalScan | CanonicalPlace,
    localByKey: Map<string, LocalScan> | Map<string, LocalPlace>,
    localCanonicalOf: (row: never, sheetCode: string) => Record<string, unknown>,
  ): void {
    const incomingHash = hashCanonical(canonical)
    const label = itemLabel(type, canonical as unknown as Record<string, unknown>)
    const resolved = resolveSheetCode(canonical.sheetCode)
    const base: EvaluatedItem = {
      type,
      sourceKey: item.sourceKey,
      label,
      sheetCode: canonical.sheetCode,
      baseHash: item.baseHash,
      incomingHash,
      payloadHashProvided: Boolean(item.payloadHash),
      action: 'create',
    }

    if (resolved.missing) {
      errors.push(
        `[${type}/${item.sourceKey}] 引用的图幅号「${canonical.sheetCode}」在包内与本地都不存在，无法关联。`,
      )
      registerItem({ ...base, action: 'unresolved-link' })
      return
    }

    const matched = localByKey.get(item.sourceKey)
    if (!matched) {
      registerItem(base)
      return
    }

    const localRow = matched as LocalScan | LocalPlace
    const ownerCode = localCodeById.get(localRow.sheetId) ?? canonical.sheetCode
    const localCanonical = localCanonicalOf(localRow as never, ownerCode)
    const localHash = hashCanonical(localCanonical)
    if (localHash === incomingHash) {
      registerItem({ ...base, action: 'noop', localId: localRow.id, localHash })
    } else if (localHash === item.baseHash) {
      registerItem({ ...base, action: 'update', localId: localRow.id, localHash })
    } else {
      const conflictId = `${packageId}:${type}:${item.sourceKey}`
      const savedResolution = carryResolution(conflictId)
      const resolution =
        savedResolution && savedResolution.basedOnLocalHash === localHash ? savedResolution : undefined
      conflicts.push({
        id: conflictId,
        packageId,
        type,
        sourceKey: item.sourceKey,
        kind: 'content-mismatch',
        label,
        sheetCode: canonical.sheetCode,
        baseHash: item.baseHash,
        incomingHash,
        localId: localRow.id,
        localHash,
        fieldDiffs: diffFields(localCanonical, canonical as unknown as Record<string, unknown>),
        ...(resolution ? { resolution } : {}),
      })
      registerItem({ ...base, action: 'conflict', localId: localRow.id, localHash, conflictId })
    }
  }

  for (const item of scans) {
    evaluateChild(
      'scan',
      item,
      canonicalScan(item),
      localScanByKey,
      canonicalOfLocalScan as unknown as (row: never, sheetCode: string) => Record<string, unknown>,
    )
  }
  for (const item of places) {
    evaluateChild(
      'placePair',
      item,
      canonicalPlace(item),
      localPlaceByKey,
      canonicalOfLocalPlace as unknown as (row: never, sheetCode: string) => Record<string, unknown>,
    )
  }

  const pendingConflicts = conflicts.filter((conflict) => !isConflictResolved(conflict))
  const readyToMerge = errors.length === 0 && pendingConflicts.length === 0
  return { errors, warnings, plan: { items, conflicts }, readyToMerge }
}

/* --------------------------------- 冲突裁定规则 --------------------------------- */

/** 内容冲突可「保留本地」或「采用包项」；图幅号撞号只允许「跳过该条」。 */
export function decisionAllowed(conflict: ConflictRecord, decision: ConflictDecision): boolean {
  if (conflict.kind === 'code-collision') {
    return decision === 'skip-item'
  }
  return decision === 'keep-local' || decision === 'take-package'
}

export function isConflictResolved(conflict: ConflictRecord): boolean {
  if (!conflict.resolution) {
    return false
  }
  if (!decisionAllowed(conflict, conflict.resolution.decision)) {
    return false
  }
  return conflict.resolution.basedOnLocalHash === conflict.localHash
}

/* --------------------------------- 整包写入计划 --------------------------------- */

export interface PlannedWrite {
  table: 'sheets' | 'scans' | 'placePairs'
  op: 'add' | 'put' | 'skip'
  key?: string
  row?: Record<string, unknown>
  mergedSourceKey: string
  hash: string
}

export interface BuildWritesContext {
  pkg: OfflinePackage
  plan: EvaluationPlan
  nextId: (kind: 'sheet' | 'scan' | 'placePair') => string
}

export interface BuildWritesResult {
  writes: PlannedWrite[]
  /** 采用主用扫描件时，需要先取消主用的同图幅既有扫描件 id。 */
  primaryDemotions: Array<{ sheetId: string; exceptScanId: string }>
}

export class PlanNotReadyError extends Error {}

export function buildWrites(ctx: BuildWritesContext): BuildWritesResult {
  const unresolved = ctx.plan.conflicts.filter((conflict) => !isConflictResolved(conflict))
  if (unresolved.length > 0) {
    throw new PlanNotReadyError('仍有冲突未补证处理，不能写入。')
  }

  const writes: PlannedWrite[] = []
  const conflictById = new Map(ctx.plan.conflicts.map((conflict) => [conflict.id, conflict]))
  const resolutionByKey = new Map(
    ctx.plan.conflicts.map((conflict) => [`${conflict.type}:${conflict.sourceKey}`, conflict]),
  )

  // 先为包内新图幅分配本地 id，供扫描件/地名挂接。
  const newSheetIdByKey = new Map<string, string>()
  for (const evaluated of ctx.plan.items) {
    if (evaluated.type === 'sheet' && evaluated.action === 'create') {
      newSheetIdByKey.set(evaluated.sourceKey, ctx.nextId('sheet'))
    }
  }

  const packageSheetByCode = new Map(ctx.pkg.sheets.map((item) => [item.code, item]))
  const localSheetIdByCode = new Map<string, string>()

  function sheetIdForCode(code: string): string | undefined {
    const packageSheet = packageSheetByCode.get(code)
    if (packageSheet) {
      const created = newSheetIdByKey.get(packageSheet.sourceKey)
      if (created) {
        return created
      }
      const evaluated = ctx.plan.items.find(
        (item) => item.type === 'sheet' && item.sourceKey === packageSheet.sourceKey,
      )
      return evaluated?.localId
    }
    return localSheetIdByCode.get(code)
  }

  for (const evaluated of ctx.plan.items) {
    if (evaluated.type === 'sheet') {
      const item = ctx.pkg.sheets.find((sheet) => sheet.sourceKey === evaluated.sourceKey)
      if (!item) {
        continue
      }
      if (evaluated.action === 'create') {
        const id = newSheetIdByKey.get(item.sourceKey) as string
        localSheetIdByCode.set(item.code, id)
        writes.push({
          table: 'sheets',
          op: 'add',
          key: id,
          row: { ...canonicalSheet(item), id, sourceKey: item.sourceKey },
          mergedSourceKey: item.sourceKey,
          hash: evaluated.incomingHash,
        })
      } else if (evaluated.action === 'update') {
        localSheetIdByCode.set(item.code, evaluated.localId as string)
        writes.push({
          table: 'sheets',
          op: 'put',
          key: evaluated.localId,
          row: { ...canonicalSheet(item), id: evaluated.localId, sourceKey: item.sourceKey },
          mergedSourceKey: item.sourceKey,
          hash: evaluated.incomingHash,
        })
      } else if (evaluated.action === 'conflict') {
        const conflict = conflictById.get(evaluated.conflictId as string)
        const decision = conflict?.resolution?.decision
        if (decision === 'take-package') {
          writes.push({
            table: 'sheets',
            op: 'put',
            key: evaluated.localId,
            row: { ...canonicalSheet(item), id: evaluated.localId, sourceKey: item.sourceKey },
            mergedSourceKey: item.sourceKey,
            hash: evaluated.incomingHash,
          })
        } else {
          writes.push({ table: 'sheets', op: 'skip', key: evaluated.localId, mergedSourceKey: item.sourceKey, hash: evaluated.localHash ?? '' })
        }
      }
      continue
    }

    if (evaluated.type === 'scan') {
      const item = ctx.pkg.scans.find((scan) => scan.sourceKey === evaluated.sourceKey)
      if (!item) {
        continue
      }
      const canonical = canonicalScan(item)
      const sheetId = sheetIdForCode(canonical.sheetCode)
      if (!sheetId) {
        throw new PlanNotReadyError(`扫描件 ${item.sourceKey} 无法解析图幅号 ${canonical.sheetCode}`)
      }
      const row = { ...canonical, sheetId, sourceKey: item.sourceKey }
      delete (row as Partial<CanonicalScan>).sheetCode

      if (evaluated.action === 'create') {
        const id = ctx.nextId('scan')
        writes.push({
          table: 'scans',
          op: 'add',
          key: id,
          row: { ...row, id },
          mergedSourceKey: item.sourceKey,
          hash: evaluated.incomingHash,
        })
      } else if (evaluated.action === 'update') {
        writes.push({
          table: 'scans',
          op: 'put',
          key: evaluated.localId,
          row: { ...row, id: evaluated.localId },
          mergedSourceKey: item.sourceKey,
          hash: evaluated.incomingHash,
        })
      } else if (evaluated.action === 'conflict') {
        const decision = resolutionByKey.get(`scan:${item.sourceKey}`)?.resolution?.decision
        if (decision === 'take-package') {
          writes.push({
            table: 'scans',
            op: 'put',
            key: evaluated.localId,
            row: { ...row, id: evaluated.localId },
            mergedSourceKey: item.sourceKey,
            hash: evaluated.incomingHash,
          })
        } else {
          writes.push({ table: 'scans', op: 'skip', key: evaluated.localId, mergedSourceKey: item.sourceKey, hash: evaluated.localHash ?? '' })
        }
      }
      continue
    }

    const item = ctx.pkg.placePairs.find((pair) => pair.sourceKey === evaluated.sourceKey)
    if (!item) {
      continue
    }
    const canonical = canonicalPlace(item)
    const sheetId = sheetIdForCode(canonical.sheetCode)
    if (!sheetId) {
      throw new PlanNotReadyError(`地名对照 ${item.sourceKey} 无法解析图幅号 ${canonical.sheetCode}`)
    }
    const row = { ...canonical, sheetId, sourceKey: item.sourceKey }
    delete (row as Partial<CanonicalPlace>).sheetCode

    if (evaluated.action === 'create') {
      const id = ctx.nextId('placePair')
      writes.push({
        table: 'placePairs',
        op: 'add',
        key: id,
        row: { ...row, id },
        mergedSourceKey: item.sourceKey,
        hash: evaluated.incomingHash,
      })
    } else if (evaluated.action === 'update') {
      writes.push({
        table: 'placePairs',
        op: 'put',
        key: evaluated.localId,
        row: { ...row, id: evaluated.localId },
        mergedSourceKey: item.sourceKey,
        hash: evaluated.incomingHash,
      })
    } else if (evaluated.action === 'conflict') {
      const decision = resolutionByKey.get(`placePair:${item.sourceKey}`)?.resolution?.decision
      if (decision === 'take-package') {
        writes.push({
          table: 'placePairs',
          op: 'put',
          key: evaluated.localId,
          row: { ...row, id: evaluated.localId },
          mergedSourceKey: item.sourceKey,
          hash: evaluated.incomingHash,
        })
      } else {
        writes.push({ table: 'placePairs', op: 'skip', key: evaluated.localId, mergedSourceKey: item.sourceKey, hash: evaluated.localHash ?? '' })
      }
    }
  }

  // 主用件：写入的扫描件若标记主用，同图幅其余扫描件取消主用（包外的也算）。
  const primaryDemotions: BuildWritesResult['primaryDemotions'] = []
  const newPrimaryBySheet = new Map<string, string>()
  for (const write of writes) {
    if (write.table === 'scans' && write.op !== 'skip' && write.row?.isPrimary === true) {
      newPrimaryBySheet.set(String(write.row.sheetId), String(write.key))
    }
  }
  for (const [sheetId, exceptScanId] of newPrimaryBySheet) {
    primaryDemotions.push({ sheetId, exceptScanId })
  }

  return { writes, primaryDemotions }
}
