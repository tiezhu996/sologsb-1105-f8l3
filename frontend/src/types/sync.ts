import type { PlacePair } from './placePair'
import type { ScanItem } from './scan'
import type { Sheet } from './sheet'

/**
 * 离线校勘包（协作馆断网时随 U 盘 / 内网摆渡带来的数据包）。
 *
 * 每条记录都带 sourceKey 与 baseHash：
 * - sourceKey：两馆之间稳定的内容身份，写入本地记录后永久保留，用于识别“同一条”；
 * - baseHash：打包那一刻、对方所基于的共同底本内容哈希。本地同 sourceKey 记录的
 *   当前哈希与之不一致，说明馆员后来改过本地内容，列为冲突，绝不静默覆盖。
 *
 * 扫描件与地名对照不直接存本地 sheetId，而是按“当时的图幅号” sheetCode 关联。
 */

export type SyncKind = 'sheet' | 'scan' | 'place'

/** 图幅负载：即图幅卡上参与比对的业务字段（不含 id / sourceKey 等技术字段）。 */
export interface SheetPayload {
  code: string
  title: string
  year: number
  scale: Sheet['scale']
  projection: string
  sheetSizeCm: string
  series: string
  neighborCodes: string[]
  status: Sheet['status']
}

/** 扫描件负载：sheetCode 为打包时该件所属图幅的图幅号。 */
export interface ScanPayload {
  sheetCode: string
  fileName: string
  resolutionDpi: number
  colorMode: ScanItem['colorMode']
  pieces: number
  quality: ScanItem['quality']
  storageNote: string
  importedAt: string
  isPrimary: boolean
}

/** 地名对照负载：sheetCode 为打包时该条所属图幅的图幅号。 */
export interface PlacePayload {
  sheetCode: string
  oldName: string
  newName: string
  aliasList: string[]
  placeType: PlacePair['placeType']
  coordNote: string
  certainty: PlacePair['certainty']
}

export type SyncPayload = SheetPayload | ScanPayload | PlacePayload

export interface CorrectionItem<K extends SyncKind = SyncKind> {
  kind: K
  sourceKey: string
  /** 共同底本的内容哈希；新增条目（对方新建）为 null。 */
  baseHash: string | null
  payload: K extends 'sheet'
    ? SheetPayload
    : K extends 'scan'
      ? ScanPayload
      : PlacePayload
}

export interface CorrectionPack {
  /** 包格式版本，供数据升级后读取旧包。 */
  formatVersion: number
  packageId: string
  label: string
  origin: string
  packedAt: string
  items: CorrectionItem[]
  /**
   * 整包校验和：对“剔除 checksum 字段后的清单 + 条目内容投影”规范化后求哈希。
   * 旧版包（formatVersion 更早）可能没有该字段，会降级为逐条校验并提示。
   */
  checksum?: string
}

/** 冲突种类。 */
export type ConflictType =
  | 'content' // 本地同 sourceKey 内容与 baseHash 不一致：馆员后来改过
  | 'missing-base' // 包里带 baseHash，但本地已无该 sourceKey：底本缺失
  | 'association' // 扫描件 / 地名找不到图幅号对应的图幅
  | 'code-collision' // 新图幅的图幅号已被另一条本地记录占用

export type ConflictResolution = 'keep' | 'take' | 'bind' | 'skip'

export type ConflictStatus = 'pending' | 'resolved'

/** 待处理区里的一条冲突（持久化在 IndexedDB 的 syncConflicts 仓库）。 */
export interface SyncConflict {
  id: string
  packageId: string
  kind: SyncKind
  sourceKey: string
  type: ConflictType
  status: ConflictStatus
  /** 涉及的图幅号（图幅项为其自身 code，子项为其 sheetCode）。 */
  sheetCode: string
  /** 包内条目快照（完整保留，补证后继续合并仍以它为准）。 */
  item: CorrectionItem
  /** 检测冲突时本地记录的内容投影快照，用于并列展示。 */
  localSnapshot?: unknown
  /** 馆员补证后的处理决定。 */
  resolution?: ConflictResolution
  /** bind：手工指定的图幅 code；其他决定下为空。 */
  bindToCode?: string
  /** 处理说明，离开页面再回来仍在。 */
  note?: string
  resolvedAt?: string
  createdAt: string
  updatedAt: string
}

/** 校勘包处理状态。 */
export type PackageState =
  | 'received' // 已登记原包，尚未完成校验
  | 'invalid' // 整包校验未通过（损坏 / 篡改）
  | 'conflicts' // 校验通过，存在待处理冲突
  | 'ready' // 校验通过且无冲突，等待馆员触发整包写入
  | 'applying' // 写入中（中途失败会回滚到本态之前的可重试状态）
  | 'applied' // 已全部写入
  | 'failed' // 写入中途失败，原包与进度保留，可重试

export interface SyncPackageRecord {
  packageId: string
  label: string
  origin: string
  packedAt: string
  state: PackageState
  /** 原始包文本，整包保留，随时可重新解析与重试。 */
  rawText: string
  /** 解析后的整包，校验通过后才有。 */
  pack?: CorrectionPack
  /** 校验 / 处理过程中的说明信息（含降级提示、错误原因）。 */
  message?: string
  /** 已写入条目的复合键 `kind:sourceKey`，用于断点续作与防重。 */
  appliedItems: string[]
  createdAt: string
  updatedAt: string
}

/** 幂等台账：每写入一个条目登记一行，重试同一包不会多出记录。 */
export interface SyncLedgerEntry {
  /** 复合主键 `${packageId}:${kind}:${sourceKey}`。 */
  key: string
  packageId: string
  kind: SyncKind
  sourceKey: string
  /** 实际落到业务表的记录 id。 */
  recordId: string
  appliedAt: string
}
