import type { PlacePair } from '../types/placePair'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import { CERTAINTIES, PLACE_TYPES } from '../types/placePair'
import { COLOR_MODES, SCAN_QUALITIES } from '../types/scan'
import { SHEET_SCALES, SHEET_STATUSES } from '../types/sheet'
import type {
  ConflictType,
  CorrectionItem,
  CorrectionPack,
  PackageState,
  PlacePayload,
  ScanPayload,
  SheetPayload,
  SyncConflict,
  SyncKind,
} from '../types/sync'
import { sha256Text } from './sha256'

/** 当前应用支持的校勘包格式版本。 */
export const SUPPORTED_FORMAT_VERSION = 1

/**
 * 旧版格式迁移表。应用升级后仍须能读旧包：解析时按版本顺序执行迁移，
 * 把旧包投影到当前格式后再走同一套校验 / 合并流程。
 * 目前只有版本 1（基线），后续升版在此追加迁移函数。
 */
const MIGRATIONS: Record<number, (raw: unknown) => unknown> = {}

/** 图幅卡参与比对的业务字段投影（不含 id / sourceKey 等技术字段）。 */
export function projectSheet(sheet: Sheet): SheetPayload {
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

/** 扫描件投影；sheetCode 按其所属图幅的当前图幅号解析。 */
export function projectScan(scan: ScanItem, sheetCode: string | null): ScanPayload {
  return {
    sheetCode: sheetCode ?? '',
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

/** 地名对照投影；sheetCode 按其所属图幅的当前图幅号解析。 */
export function projectPlace(pair: PlacePair, sheetCode: string | null): PlacePayload {
  return {
    sheetCode: sheetCode ?? '',
    oldName: pair.oldName,
    newName: pair.newName,
    aliasList: [...pair.aliasList],
    placeType: pair.placeType,
    coordNote: pair.coordNote,
    certainty: pair.certainty,
  }
}

/** 递归按键排序后再 JSON 序列化，保证两端字段顺序不同时哈希仍一致。 */
function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(normalize)
    }
    if (input !== null && typeof input === 'object') {
      const source = input as Record<string, unknown>
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(source).sort()) {
        const child = source[key]
        result[key] = child === undefined ? null : normalize(child)
      }
      return result
    }
    return input ?? null
  }
  return JSON.stringify(normalize(value))
}

export function hashContent(value: unknown): string {
  return sha256Text(canonical(value))
}

/** 包内条目带去的内容哈希（对负载规范化后求摘要）。 */
export function itemContentHash(item: CorrectionItem): string {
  return hashContent(item.payload)
}

/**
 * 整包校验和：只覆盖格式版本、包号与全部条目（含 kind/sourceKey/baseHash/负载），
 * 不含 label / origin / packedAt / checksum 本身等说明性字段。
 */
export function computePackChecksum(pack: CorrectionPack): string {
  return hashContent({
    formatVersion: pack.formatVersion,
    packageId: pack.packageId,
    items: pack.items.map((item) => ({
      kind: item.kind,
      sourceKey: item.sourceKey,
      baseHash: item.baseHash,
      payload: item.payload,
    })),
  })
}

export class PackValidationError extends Error {}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (!isString(value) || !value.trim()) {
    throw new PackValidationError(`缺少必填文本字段：${key}`)
  }
  return value
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(isString)) {
    throw new PackValidationError(`${label} 必须是字符串数组`)
  }
  return [...value]
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (!isString(value) || !allowed.includes(value as T)) {
    throw new PackValidationError(`${label} 取值不被支持：${String(value)}`)
  }
  return value as T
}

