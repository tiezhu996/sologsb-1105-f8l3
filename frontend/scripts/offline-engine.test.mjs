/**
 * 离线合并引擎的纯 Node 端到端校验（不依赖 IndexedDB）。
 * 由 esbuild 打包后执行：npm run test:offline
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildWrites,
  canonicalPlace,
  canonicalScan,
  canonicalSheet,
  computePackageHash,
  evaluatePackage,
  isConflictResolved,
  parsePackageText,
  PlanNotReadyError,
} from '../src/utils/offlineMerge.ts'
import { hashCanonical } from '../src/utils/hash.ts'

const pkgDir = join(import.meta.dirname, '..', 'public', 'offline-pkgs')
const kaifeng = JSON.parse(readFileSync(join(pkgDir, 'kaifeng-fast-forward.json'), 'utf8'))
const beijing = JSON.parse(readFileSync(join(pkgDir, 'beijing-conflict.json'), 'utf8'))
const broken = JSON.parse(readFileSync(join(pkgDir, 'broken-link.json'), 'utf8'))

/* ---------- 编目台本地库的极简内存实现（模拟唯一写入方） ---------- */
class MemoryCatalog {
  seq = 1000

  constructor() {
    this.sheets = new Map()
    this.scans = new Map()
    this.places = new Map()
  }

  seed() {
    this.sheets.set('sheet-kf-chengxi-1', {
      id: 'sheet-kf-chengxi-1',
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
    })
    this.places.set('place-kf-chengxi-1-2', {
      id: 'place-kf-chengxi-1-2',
      sourceKey: 'place-kf-chengxi-1-2',
      sheetId: 'sheet-kf-chengxi-1',
      oldName: '州桥旧址',
      newName: '州桥遗址',
      aliasList: ['汴州桥', '天汉桥'],
      placeType: '桥梁',
      coordNote: '图幅中部偏南，御街与汴河故道交会',
      certainty: '存疑',
    })
    this.sheets.set('sheet-bp-jia-3', {
      id: 'sheet-bp-jia-3',
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
    })
    this.scans.set('scan-bp-jia-3-1', {
      id: 'scan-bp-jia-3-1',
      sourceKey: 'scan-bp-jia-3-1',
      sheetId: 'sheet-bp-jia-3',
      fileName: '北平甲3_原图_600dpi.tif',
      resolutionDpi: 600,
      colorMode: '彩色',
      pieces: 4,
      quality: '清晰',
      storageNote: '市档案馆 D-17-04 铁柜',
      importedAt: '2025-02-18T09:30:00.000Z',
      isPrimary: true,
    })
    this.places.set('place-bp-jia-3-1', {
      id: 'place-bp-jia-3-1',
      sourceKey: 'place-bp-jia-3-1',
      sheetId: 'sheet-bp-jia-3',
      oldName: '正阳门瓮城',
      newName: '正阳门',
      aliasList: ['前门瓮城', '正阳门月城'],
      placeType: '衙署',
      coordNote: '图幅中部偏南，城墙与护城河交汇处',
      certainty: '确定',
    })
  }

  snapshot() {
    return {
      localSheets: [...this.sheets.values()],
      localScans: [...this.scans.values()],
      localPlaces: [...this.places.values()],
    }
  }

  evaluate(pkg, conflicts = []) {
    return evaluatePackage({ pkg, ...this.snapshot(), savedConflicts: conflicts })
  }

  prepare(pkg, conflicts = []) {
    const evaluation = this.evaluate(pkg, conflicts)
    return buildWrites({
      pkg,
      plan: evaluation.plan,
      nextId: (kind) => `${kind}-mem-${this.seq++}`,
    })
  }

  /** 模拟 IndexedDB 单事务：先在影子表上改，任一步失败整体回滚。 */
  commit(writes, primaryDemotions) {
    const shadowSheets = new Map(this.sheets)
    const shadowScans = new Map(this.scans)
    const shadowPlaces = new Map(this.places)
    for (const { sheetId, exceptScanId } of primaryDemotions) {
      for (const [id, scan] of shadowScans) {
        if (scan.sheetId === sheetId && id !== exceptScanId) {
          shadowScans.set(id, { ...scan, isPrimary: false })
        }
      }
    }
    for (const write of writes) {
      if (write.op === 'skip') {
        continue
      }
      const table =
        write.table === 'sheets' ? shadowSheets : write.table === 'scans' ? shadowScans : shadowPlaces
      if (write.op === 'add' && table.has(write.key)) {
        throw new Error(`主键已存在：${write.key}`)
      }
      table.set(write.key, write.row)
    }
    this.sheets = shadowSheets
    this.scans = shadowScans
    this.places = shadowPlaces
  }

