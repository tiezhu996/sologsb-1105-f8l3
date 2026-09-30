/**
 * 老库升级路径集成测试：
 * 1. 先建 v2 结构的 gboldmap-db（含旧种子数据，无 contentMeta/offlinePackages）；
 * 2. 再打开应用真实的 v3 数据库，验证升级回填的血缘散列正确；
 * 3. 导入一份“旧打包工具”产出的包（记录无 payloadHash），仍可校验、比对并写入。
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import Dexie from 'dexie'
import { hashCanonical } from '../src/utils/hash.ts'

let passed = 0
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`  ✓ ${name}`)
    })
    .catch((error) => {
      console.error(`  ✗ ${name}`)
      console.error(error)
      process.exitCode = 1
    })
}

/* 1. 造一个 v2 老库（不经过应用代码） */
class V2Database extends Dexie {
  constructor() {
    super('gboldmap-db')
    this.version(1).stores({
      sheets: 'id, code, year, scale, status, series',
      scans: 'id, sheetId, importedAt, quality',
      placePairs: 'id, sheetId, oldName, newName, placeType, certainty',
      histories: 'id, placePairId, period, changeType',
    })
    this.version(2).stores({
      sheets: 'id, code, year, scale, status, series',
      scans: 'id, sheetId, importedAt, quality',
      placePairs: 'id, sheetId, oldName, newName, placeType, certainty',
      histories: 'id, placePairId, period, changeType',
    })
  }
}

const oldSheet = {
  id: 'sheet-old-1',
  code: '旧京-甲-1',
  title: '老库图幅',
  year: 1912,
  scale: '1:5000',
  projection: '三角测量 · 平面图',
  sheetSizeCm: '50 × 40 厘米',
  series: '旧图组',
  neighborCodes: [],
  status: '待核',
}
const oldScan = {
  id: 'scan-old-1',
  sheetId: 'sheet-old-1',
  fileName: '旧扫描.tif',
  resolutionDpi: 300,
  colorMode: '灰度',
  pieces: 2,
  quality: '偏淡',
  storageNote: '旧柜',
  importedAt: '1920-01-01T00:00:00.000Z',
  isPrimary: true,
}
const oldPair = {
  id: 'place-old-1',
  sheetId: 'sheet-old-1',
  oldName: '旧古名',
  newName: '旧今名',
  aliasList: ['异写'],
  placeType: '桥梁',
  coordNote: '城东',
  certainty: '存疑',
}

const v2 = new V2Database()
await v2.sheets.bulkAdd([oldSheet])
await v2.scans.bulkAdd([oldScan])
await v2.placePairs.bulkAdd([oldPair])
await v2.histories.bulkAdd([{ id: 'h1', placePairId: 'place-old-1', period: '清末', name: '旧古名', changeType: '初置', sourceRef: '旧档', note: '' }])
v2.close()

/* 2. 打开应用真实数据库，触发 v3 升级 */
const { db } = await import('../src/utils/db.ts')
const {
  canonicalOfLocalPlace,
  canonicalOfLocalScan,
  canonicalOfLocalSheet,
  evaluatePackage,
} = await import('../src/utils/offlineMerge.ts')

await test('v2 → v3 升级：老数据保留且 contentMeta 血缘散列回填', async () => {
  await db.open()
  assert.equal(db.verno, 3)
  assert.equal(await db.sheets.count(), 1)
  assert.equal(await db.scans.count(), 1)
  assert.equal(await db.placePairs.count(), 1)
  assert.equal(await db.histories.count(), 1, '沿革数据不受升级影响')

  const sheetMeta = await db.contentMeta.get('sheets:sheet-old-1')
  assert.ok(sheetMeta)
  assert.equal(sheetMeta.origin, 'local-seed')
  assert.equal(sheetMeta.sourceKey, 'sheet-old-1')
  assert.equal(sheetMeta.hash, hashCanonical(canonicalOfLocalSheet(oldSheet)))

  const scanMeta = await db.contentMeta.get('scans:scan-old-1')
  assert.equal(scanMeta.hash, hashCanonical(canonicalOfLocalScan(oldScan, '旧京-甲-1')))
  const pairMeta = await db.contentMeta.get('placePairs:place-old-1')
  assert.equal(pairMeta.hash, hashCanonical(canonicalOfLocalPlace(oldPair, '旧京-甲-1')))
})

/* 3. 旧打包工具的包（无 payloadHash、无新表概念）仍可读取 */
const sheetSeedCanonical = canonicalOfLocalSheet(oldSheet)
const sheetNext = { ...sheetSeedCanonical, title: '老库图幅（协作馆据旧档校订）', status: '已编' }
const oldStyleSheet = {
  sourceKey: 'sheet-old-1',
  ...sheetNext,
  // 旧包只给 baseHash，没有逐件 payloadHash
  baseHash: hashCanonical(sheetSeedCanonical),
}
const oldStylePkg = {
  kind: 'gboldmap-offline-correction',
  format: 1,
  manifest: {
    packageId: 'pkg-old-style',
    origin: '老版本协作馆',
    preparedAt: '1925-06-01T00:00:00.000Z',
    counts: { sheets: 1, scans: 0, placePairs: 0 },
    packageHash: '',
  },
  sheets: [oldStyleSheet],
  scans: [],
  placePairs: [],
}
const { computePackageHash } = await import('../src/utils/offlineMerge.ts')
oldStylePkg.manifest.packageHash = computePackageHash(oldStylePkg)

await test('升级后读取旧包：仅提示缺 payloadHash，仍按基线判定为可合并', async () => {
  const [sheets, scans, pairs] = await Promise.all([
    db.sheets.toArray(),
    db.scans.toArray(),
    db.placePairs.toArray(),
  ])
  const result = evaluatePackage({ pkg: oldStylePkg, localSheets: sheets, localScans: scans, localPlaces: pairs })
  assert.equal(result.errors.length, 0)
  assert.ok(result.warnings.some((w) => w.includes('payloadHash')), '给出旧包降级提示')
  assert.equal(result.readyToMerge, true)
  const evaluated = result.plan.items[0]
  assert.equal(evaluated.action, 'update')
})

await test('旧包基线不匹配本地时同样报冲突，不允许覆盖', async () => {
  await db.sheets.update('sheet-old-1', { title: '馆员另改的题名' })
  const [sheets, scans, pairs] = await Promise.all([
    db.sheets.toArray(),
    db.scans.toArray(),
    db.placePairs.toArray(),
  ])
  const result = evaluatePackage({ pkg: oldStylePkg, localSheets: sheets, localScans: scans, localPlaces: pairs })
  assert.equal(result.readyToMerge, false)
  assert.equal(result.plan.conflicts.length, 1)
  assert.equal(result.plan.conflicts[0].kind, 'content-mismatch')
})

await db.close()
console.log(`\n${passed} 项老库升级集成测试通过`)
