#!/usr/bin/env node
/**
 * 生成协作馆断网带来的离线校勘包示例（纯 Node，无外部依赖）。
 * 与 src/utils/hash.ts、src/utils/offlineMerge.ts 保持同一套规范与散列规则。
 *
 * 产物写入 public/offline-pkgs：
 * - kaifeng-fast-forward.json：基线干净，整包可直接合并（含新图幅）；
 * - beijing-conflict.json：本地馆员已改过图幅/扫描件/地名，整包应报三项冲突，
 *   补证后才能继续；
 * - broken-link.json：扫描件引用了包内与本地都不存在的图幅号，校验失败。
 *
 * 用法：node scripts/generate-sample-packages.mjs
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'public', 'offline-pkgs')

const KIND = 'gboldmap-offline-correction'
const FORMAT = 1

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function canonicalSheet(item) {
  return {
    code: item.code,
    title: item.title,
    year: item.year,
    scale: item.scale,
    projection: item.projection,
    sheetSizeCm: item.sheetSizeCm,
    series: item.series,
    neighborCodes: item.neighborCodes,
    status: item.status,
  }
}

function canonicalScan(item) {
  return {
    sheetCode: item.sheetCode,
    fileName: item.fileName,
    resolutionDpi: item.resolutionDpi,
    colorMode: item.colorMode,
    pieces: item.pieces,
    quality: item.quality,
    storageNote: item.storageNote,
    importedAt: item.importedAt,
    isPrimary: item.isPrimary,
  }
}

function canonicalPlace(item) {
  return {
    sheetCode: item.sheetCode,
    oldName: item.oldName,
    newName: item.newName,
    aliasList: item.aliasList,
    placeType: item.placeType,
    coordNote: item.coordNote,
    certainty: item.certainty,
  }
}

/** 新增项：基线散列与新内容散列相同。 */
function newItem(item, canonicalOf) {
  const canonical = canonicalOf(item)
  const payloadHash = sha256(stableStringify(canonical))
  return { ...item, baseHash: payloadHash, payloadHash }
}

/**
 * 更新项：baseHash 是协作馆动手前看到的基线（本台 seed 内容），
 * payloadHash 才是包内新内容。馆员本地若仍是基线 -> 干净更新；
 * 本地若也改过 -> 本地散列两边都不挨 -> 冲突。
 */
function updatedItem(seed, changes, canonicalOf) {
  const next = { ...seed, ...changes }
  return {
    ...next,
    baseHash: sha256(stableStringify(canonicalOf(seed))),
    payloadHash: sha256(stableStringify(canonicalOf(next))),
  }
}

/** 故意制造冲突：传入基线与包内新版本，baseHash 锁基线，payloadHash 锁新版本。 */
function conflictingItem(seed, changes, canonicalOf) {
  return updatedItem(seed, changes, canonicalOf)
}

function buildPackage({ packageId, origin, preparedAt, note, sheets, scans, placePairs }) {
  const manifest = {
    packageId,
    origin,
    preparedAt,
    note,
    counts: { sheets: sheets.length, scans: scans.length, placePairs: placePairs.length },
    packageHash: '',
  }
  const pkg = { kind: KIND, format: FORMAT, manifest, sheets, scans, placePairs }
  // 与 computePackageHash 完全一致：去掉 packageHash 后做规范散列。
  const digestSource = {
    kind: KIND,
    format: FORMAT,
    manifest: { packageId, origin, preparedAt, note, counts: manifest.counts },
    sheets: sheets.map(canonicalSheet),
    scans: scans.map(canonicalScan),
    placePairs: placePairs.map(canonicalPlace),
  }
  manifest.packageHash = sha256(stableStringify(digestSource))
  return pkg
}