function parsePayload(kind: SyncKind, raw: unknown): SheetPayload | ScanPayload | PlacePayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PackValidationError('条目负载必须是对象')
  }
  const data = raw as Record<string, unknown>

  if (kind === 'sheet') {
    const year = data.year
    if (typeof year !== 'number' || !Number.isFinite(year)) {
      throw new PackValidationError('图幅年代必须是数字')
    }
    return {
      code: requireString(data, 'code'),
      title: requireString(data, 'title'),
      year,
      scale: enumValue(data.scale, SHEET_SCALES, '比例尺'),
      projection: requireString(data, 'projection'),
      sheetSizeCm: isString(data.sheetSizeCm) ? data.sheetSizeCm : '',
      series: isString(data.series) ? data.series : '',
      neighborCodes: requireStringArray(data.neighborCodes ?? [], '邻接图号'),
      status: enumValue(data.status, SHEET_STATUSES, '整理状态'),
    }
  }

  if (kind === 'scan') {
    const numeric = (key: string): number => {
      const value = data[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new PackValidationError(`扫描件字段 ${key} 必须是数字`)
      }
      return value
    }
    return {
      sheetCode: requireString(data, 'sheetCode'),
      fileName: requireString(data, 'fileName'),
      resolutionDpi: numeric('resolutionDpi'),
      colorMode: enumValue(data.colorMode, COLOR_MODES, '色彩模式'),
      pieces: numeric('pieces'),
      quality: enumValue(data.quality, SCAN_QUALITIES, '图像质量'),
      storageNote: isString(data.storageNote) ? data.storageNote : '',
      importedAt: requireString(data, 'importedAt'),
      isPrimary: data.isPrimary === true,
    }
  }

  return {
    sheetCode: requireString(data, 'sheetCode'),
    oldName: requireString(data, 'oldName'),
    newName: requireString(data, 'newName'),
    aliasList: requireStringArray(data.aliasList ?? [], '异写列表'),
    placeType: enumValue(data.placeType, PLACE_TYPES, '地名类型'),
    coordNote: isString(data.coordNote) ? data.coordNote : '',
    certainty: enumValue(data.certainty, CERTAINTIES, '确定度'),
  }
}

/**
 * 解析校勘包文本：JSON 解析、结构与枚举校验、旧格式迁移。
 * 不负责校验和（那是独立的完整性闸门）。
 */
export function parseCorrectionPack(rawText: string): CorrectionPack {
  let raw: unknown
  try {
    raw = JSON.parse(rawText)
  } catch {
    throw new PackValidationError('不是合法的 JSON 文件，无法读取校勘包')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PackValidationError('校勘包顶层结构应为对象')
  }

  let working = raw as Record<string, unknown>
  const formatVersion = working.formatVersion
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new PackValidationError('校勘包格式版本缺失或不合法')
  }
  if (formatVersion > SUPPORTED_FORMAT_VERSION) {
    throw new PackValidationError(
      `校勘包格式为 v${formatVersion}，高于当前应用支持的 v${SUPPORTED_FORMAT_VERSION}，请先升级编目台`,
    )
  }
  // 应用升级后读取旧包：逐版本迁移到当前格式。
  for (let version = formatVersion; version < SUPPORTED_FORMAT_VERSION; version += 1) {
    const migrate = MIGRATIONS[version]
    if (!migrate) {
      throw new PackValidationError(`缺少 v${version} 校勘包的迁移路径`)
    }
    const migrated = migrate(working)
    if (!migrated || typeof migrated !== 'object') {
      throw new PackValidationError(`v${version} 校勘包迁移结果不合法`)
    }
    working = migrated as Record<string, unknown>
  }

  const packageId = requireString(working, 'packageId')
  const label = requireString(working, 'label')
  const origin = isString(working.origin) ? working.origin : ''
  const packedAt = requireString(working, 'packedAt')
  const rawItems = working.items
  if (!Array.isArray(rawItems)) {
    throw new PackValidationError('校勘包条目列表 items 缺失')
  }

  const seen = new Set<string>()
  const items: CorrectionItem[] = rawItems.map((rawItem, index) => {
    if (!rawItem || typeof raw !== 'object' || Array.isArray(rawItem)) {
      throw new PackValidationError(`第 ${index + 1} 条不是合法条目`)
    }
    const entry = rawItem as Record<string, unknown>
    const kind = enumValue(entry.kind, ['sheet', 'scan', 'place'] as const, `第 ${index + 1} 条类型`)
    const sourceKey = requireString(entry, 'sourceKey')
    const dedupeKey = `${kind}:${sourceKey}`
    if (seen.has(dedupeKey)) {
      throw new PackValidationError(`包内 ${dedupeKey} 出现重复，无法保证一一对应`)
    }
    seen.add(dedupeKey)
    const baseHash = entry.baseHash
    if (baseHash !== null && !isString(baseHash)) {
      throw new PackValidationError(`第 ${index + 1} 条 baseHash 必须是十六进制字符串或 null`)
    }
    return {
      kind,
      sourceKey,
      baseHash,
      payload: parsePayload(kind, entry.payload),
    } as CorrectionItem
  })

  for (const item of items) {
    if (item.kind !== 'sheet') {
      const code = (item.payload as ScanPayload | PlacePayload).sheetCode
      if (!code) {
        throw new PackValidationError(`条目 ${item.sourceKey} 缺少关联图幅号`)
      }
      // 引用的图幅号既可能在包内（本次新增的图幅），也可能本地已存在；
      // 是否闭合在冲突检测阶段判断，这里不做拦截。
    }
  }

  return {
    formatVersion,
    packageId,
    label,
    origin,
    packedAt,
    items,
    checksum: isString(working.checksum) ? working.checksum : undefined,
  }
}

