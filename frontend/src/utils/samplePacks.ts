import type { CorrectionItem, CorrectionPack, PlacePayload, ScanPayload, SheetPayload } from '../types/sync'
import { db } from './db'
import {
  computePackChecksum,
  hashContent,
  projectPlace,
  projectScan,
  projectSheet,
} from './syncMerge'

/** 组装校勘包并计算整包校验和（打 / 收两端使用同一套规范）。 */
export function buildCorrectionPack(input: {
  packageId: string
  label: string
  origin: string
  packedAt: string
  items: CorrectionItem[]
}): CorrectionPack {
  const pack: CorrectionPack = {
    formatVersion: 1,
    packageId: input.packageId,
    label: input.label,
    origin: input.origin,
    packedAt: input.packedAt,
    items: input.items,
  }
  return { ...pack, checksum: computePackChecksum(pack) }
}

/** 以本地某条图幅当前内容为“共同底本”，计算 baseHash 并给出一条更新项。 */
export function sheetUpdateItem(sourceKey: string, payload: SheetPayload): CorrectionItem {
  return { kind: 'sheet', sourceKey, baseHash: hashContent(payload), payload }
}

export function scanUpdateItem(sourceKey: string, payload: ScanPayload): CorrectionItem {
  return { kind: 'scan', sourceKey, baseHash: hashContent(payload), payload }
}

export function placeUpdateItem(sourceKey: string, payload: PlacePayload): CorrectionItem {
  return { kind: 'place', sourceKey, baseHash: hashContent(payload), payload }
}

export interface SamplePackFile {
  fileName: string
  rawText: string
  description: string
}

function fileOf(pack: CorrectionPack, description: string): SamplePackFile {
  return {
    fileName: `${pack.packageId}.json`,
    rawText: JSON.stringify(pack, null, 2),
    description,
  }
}

/**
 * 生成离线校勘流程演示用的样例包（内容读取自本地库，故 baseHash 与实际底本吻合）：
 * 1. 张北图幅新包：一幅新图幅 + 两件扫描件 + 两条地名，整包无冲突；
 * 2. 补遗包：含本地修订冲突、底本缺失、图幅关联缺失、图幅号占用四种冲突；
 * 3. 损坏包：内容被改动但校验和未重算，整包校验应拦截；
 * 4. 与新包字节相同的副本，用于验证同一包重复 / 重试不会多出记录。
 */