  applyPackage(pkg, conflicts = []) {
    const evaluation = this.evaluate(pkg, conflicts)
    const { writes, primaryDemotions } = buildWrites({
      pkg,
      plan: evaluation.plan,
      nextId: (kind) => `${kind}-mem-${this.seq++}`,
    })
    this.commit(writes, primaryDemotions)
    return { evaluation, writes }
  }
}

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

/* 1. 整包摘要与逐件散列 */
test('示例包整包摘要与逐件 payloadHash 均可重算并一致', () => {
  for (const pkg of [kaifeng, beijing, broken]) {
    assert.equal(computePackageHash(pkg), pkg.manifest.packageHash)
    for (const item of [...pkg.sheets, ...pkg.scans, ...pkg.placePairs]) {
      const canonical =
        'code' in item ? canonicalSheet(item) : 'fileName' in item ? canonicalScan(item) : canonicalPlace(item)
      assert.equal(hashCanonical(canonical), item.payloadHash)
    }
  }
})

test('篡改任意记录后整包摘要校验失败、禁止合并', () => {
  const tampered = structuredClone(kaifeng)
  tampered.sheets[0].title = '被篡改的题名'
  const catalog = new MemoryCatalog()
  catalog.seed()
  const result = evaluatePackage({ pkg: tampered, ...catalog.snapshot() })
  assert.ok(result.errors.some((error) => error.includes('整包摘要')))
  assert.equal(result.readyToMerge, false)
})

/* 2. 干净推进包 */
test('开封包：基线干净时可合并（2 新增 + 2 更新，0 冲突）', () => {
  const catalog = new MemoryCatalog()
  catalog.seed()
  const result = catalog.evaluate(kaifeng)
  assert.deepEqual(result.errors, [])
  assert.equal(result.readyToMerge, true)
  const count = (action) => result.plan.items.filter((item) => item.action === action).length
  assert.deepEqual([count('create'), count('update'), count('noop'), count('conflict')], [2, 2, 0, 0])
})

test('开封包写入后扫描件挂接到新图幅；重试同一包全部 noop、不多记录', () => {
  const catalog = new MemoryCatalog()
  catalog.seed()
  const first = catalog.applyPackage(kaifeng)
  assert.equal(first.writes.filter((write) => write.op !== 'skip').length, 4)
  const newSheet = [...catalog.sheets.values()].find((sheet) => sheet.code === '开封-港口-2')
  assert.ok(newSheet)
  const newScan = [...catalog.scans.values()].find((scan) => scan.sourceKey === 'scan-kf-gangkou-2-1')
  assert.equal(newScan.sheetId, newSheet.id)
  assert.equal(newScan.isPrimary, true)

  const second = catalog.evaluate(kaifeng)
  assert.ok(second.plan.items.every((item) => item.action === 'noop'))
  const { writes } = catalog.prepare(kaifeng)
  assert.equal(writes.filter((write) => write.op !== 'skip').length, 0)

  const sheetCount = catalog.sheets.size
  const scanCount = catalog.scans.size
  catalog.applyPackage(kaifeng)
  assert.equal(catalog.sheets.size, sheetCount)
  assert.equal(catalog.scans.size, scanCount)
})

/* 3. 冲突包 */
function catalogWithLocalEdits() {
  const catalog = new MemoryCatalog()
  catalog.seed()
  catalog.sheets.get('sheet-bp-jia-3').title = '馆员后来改的题名'
  catalog.scans.get('scan-bp-jia-3-1').storageNote = '馆员后来改的存放位置'
  catalog.places.get('place-bp-jia-3-1').certainty = '待考'
  return catalog
}

test('北平包：馆员本地改过的图幅/扫描件/地名各产生一项冲突且禁止写入', () => {
  const catalog = catalogWithLocalEdits()
  const result = catalog.evaluate(beijing)
  assert.equal(result.readyToMerge, false)
  assert.equal(result.plan.conflicts.length, 3)
  assert.ok(result.plan.conflicts.every((conflict) => conflict.kind === 'content-mismatch'))
  assert.ok(result.plan.conflicts.some((conflict) => conflict.fieldDiffs.some((diff) => diff.field === 'title')))
  assert.throws(() => catalog.prepare(beijing), PlanNotReadyError)
})