/* 1. 开封包：对 seed 基线做一次干净推进，并带来一幅新图幅 */
const kfSheetSeed = {
  sourceKey: 'sheet-kf-chengxi-1',
  code: '开封-城西-1',
  title: '大梁门至西门大街图',
  year: 1935,
  scale: '1:5000',
  projection: '三角测量 · 平面图',
  sheetSizeCm: '60 × 45 厘米',
  series: '河南省城实测图',
  neighborCodes: ['开封-城西-2', '开封-城中-1', '开封-城北-1'],
  status: '已编',
}
const kfPlaceSeed = {
  sourceKey: 'place-kf-chengxi-1-2',
  sheetCode: '开封-城西-1',
  oldName: '州桥旧址',
  newName: '州桥遗址',
  aliasList: ['汴州桥', '天汉桥'],
  placeType: '桥梁',
  coordNote: '图幅中部偏南，御街与汴河故道交会',
  certainty: '存疑',
}

const kfUpdatedSheet = updatedItem(
  kfSheetSeed,
  {
    title: '大梁门至西门大街图（协作馆修订）',
    year: 1936,
    neighborCodes: ['开封-城西-2', '开封-城中-1', '开封-城北-1', '开封-城南-1'],
  },
  canonicalSheet,
)

const kfNewSheet = newItem(
  {
    sourceKey: 'kf-gangkou-2',
    code: '开封-港口-2',
    title: '汴河码头至东水门图',
    year: 1936,
    scale: '1:5000',
    projection: '三角测量 · 平面图',
    sheetSizeCm: '60 × 45 厘米',
    series: '河南省城实测图',
    neighborCodes: ['开封-城西-1', '开封-港口-1'],
    status: '待编',
  },
  canonicalSheet,
)

const kfNewScan = newItem(
  {
    sourceKey: 'scan-kf-gangkou-2-1',
    sheetCode: '开封-港口-2',
    fileName: '开封港口2_东水门_600dpi.tif',
    resolutionDpi: 600,
    colorMode: '彩色',
    pieces: 3,
    quality: '清晰',
    storageNote: '协作馆开封专柜 K-1936-02',
    importedAt: '2026-08-12T10:00:00.000Z',
    isPrimary: true,
  },
  canonicalScan,
)

const kfUpdatedPlace = updatedItem(
  kfPlaceSeed,
  {
    newName: '州桥遗址（考古发掘现场）',
    aliasList: ['汴州桥', '天汉桥', '州桥'],
    coordNote: '御街与汴河故道交会处，1984 年钻探确认，2018 年发掘。',
    certainty: '确定',
  },
  canonicalPlace,
)

const kaifengPkg = buildPackage({
  packageId: 'pkg-kf-2026-08-20',
  origin: '开封市地方志协作馆',
  preparedAt: '2026-08-20T08:30:00.000Z',
  note: '断网期间完成开封城西片区核校，含港口-2 新图幅一幅。',
  sheets: [kfUpdatedSheet, kfNewSheet],
  scans: [kfNewScan],
  placePairs: [kfUpdatedPlace],
})

/* 2. 北平包：seed 基线上的推进，但馆员后来又在本地改过 -> 三项全冲突 */
const bpSheetSeed = {
  sourceKey: 'sheet-bp-jia-3',
  code: '北平-甲-3',
  title: '正阳门至崇文门街巷图',
  year: 1907,
  scale: '1:5000',
  projection: '三角测量 · 平面图',
  sheetSizeCm: '58 × 46 厘米',
  series: '京师实测图',
  neighborCodes: ['北平-甲-2', '北平-甲-4', '北平-乙-3'],
  status: '已编',
}
const bpScanSeed = {
  sourceKey: 'scan-bp-jia-3-1',
  sheetCode: '北平-甲-3',
  fileName: '北平甲3_原图_600dpi.tif',
  resolutionDpi: 600,
  colorMode: '彩色',
  pieces: 4,
  quality: '清晰',
  storageNote: '市档案馆 D-17-04 铁柜',
  importedAt: '2025-02-18T09:30:00.000Z',
  isPrimary: true,
}
const bpPlaceSeed = {
  sourceKey: 'place-bp-jia-3-1',
  sheetCode: '北平-甲-3',
  oldName: '正阳门瓮城',
  newName: '正阳门',
  aliasList: ['前门瓮城', '正阳门月城'],
  placeType: '衙署',
  coordNote: '图幅中部偏南，城墙与护城河交汇处',
  certainty: '确定',
}