export interface ChecksumResult {
  ok: boolean
  message: string
}

/** 整包完整性闸门：校验和缺失或不符一律不允许进入写入流程。 */
export function verifyChecksum(pack: CorrectionPack): ChecksumResult {
  if (!pack.checksum) {
    return { ok: false, message: '校勘包缺少整包校验和，来源不完整，已拦截' }
  }
  const expected = computePackChecksum(pack)
  if (expected !== pack.checksum) {
    return {
      ok: false,
      message: `整包校验未通过：校验和应为 ${expected.slice(0, 12)}…，与包内记录不符，原包可能损坏或被改动`,
    }
  }
  return { ok: true, message: '整包校验通过' }
}

/** 冲突在 syncConflicts 仓库使用的确定性主键，保证重新核验不会堆出重复冲突。 */
export function conflictId(packageId: string, kind: SyncKind, sourceKey: string): string {
  return `${packageId}:${kind}:${sourceKey}`
}

export function ledgerKey(packageId: string, kind: SyncKind, sourceKey: string): string {
  return `${packageId}:${kind}:${sourceKey}`
}

export interface PendingConflictSeed {
  id: string
  kind: SyncKind
  sourceKey: string
  type: ConflictType
  sheetCode: string
  item: CorrectionItem
  localSnapshot?: unknown
}

export type PlanMode =
  | 'add-sheet'
  | 'update-sheet'
  | 'add-scan'
  | 'update-scan'
  | 'add-place'
  | 'update-place'
  | 'skip'

export interface PlannedItem {
  item: CorrectionItem
  mode: PlanMode
  /** 更新模式下的本地记录 id。 */
  recordId?: string
  /** 子项最终归属的图幅号（关联冲突经补证绑定后可能不同于负载里的 sheetCode）。 */
  targetCode?: string
  /** 跳过原因（保留本地 / 已写入）。 */
  reason?: string
}

export interface DetectResult {
  pending: PendingConflictSeed[]
  plan: PlannedItem[]
  conflictCount: number
  addCount: number
  updateCount: number
  skipCount: number
}

interface LocalContext {
  sheets: Sheet[]
  scans: ScanItem[]
  places: PlacePair[]
  conflicts: SyncConflict[]
  appliedKeys: Set<string>
}

export const CONFLICT_LABELS: Record<ConflictType, string> = {
  content: '本地已有修订',
  'missing-base': '共同底本缺失',
  association: '图幅关联缺失',
  'code-collision': '图幅号冲突',
}

export const CONFLICT_DESCRIPTIONS: Record<ConflictType, string> = {
  content: '同 sourceKey 的本地内容与 baseHash 不一致，馆员后来改过，不能盖掉。',
  'missing-base': '包以更新方式带来该条（带 baseHash），但本地查无同一 sourceKey。',
  association: '按包内图幅号找不到图幅，需补证绑定到本地图幅后再继续。',
  'code-collision': '新图幅使用的图幅号已被另一条本地记录占用。',
}

export const PACKAGE_STATE_LABELS: Record<PackageState, string> = {
  received: '待核验',
  invalid: '校验未通过',
  conflicts: '有冲突待处理',
  ready: '可以写入',
  applying: '写入中',
  applied: '已合并',
  failed: '写入失败',
}

export const KIND_LABELS: Record<SyncKind, string> = {
  sheet: '图幅',
  scan: '扫描件',
  place: '地名对照',
}

/** 供 UI 展示条目的摘要标题。 */
export function itemTitle(item: CorrectionItem): string {
  switch (item.kind) {
    case 'sheet': {
      const payload = item.payload as SheetPayload
      return `${payload.code} · ${payload.title}`
    }
    case 'scan': {
      const payload = item.payload as ScanPayload
      return `扫描件 ${payload.fileName}（${payload.sheetCode}）`
    }
    case 'place': {
      const payload = item.payload as PlacePayload
      return `地名 ${payload.oldName} → ${payload.newName}（${payload.sheetCode}）`
    }
  }
}