test('冲突补证后：keep-local 保留馆员值，take-package 采用包项', () => {
  const catalog = catalogWithLocalEdits()
  const first = catalog.evaluate(beijing)
  const resolved = first.plan.conflicts.map((conflict, index) => ({
    ...conflict,
    resolution: {
      decision: index === 0 ? 'keep-local' : 'take-package',
      evidence: '已核对 1908 年修城档',
      at: '2026-09-30T00:00:00.000Z',
      basedOnLocalHash: conflict.localHash,
    },
  }))
  assert.equal(catalog.evaluate(beijing, resolved).readyToMerge, true)
  catalog.applyPackage(beijing, resolved)
  assert.equal(catalog.sheets.get('sheet-bp-jia-3').title, '馆员后来改的题名')
  assert.equal(catalog.scans.get('scan-bp-jia-3-1').storageNote, '协作馆数字库 BP-1907-03')
  assert.equal(catalog.places.get('place-bp-jia-3-1').certainty, '存疑')
})

test('补证之后本地又被改动：裁定随旧散列失效，冲突重新挂起', () => {
  const catalog = catalogWithLocalEdits()
  const first = catalog.evaluate(beijing)
  const sheetConflict = first.plan.conflicts.find((conflict) => conflict.type === 'sheet')
  const withResolution = [
    {
      ...sheetConflict,
      resolution: {
        decision: 'take-package',
        evidence: '旧依据',
        at: '2026-09-29T00:00:00.000Z',
        basedOnLocalHash: sheetConflict.localHash,
      },
    },
  ]
  catalog.sheets.get('sheet-bp-jia-3').title = '馆员再改一次'
  const rechecked = catalog.evaluate(beijing, withResolution)
  const sheetAgain = rechecked.plan.conflicts.find((conflict) => conflict.type === 'sheet')
  assert.equal(isConflictResolved(sheetAgain), false)
  assert.equal(rechecked.readyToMerge, false)
})

/* 4. 坏链包 */
test('坏链包：扫描件引用包内与本地都不存在的图幅号时整包拦截', () => {
  const catalog = new MemoryCatalog()
  catalog.seed()
  const result = catalog.evaluate(broken)
  assert.equal(result.readyToMerge, false)
  assert.ok(result.errors.some((error) => error.includes('张家口-甲-9')))
})

/* 5. 图幅号撞号：本地同号图幅属于另一条外部来源记录 */
test('同图幅号属于另一来源时报 code-collision，补证只能跳过、不覆盖', () => {
  const catalog = new MemoryCatalog()
  catalog.seed()
  // 本地已有包来源（kf-gangkou-2）的一条记录，但它挂的图幅号被另一条
  // 本地记录占用：两条不同记录对同一图幅号 -> 撞号，不能覆盖另一条。
  catalog.sheets.set('sheet-local-gangkou', {
    id: 'sheet-local-gangkou',
    sourceKey: 'kf-gangkou-2',
    code: '开封-港口-9',
    title: '本台此前登记的来源记录',
    year: 1936,
    scale: '1:5000',
    projection: '三角测量 · 平面图',
    sheetSizeCm: '60 × 45 厘米',
    series: '河南省城实测图',
    neighborCodes: [],
    status: '待核',
  })
  catalog.sheets.set('sheet-external-kf-1', {
    id: 'sheet-external-kf-1',
    sourceKey: 'external-gangkou-2',
    code: '开封-港口-2',
    title: '外馆登记的港口-2（另立记录）',
    year: 1937,
    scale: '1:5000',
    projection: '三角测量 · 平面图',
    sheetSizeCm: '60 × 45 厘米',
    series: '外馆图组',
    neighborCodes: [],
    status: '待核',
  })

  const incoming = structuredClone(kaifeng)
  incoming.manifest = { ...incoming.manifest, packageId: 'pkg-collision' }
  incoming.scans = []
  incoming.manifest.counts = { ...incoming.manifest.counts, scans: 0 }
  incoming.manifest.packageHash = computePackageHash(incoming)

  const result = catalog.evaluate(incoming)
  const collision = result.plan.conflicts.find((conflict) => conflict.kind === 'code-collision')
  assert.ok(collision)
  assert.equal(collision.sourceKey, 'kf-gangkou-2')
  const resolved = [
    {
      ...collision,
      resolution: { decision: 'skip-item', evidence: '维持本地', at: 'x', basedOnLocalHash: collision.localHash },
    },
  ]
  const { writes } = catalog.prepare(incoming, resolved)
  const collisionWrite = writes.find((write) => write.mergedSourceKey === 'kf-gangkou-2')
  assert.equal(collisionWrite.op, 'skip')
  assert.equal(catalog.sheets.get('sheet-external-kf-1').title, '外馆登记的港口-2（另立记录）')
})

/* 6. 非法文件 */
test('非 JSON 文件返回解析错误而不是抛异常', () => {
  const parsed = parsePackageText('这不是{json')
  assert.equal(parsed.ok, false)
  assert.ok(parsed.error.includes('JSON'))
})

console.log(`\n${passed} 项离线合并引擎测试通过`)