// baseHash 锁协作馆打包那一刻看到的内容（= 本台 seed），本台馆员随后本地改过
// -> 本地散列既不等于 baseHash 也不等于新内容 -> 三类记录各报一项冲突。
const bpConflictSheet = conflictingItem(
  bpSheetSeed,
  { title: '正阳门至崇文门内外城街巷图', year: 1908 },
  canonicalSheet,
)
const bpConflictScan = conflictingItem(
  bpScanSeed,
  { fileName: '北平甲3_原图精修_600dpi.tif', pieces: 5, storageNote: '协作馆数字库 BP-1907-03' },
  canonicalScan,
)
const bpConflictPlace = conflictingItem(
  bpPlaceSeed,
  {
    newName: '正阳门城楼及箭楼',
    certainty: '存疑',
    coordNote: '图幅中部偏南，瓮城与箭楼位置需与 1908 年修城档案互证。',
  },
  canonicalPlace,
)

const beijingPkg = buildPackage({
  packageId: 'pkg-bp-2026-09-01',
  origin: '北平市档案馆协作点',
  preparedAt: '2026-09-01T15:00:00.000Z',
  note: '据馆藏 1908 年修城档复核甲-3；若贵馆已改动，请补证后再并入。',
  sheets: [bpConflictSheet],
  scans: [bpConflictScan],
  placePairs: [bpConflictPlace],
})

/* 3. 坏链包：扫描件引用了包内与本地都不存在的图幅号 */
const brokenScan = newItem(
  {
    sourceKey: 'scan-unknown-sheet-1',
    sheetCode: '张家口-甲-9',
    fileName: '张家口甲9_未知图幅_300dpi.jpg',
    resolutionDpi: 300,
    colorMode: '黑白',
    pieces: 1,
    quality: '偏淡',
    storageNote: '来源待查',
    importedAt: '2026-09-10T09:00:00.000Z',
    isPrimary: true,
  },
  canonicalScan,
)
const brokenSheet = newItem(
  {
    sourceKey: 'sheet-baoding-north-7',
    code: '保定-北-7',
    title: '清苑北郊村落图',
    year: 1921,
    scale: '1:50000',
    projection: '多圆锥投影',
    sheetSizeCm: '50 × 42 厘米',
    series: '直隶五万分一图',
    neighborCodes: ['保定-中-4'],
    status: '待核',
  },
  canonicalSheet,
)
const brokenPkg = buildPackage({
  packageId: 'pkg-bad-link-2026-09-12',
  origin: '某协作馆（来件不全）',
  preparedAt: '2026-09-12T12:00:00.000Z',
  note: '扫描件挂接图幅号在随包图幅清单中缺失，用于演示校验拦截。',
  sheets: [brokenSheet],
  scans: [brokenScan],
  placePairs: [],
})

mkdirSync(outDir, { recursive: true })
const files = [
  ['kaifeng-fast-forward.json', kaifengPkg],
  ['beijing-conflict.json', beijingPkg],
  ['broken-link.json', brokenPkg],
]
for (const [name, pkg] of files) {
  writeFileSync(join(outDir, name), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log('written', name)
}

const index = [
  {
    file: 'kaifeng-fast-forward.json',
    title: '开封协作馆 · 可直接合并',
    description: '基线干净的推进包，含一幅新图幅与一条新增扫描件。',
  },
  {
    file: 'beijing-conflict.json',
    title: '北平协作点 · 含本地修改冲突',
    description: '图幅、扫描件、地名各有一项与馆员后来改动冲突，需补证。',
  },
  {
    file: 'broken-link.json',
    title: '来件不全 · 挂接校验失败',
    description: '扫描件引用了不存在的图幅号，整包被拦截。',
  },
]
writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log('written index.json')
