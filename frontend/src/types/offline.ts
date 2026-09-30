/**
 * 离线校勘包的数据结构。协作馆断网时带包来，包内图幅、扫描件、地名对照
 * 各自带 sourceKey 与 baseHash，并以打包当时的图幅号关联。
 *
 * 包文件为单个 JSON，顶层是包信封，items 内的每条记录都带：
 * - sourceKey：来源馆给出的稳定标识，与本地内容按它对齐；
 * - baseHash：打包时该来源内容的散列，用于判断本地是否在其后改过。
 */

export const OFFLINE_PACKAGE_KIND = 'gboldmap-offline-correction'
export const OFFLINE_PACKAGE_FORMAT = 1

export type OfflineItemType = 'sheet' | 'scan' | 'placePair'

/** 图幅记录在包内的规范字段（散列只覆盖业务字段，不含内部 id）。 */
export interface OfflineSheetItem {
  sourceKey: string
  baseHash: string
  payloadHash?: string
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

export interface OfflineScanItem {
  sourceKey: string
  baseHash: string
  payloadHash?: string
  /** 打包当时所属图幅的图幅号，扫描件据此关联到本地图幅。 */
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

export interface OfflinePlaceItem {
  sourceKey: string
  baseHash: string
  payloadHash?: string
  /** 打包当时所属图幅的图幅号，地名对照据此关联到本地图幅。 */
  sheetCode: string
  oldName: string
  newName: string
  aliasList: string[]
  placeType: string
  coordNote: string
  certainty: string
}

export type OfflineItem = OfflineSheetItem | OfflineScanItem | OfflinePlaceItem

export interface OfflinePackageManifest {
  packageId: string
  origin: string
  preparedAt: string
  note?: string
  counts: {
    sheets: number
    scans: number
    placePairs: number
  }
  /** 不含 packageHash 自身的包摘要散列。 */
  packageHash: string
}

export interface OfflinePackage {
  kind: string
  format: number
  manifest: OfflinePackageManifest
  sheets: OfflineSheetItem[]
  scans: OfflineScanItem[]
  placePairs: OfflinePlaceItem[]
}

export function packageItems(pkg: OfflinePackage): OfflineItem[] {
  return [...pkg.sheets, ...pkg.scans, ...pkg.placePairs]
}

export function itemTypeOf(item: OfflineItem): OfflineItemType {
  return 'code' in item ? 'sheet' : 'sheetCode' in item && 'fileName' in item ? 'scan' : 'placePair'
}