/**
 * 冲突检测（无副作用的纯函数）：
 * - 同 sourceKey 本地内容哈希与 baseHash 不一致 → content（馆员后来改过，不得覆盖）；
 * - 包里带 baseHash 但本地查无 sourceKey → missing-base；
 * - 子项找不到图幅号 → association（补证时可绑定到本地图幅）；
 * - 新图幅号已被别的本地记录占用 → code-collision。
 *
 * 已处理冲突按馆员决定并入写入计划（保留本地 → skip）；已在台账中的条目直接
 * 跳过（重试同一包不会多出记录）。
 */
export function detectPlan(pack: CorrectionPack, context: LocalContext): DetectResult {
  const sheetByKey = new Map<string, Sheet>()
  const scanByKey = new Map<string, ScanItem>()
  const placeByKey = new Map<string, PlacePair>()
  for (const sheet of context.sheets) {
    if (sheet.sourceKey) {
      sheetByKey.set(sheet.sourceKey, sheet)
    }
  }
  for (const scan of context.scans) {
    if (scan.sourceKey) {
      scanByKey.set(scan.sourceKey, scan)
    }
  }
  for (const place of context.places) {
    if (place.sourceKey) {
      placeByKey.set(place.sourceKey, place)
    }
  }

  const sheetCodeById = new Map<string, string>()
  const sheetByCode = new Map<string, Sheet>()
  const localSheetCodes = new Set<string>()
  for (const sheet of context.sheets) {
    sheetCodeById.set(sheet.id, sheet.code)
    localSheetCodes.add(sheet.code)
    if (!sheetByCode.has(sheet.code)) {
      sheetByCode.set(sheet.code, sheet)
    }
  }
  // 同一包里本次将新增的图幅也算作子项的有效关联目标（按图幅号）。
  for (const item of pack.items) {
    if (item.kind === 'sheet') {
      const code = (item.payload as SheetPayload).code
      if (!sheetByCode.has(code)) {
        sheetByCode.set(code, {
          id: `__pack_sheet__:${item.sourceKey}`,
          sourceKey: item.sourceKey,
          ...(item.payload as SheetPayload),
        } as Sheet)
      }
    }
  }

  const priorDecision = new Map<string, SyncConflict>()
  for (const conflict of context.conflicts) {
    if (conflict.packageId === pack.packageId) {
      priorDecision.set(`${conflict.kind}:${conflict.sourceKey}`, conflict)
    }
  }

  const pending: PendingConflictSeed[] = []
  const plan: PlannedItem[] = []
  let addCount = 0
  let updateCount = 0
  let skipCount = 0

  const pushSkip = (item: CorrectionItem, reason: string): void => {
    plan.push({ item, mode: 'skip', reason })
    skipCount += 1
  }

  for (const item of pack.items) {
    const composite = ledgerKey(pack.packageId, item.kind, item.sourceKey)
    if (context.appliedKeys.has(composite)) {
      pushSkip(item, '该条目在上一次处理中已写入，重试自动跳过，不会重复记账')
      continue
    }

    const existing: Sheet | ScanItem | PlacePair | undefined =
      item.kind === 'sheet'
        ? sheetByKey.get(item.sourceKey)
        : item.kind === 'scan'
          ? scanByKey.get(item.sourceKey)
          : placeByKey.get(item.sourceKey)

    let natural: ConflictType | null = null
    let localSnapshot: unknown

    if (item.kind === 'sheet') {
      const payload = item.payload as SheetPayload
      if (existing) {
        const localHash = hashContent(projectSheet(existing as Sheet))
        if (item.baseHash === null || localHash !== item.baseHash) {
          natural = 'content'
          localSnapshot = projectSheet(existing as Sheet)
        }
      } else if (item.baseHash !== null) {
        natural = 'missing-base'
      } else if (localSheetCodes.has(payload.code)) {
        natural = 'code-collision'
        localSnapshot = projectSheet(sheetByCode.get(payload.code) as Sheet)
      }
    } else {
      const payload = item.payload as ScanPayload | PlacePayload
      const referencedSheet = sheetByCode.get(payload.sheetCode)
      if (existing) {
        const localCode = sheetCodeById.get((existing as ScanItem | PlacePair).sheetId) ?? null
        const localHash =
          item.kind === 'scan'
            ? hashContent(projectScan(existing as ScanItem, localCode))
            : hashContent(projectPlace(existing as PlacePair, localCode))
        if (item.baseHash === null || localHash !== item.baseHash) {
          natural = 'content'
          localSnapshot =
            item.kind === 'scan'
              ? projectScan(existing as ScanItem, localCode)
              : projectPlace(existing as PlacePair, localCode)
        } else if (!referencedSheet) {
          natural = 'association'
        }
      } else if (!referencedSheet) {
        // 关联图幅缺失优先挂关联冲突：可在待处理区绑定本地图幅；
        // 图幅可解析但底本缺失才归为 missing-base，可直接采用馆方条目新建。
        natural = 'association'
      } else if (item.baseHash !== null) {
        natural = 'missing-base'
      }
    }

    const decisionKey = `${item.kind}:${item.sourceKey}`
    const decision = priorDecision.get(decisionKey)
    const sheetCode =
      item.kind === 'sheet'
        ? (item.payload as SheetPayload).code
        : (item.payload as ScanPayload | PlacePayload).sheetCode

    if (natural) {
      const seed: PendingConflictSeed = {
        id: conflictId(pack.packageId, item.kind, item.sourceKey),
        kind: item.kind,
        sourceKey: item.sourceKey,
        type: natural,
        sheetCode,
        item,
        localSnapshot,
      }

      if (decision?.status === 'resolved') {
        const adjudicated = adjudicate(natural, item, decision, sheetByCode)
        if (adjudicated === 'keep') {
          pushSkip(item, '馆员已补证：保留本地，不采用馆方条目')
          continue
        }
        if (adjudicated) {
          // 补证仍成立（采用馆方 / 绑定图幅有效），并入写入计划。
          const targetCode =
            item.kind === 'sheet'
              ? undefined
              : (adjudicated as { targetCode?: string }).targetCode ?? sheetCode
          const mode = writeMode(item.kind, Boolean(existing))
          plan.push({ item, mode, recordId: existing?.id, targetCode })
          if (existing) {
            updateCount += 1
          } else {
            addCount += 1
          }
          continue
        }
        // 补证已不成立（例如绑定的图幅又被删除），冲突重新挂起。
      }

      pending.push(seed)
      continue
    }

    // 无自然冲突时，历史遗留的“已处理”记录直接忽略，按常规并入。
    const mode = writeMode(item.kind, Boolean(existing))
    const targetCode =
      item.kind === 'sheet' ? undefined : (item.payload as ScanPayload | PlacePayload).sheetCode
    plan.push({ item, mode, recordId: existing?.id, targetCode })
    if (existing) {
      updateCount += 1
    } else {
      addCount += 1
    }
  }

  return {
    pending,
    plan,
    conflictCount: pending.length,
    addCount,
    updateCount,
    skipCount,
  }
}