export async function buildSamplePackFiles(): Promise<SamplePackFile[]> {
  const [sheets, scans, places] = await Promise.all([
    db.sheets.toArray(),
    db.scans.toArray(),
    db.placePairs.toArray(),
  ])
  const sheetCodeById = new Map(sheets.map((sheet) => [sheet.id, sheet.code]))

  const jia3 = sheets.find((sheet) => sheet.code === '北平-甲-3')
  const jia3Scan = scans.find((scan) => scan.fileName === '北平甲3_蓝图复照.jpg')
  const jia3Place = places.find((pair) => pair.oldName === '崇文门大街')
  if (!jia3 || !jia3Scan || !jia3Place) {
    throw new Error('本地种子数据不完整，无法生成样例包')
  }
  const jia3ScanCode = sheetCodeById.get(jia3Scan.sheetId) ?? jia3.code

  const stamp = new Date().toISOString()

  // 包一：全新图幅，无冲突。
  const cleanSheet: SheetPayload = {
    code: '张家口-北-1',
    title: '张家口堡至大境门边图',
    year: 1931,
    scale: '1:50000',
    projection: '多圆锥投影',
    sheetSizeCm: '54 × 46 厘米',
    series: '察哈尔实测图',
    neighborCodes: ['张家口-北-2'],
    status: '待编',
  }
  const cleanScanA: ScanPayload = {
    sheetCode: '张家口-北-1',
    fileName: '张北1_晒蓝原图_600dpi.tif',
    resolutionDpi: 600,
    colorMode: '彩色',
    pieces: 4,
    quality: '清晰',
    storageNote: '协作馆地图专柜 C-1931-01',
    importedAt: '2026-09-20T08:00:00.000Z',
    isPrimary: true,
  }
  const cleanScanB: ScanPayload = {
    sheetCode: '张家口-北-1',
    fileName: '张北1_缩微副本.tif',
    resolutionDpi: 400,
    colorMode: '黑白',
    pieces: 3,
    quality: '偏淡',
    storageNote: '协作馆缩微柜 M-08',
    importedAt: '2026-09-21T08:00:00.000Z',
    isPrimary: false,
  }
  const cleanPlaceA: PlacePayload = {
    sheetCode: '张家口-北-1',
    oldName: '来远堡',
    newName: '张家口堡',
    aliasList: ['下堡', '张家口堡城'],
    placeType: '衙署',
    coordNote: '图幅南缘清水河西岸',
    certainty: '确定',
  }
  const cleanPlaceB: PlacePayload = {
    sheetCode: '张家口-北-1',
    oldName: '大境门马市',
    newName: '大境门市场遗址',
    aliasList: ['马市口', '蒙汉互市'],
    placeType: '村镇',
    coordNote: '图幅北部长城口门内侧',
    certainty: '存疑',
  }

  const cleanPack = buildCorrectionPack({
    packageId: 'pack-demo-zhangbei-clean',
    label: '张北图幅新包（协作馆离线校勘）',
    origin: '察哈尔文献协作馆',
    packedAt: stamp,
    items: [
      { kind: 'sheet', sourceKey: 'xgz-sheet-zb-1', baseHash: null, payload: cleanSheet },
      { kind: 'scan', sourceKey: 'xgz-scan-zb-1-a', baseHash: null, payload: cleanScanA },
      { kind: 'scan', sourceKey: 'xgz-scan-zb-1-b', baseHash: null, payload: cleanScanB },
      { kind: 'place', sourceKey: 'xgz-place-zb-1-a', baseHash: null, payload: cleanPlaceA },
      { kind: 'place', sourceKey: 'xgz-place-zb-1-b', baseHash: null, payload: cleanPlaceB },
    ],
  })

  // 包二：四种冲突。
  // 1) 图幅内容冲突：baseHash 是打包时对方所基于的共同底本（此处以本地题名改动前
  //    的投影模拟），而本地当前内容已与之不同 → 馆员后来改过，不能盖掉。
  const jia3Base: SheetPayload = { ...projectSheet(jia3), title: '正阳门至崇文门街巷图（协勘底本）' }
  const jia3Remote: SheetPayload = { ...projectSheet(jia3), status: '待核', title: '正阳门至崇文门街巷详图' }
  // 2) 扫描件底本缺失：baseHash 指向一个本地没有的 sourceKey。
  const missingScan: ScanPayload = {
    ...projectScan(jia3Scan, jia3ScanCode),
    fileName: '北平甲3_协作馆补描本_600dpi.tif',
    quality: '清晰',
  }
  // 3) 地名图幅关联缺失：引用本地不存在的图幅号。
  const orphanPlace: PlacePayload = {
    sheetCode: '承德-南-3',
    oldName: '热河道署',
    newName: '承德市行政中心旧址',
    aliasList: ['热河都统署'],
    placeType: '衙署',
    coordNote: '图幅中部武烈河西岸',
    certainty: '待考',
  }
  // 4) 图幅号占用：新图幅（baseHash 为 null）使用了已在本地的图幅号。
  const collisionSheet: SheetPayload = {
    code: jia3.code,
    title: '协作馆藏同名图幅异本',
    year: 1907,
    scale: '1:5000',
    projection: '三角测量 · 平面图',
    sheetSizeCm: '58 × 46 厘米',
    series: '京师实测图（协藏本）',
    neighborCodes: [],
    status: '待编',
  }

  const conflictPack = buildCorrectionPack({
    packageId: 'pack-demo-conflicts',
    label: '补遗校勘包（含冲突）',
    origin: '察哈尔文献协作馆',
    packedAt: stamp,
    items: [
      {
        kind: 'sheet',
        sourceKey: jia3.sourceKey ?? jia3.id,
        baseHash: hashContent(jia3Base),
        payload: jia3Remote,
      },
      { kind: 'scan', sourceKey: 'xgz-scan-missing-base', baseHash: hashContent(missingScan), payload: missingScan },
      { kind: 'place', sourceKey: 'xgz-place-orphan', baseHash: null, payload: orphanPlace },
      { kind: 'sheet', sourceKey: 'xgz-sheet-code-collision', baseHash: null, payload: collisionSheet },
    ],
  })

  // 包三：内容被改、校验和未重算 → 整包校验失败。
  const tampered: CorrectionPack = JSON.parse(JSON.stringify(cleanPack)) as CorrectionPack
  tampered.packageId = 'pack-demo-tampered'
  tampered.label = '张北图幅新包（传输损坏示例）'
  const tamperedSheet = tampered.items[0].payload as SheetPayload
  tamperedSheet.title = '张家口堡至大境门边图（被改动）'
  // checksum 故意保留原值。

  // 包四：与包一字节相同的副本（包号相同），重复登记应直接识别。
  const duplicate: CorrectionPack = JSON.parse(JSON.stringify(cleanPack)) as CorrectionPack

  return [
    fileOf(cleanPack, '无冲突新包：1 幅图幅、2 件扫描件、2 条地名，校验通过后可整包写入。'),
    fileOf(conflictPack, '含 4 项冲突：本地修订、底本缺失、图幅关联缺失、图幅号占用；请先在待处理区补证。'),
    fileOf(tampered, '损坏包：内容与校验和不符，应在校验阶段被拦截，不写入任何数据。'),
    fileOf(duplicate, '与第一个包包号相同：重复导入 / 写入后再导入都不应多出记录。'),
  ]
}
