export type ColorMode = '彩色' | '黑白' | '灰度'
export type ScanQuality = '清晰' | '偏淡' | '破损'

export interface ScanItem {
  id: string
  /** 跨馆稳定身份，说明同 Sheet.sourceKey。 */
  sourceKey?: string
  sheetId: string
  fileName: string
  resolutionDpi: number
  colorMode: ColorMode
  pieces: number
  quality: ScanQuality
  storageNote: string
  importedAt: string
  isPrimary: boolean
}

export const COLOR_MODES: ColorMode[] = ['彩色', '黑白', '灰度']
export const SCAN_QUALITIES: ScanQuality[] = ['清晰', '偏淡', '破损']