type Adjudication = 'keep' | { targetCode?: string } | null

/**
 * 馆员补证决定在当前数据状态下是否仍然成立：
 * - content / missing-base：take 采用馆方，keep/skip 保留本地；
 * - association：bind 且绑定目标图幅仍存在才成立；
 * - code-collision：只能保留本地（图幅号占用无法安全采用）。
 */
function adjudicate(
  type: ConflictType,
  item: CorrectionItem,
  decision: SyncConflict,
  sheetByCode: Map<string, Sheet>,
): Adjudication {
  switch (type) {
    case 'content':
    case 'missing-base': {
      if (decision.resolution === 'keep' || decision.resolution === 'skip') {
        return 'keep'
      }
      if (decision.resolution === 'take') {
        return item.kind === 'sheet'
          ? {}
          : { targetCode: (item.payload as ScanPayload | PlacePayload).sheetCode }
      }
      return null
    }
    case 'association': {
      if (decision.resolution === 'bind' && decision.bindToCode && sheetByCode.has(decision.bindToCode)) {
        return { targetCode: decision.bindToCode }
      }
      if (decision.resolution === 'keep' || decision.resolution === 'skip') {
        return 'keep'
      }
      return null
    }
    case 'code-collision':
      return 'keep'
  }
}

function writeMode(kind: SyncKind, exists: boolean): PlanMode {
  if (kind === 'sheet') {
    return exists ? 'update-sheet' : 'add-sheet'
  }
  if (kind === 'scan') {
    return exists ? 'update-scan' : 'add-scan'
  }
  return exists ? 'update-place' : 'add-place'
}
