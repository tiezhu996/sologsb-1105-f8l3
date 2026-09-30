/**
 * 离线合并与编目台写通道的集成测试（真实 Dexie + fake-indexeddb + Pinia）。
 * 由 esbuild 打包后执行：npm run test:offline
 *
 * 覆盖：v3 播种血缘 → 可合并包整包写入 → 重试幂等 → 馆员本地改动触发三类冲突
 * → 补证（保留本地/采用包项）→ 写入事务中途失败整体回滚且重试不多记录
 * → 离开页面（新 store 实例）后原包、进度与处理说明仍在。
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { db } from '../src/utils/db.ts'
import { reconcileContentMeta } from '../src/utils/contentMeta.ts'
import { useOfflineStore } from '../src/stores/offlineStore.ts'
import { useSheetStore } from '../src/stores/sheetStore.ts'
import { usePlaceStore } from '../src/stores/placeStore.ts'
import {
  canonicalPlace,
  canonicalScan,
  canonicalSheet,
  computePackageHash,
} from '../src/utils/offlineMerge.ts'
import { hashCanonical } from '../src/utils/hash.ts'

const pkgDir = join(import.meta.dirname, '..', 'public', 'offline-pkgs')
const kaifengText = readFileSync(join(pkgDir, 'kaifeng-fast-forward.json'), 'utf8')
const beijingText = readFileSync(join(pkgDir, 'beijing-conflict.json'), 'utf8')
const brokenText = readFileSync(join(pkgDir, 'broken-link.json'), 'utf8')

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

function freshPinia() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return pinia
}

const run = await (async () => {
  freshPinia()

  await test('v3 全新建库：种子业务数据与 contentMeta 血缘散列齐全', async () => {
    await db.open()
    const [sheets, scans, pairs, metas] = await Promise.all([
      db.sheets.count(),
      db.scans.count(),
      db.placePairs.count(),
      db.contentMeta.count(),
    ])
    assert.equal(sheets, 6)
    assert.equal(scans, 12)
    assert.equal(pairs, 12)
    assert.equal(metas, 30)
    // 抽查一条扫描件血缘：挂接图幅号参与散列
    const scan = await db.scans.get('scan-bp-jia-3-1')
    const sheet = await db.sheets.get(scan.sheetId)
    const meta = await db.contentMeta.get('scans:scan-bp-jia-3-1')
    assert.equal(meta.sourceKey, 'scan-bp-jia-3-1')
    assert.equal(meta.hash, hashCanonical(canonicalScan({
      sheetCode: sheet.code,
      fileName: scan.fileName,
      resolutionDpi: scan.resolutionDpi,
      colorMode: scan.colorMode,
      pieces: scan.pieces,
      quality: scan.quality,
      storageNote: scan.storageNote,
      importedAt: scan.importedAt,
      isPrimary: scan.isPrimary,
    })))
  })

  const offline = useOfflineStore()
  await offline.init()
  const sheetStore = useSheetStore()
  await sheetStore.init()
  const placeStore = usePlaceStore()
  await placeStore.init()

  await test('开封包导入即「可合并」，计划含 2 新增 2 更新', async () => {
    const result = await offline.importPackageFromText(kaifengText, 'kaifeng-fast-forward.json')
    assert.equal(result.staged.status, '可合并')
    assert.equal(result.staged.items.filter((i) => i.action === 'create').length, 2)
    assert.equal(result.staged.items.filter((i) => i.action === 'update').length, 2)
    assert.equal(result.staged.errors.length, 0)
  })

  await test('整包提交后新图幅/扫描件落库且按图幅号挂接，地名被更新', async () => {
    await offline.commitPackage('pkg-kf-2026-08-20')
    const newSheet = await db.sheets.where('code').equals('开封-港口-2').first()
    assert.ok(newSheet, '新图幅已写入')
    assert.equal(newSheet.sourceKey, 'kf-gangkou-2')
    const newScan = await db.scans.filter((s) => s.sourceKey === 'scan-kf-gangkou-2-1').first()
    assert.ok(newScan)
    assert.equal(newScan.sheetId, newSheet.id)
    assert.equal(newScan.isPrimary, true)
    const updatedPlace = await db.placePairs.get('place-kf-chengxi-1-2')
    assert.equal(updatedPlace.newName, '州桥遗址（考古发掘现场）')
    // 血缘同步更新
    const meta = await db.contentMeta.get(`placePairs:${updatedPlace.id}`)
    assert.equal(meta.hash, hashCanonical(canonicalPlace({
      sheetCode: '开封-城西-1',
      oldName: updatedPlace.oldName,
      newName: updatedPlace.newName,
      aliasList: updatedPlace.aliasList,
      placeType: updatedPlace.placeType,
      coordNote: updatedPlace.coordNote,
      certainty: updatedPlace.certainty,
    })))
    // 内存视图刷新
    await Promise.all([sheetStore.reloadAfterMerge(), placeStore.reloadAfterMerge()])
    assert.ok(sheetStore.sheets.some((s) => s.code === '开封-港口-2'))
    const staged = await db.offlinePackages.get('pkg-kf-2026-08-20')
    assert.equal(staged.status, '已合并')
    assert.ok(staged.logs.some((l) => l.phase === '写入' && /新增 2/.test(l.message)))
  })

  await test('同一包再次导入只识别为已存在，不重复写、不多暂存记录', async () => {
    const packagesBefore = await db.offlinePackages.count()
    const result = await offline.importPackageFromText(kaifengText, 'kaifeng-fast-forward.json')
    assert.equal(result.duplicate, true)
    assert.equal(await db.offlinePackages.count(), packagesBefore)
    assert.equal(await db.sheets.where('code').equals('开封-港口-2').count(), 1)
  })

  await test('馆员本地改动（编目台写通道）后，北平包三类记录各报冲突', async () => {
    // 编目台是唯一写入方：改业务表后经同一对账通道刷新血缘散列。
    await db.sheets.update('sheet-bp-jia-3', { title: '正阳门至崇文门街巷图（馆员校订本）' })
    await db.scans.update('scan-bp-jia-3-1', { storageNote: '馆员后来改的存放位置' })
    await db.placePairs.update('place-bp-jia-3-1', { certainty: '待考' })
    await reconcileContentMeta()

    const result = await offline.importPackageFromText(beijingText, 'beijing-conflict.json')
    assert.equal(result.staged.status, '待处理冲突')
    assert.equal(result.staged.conflicts.length, 3)
    assert.ok(result.staged.conflicts.every((c) => c.kind === 'content-mismatch'))
    const sheetConflict = result.staged.conflicts.find((c) => c.type === 'sheet')
    assert.ok(sheetConflict.fieldDiffs.some((d) => d.field === 'title'))
    assert.ok(sheetConflict.fieldDiffs.some((d) => d.local.includes('馆员校订本')))
  })

  await test('未补证时提交被拒（无写入）', async () => {
    const countBefore = await db.scans.count()
    const staged = await offline.commitPackage('pkg-bp-2026-09-01')
    assert.equal(staged.status, '待处理冲突')
    assert.equal(await db.scans.count(), countBefore)
  })

  await test('补证后整包提交：图幅保留馆员修改，扫描件/地名采用包项', async () => {
    const staged = await db.offlinePackages.get('pkg-bp-2026-09-01')
    const decisions = ['keep-local', 'take-package', 'take-package']
    for (let i = 0; i < staged.conflicts.length; i += 1) {
      await offline.resolveConflict(
        staged.packageId,
        staged.conflicts[i].id,
        decisions[i],
        `补证依据 ${i + 1}：核对 1908 年修城档`,
      )
    }
    const ready = await db.offlinePackages.get('pkg-bp-2026-09-01')
    assert.equal(ready.status, '可合并')
    await offline.commitPackage('pkg-bp-2026-09-01')
    const sheet = await db.sheets.get('sheet-bp-jia-3')
    assert.equal(sheet.title, '正阳门至崇文门街巷图（馆员校订本）')
    const scan = await db.scans.get('scan-bp-jia-3-1')
    assert.equal(scan.fileName, '北平甲3_原图精修_600dpi.tif')
    assert.equal(scan.storageNote, '协作馆数字库 BP-1907-03')
    const pair = await db.placePairs.get('place-bp-jia-3-1')
    assert.equal(pair.certainty, '存疑')
  })

  await test('坏链包：校验异常且原包保留，禁止写入', async () => {
    const result = await offline.importPackageFromText(brokenText, 'broken-link.json')
    assert.equal(result.staged.status, '校验异常')
    assert.ok(result.staged.errors.some((e) => e.includes('张家口-甲-9')))
    const committed = await offline.commitPackage('pkg-bad-link-2026-09-12')
    assert.notEqual(committed.status, '已合并')
    assert.ok(JSON.stringify(committed.rawPackage).includes('张家口-甲-9'), '原包内容仍在')
  })

  await test('写入事务中途失败：整体回滚无新记录，原包进度保留；重试成功且不重复', async () => {
    // 现造一个可直接合并的包
    const sheetItem = {
      sourceKey: 'rollback-test-sheet',
      code: '测试-甲-9',
      title: '回滚测试图幅',
      year: 1940,
      scale: '1:5000',
      projection: '三角测量 · 平面图',
      sheetSizeCm: '50 × 40 厘米',
      series: '测试图组',
      neighborCodes: [],
      status: '待编',
    }
    const canonical = canonicalSheet(sheetItem)
    const h = hashCanonical(canonical)
    const pkg = {
      kind: 'gboldmap-offline-correction',
      format: 1,
      manifest: {
        packageId: 'pkg-rollback-test',
        origin: '回滚测试',
        preparedAt: '2026-09-30T00:00:00.000Z',
        counts: { sheets: 1, scans: 0, placePairs: 0 },
        packageHash: '',
      },
      sheets: [{ ...sheetItem, baseHash: h, payloadHash: h }],
      scans: [],
      placePairs: [],
    }
    pkg.manifest.packageHash = computePackageHash(pkg)
    const text = JSON.stringify(pkg)
    await offline.importPackageFromText(text, 'rollback.json')
    const sheetsBefore = await db.sheets.count()

    // 让事务在 sheets 表首次 add 时抛错（Dexie 4 不暴露 Table 类，直接包装表实例）
    const originalAdd = db.sheets.add.bind(db.sheets)
    let failedOnce = false
    db.sheets.add = async function failingAdd() {
      if (!failedOnce) {
        failedOnce = true
        throw new Error('模拟磁盘故障')
      }
      return originalAdd.apply(this, arguments)
    }
    await assert.rejects(() => offline.commitPackage('pkg-rollback-test'), /模拟磁盘故障/)
    db.sheets.add = originalAdd

    assert.equal(await db.sheets.count(), sheetsBefore, '回滚后图幅数不变')
    const retained = await db.offlinePackages.get('pkg-rollback-test')
    assert.notEqual(retained.status, '已合并')
    assert.ok(retained.logs.some((l) => l.phase === '保留' && l.message.includes('整体回滚')))

    // 重试：成功且恰好多 1 条
    await offline.commitPackage('pkg-rollback-test')
    assert.equal(await db.sheets.count(), sheetsBefore + 1)
    assert.equal(await db.sheets.where('code').equals('测试-甲-9').count(), 1)
    const metas = await db.contentMeta.where('sourceKey').equals('rollback-test-sheet').count()
    assert.equal(metas, 1, '血缘记录也只有一条，无重复')
  })

  await test('离开页面再回来（新 Pinia / 新 store 实例）：包、补证说明与进度仍在', async () => {
    setActivePinia(createPinia())
    const reloaded = useOfflineStore()
    await reloaded.init()
    assert.ok(reloaded.packages.length >= 3)
    const bp = reloaded.packages.find((p) => p.packageId === 'pkg-bp-2026-09-01')
    assert.equal(bp.status, '已合并')
    assert.equal(bp.conflicts.length, 3)
    assert.ok(bp.conflicts.every((c) => c.resolution?.evidence?.includes('修城档')))
    assert.ok(bp.logs.some((l) => l.phase === '补证'))
    assert.ok(bp.logs.some((l) => l.phase === '写入'))
    assert.ok(bp.rawPackage, '原包保留')
    const broken = reloaded.packages.find((p) => p.packageId === 'pkg-bad-link-2026-09-12')
    assert.equal(broken.status, '校验异常')
    const rollback = reloaded.packages.find((p) => p.packageId === 'pkg-rollback-test')
    assert.equal(rollback.status, '已合并')
    assert.ok(rollback.logs.some((l) => l.phase === '保留'))
  })

  await test('补证后本地又被改动：裁定失效、重新挂起冲突', async () => {
    // 再造一个冲突包针对当前已采用包项的扫描件
    const scan = await db.scans.get('scan-bp-jia-3-1')
    const sheet = await db.sheets.get(scan.sheetId)
    const seedCanonical = canonicalScan({
      sheetCode: sheet.code,
      fileName: scan.fileName,
      resolutionDpi: scan.resolutionDpi,
      colorMode: scan.colorMode,
      pieces: scan.pieces,
      quality: scan.quality,
      storageNote: scan.storageNote,
      importedAt: scan.importedAt,
      isPrimary: scan.isPrimary,
    })
    const nextCanonical = { ...seedCanonical, storageNote: '协作馆二次修订存放位置' }
    const item = {
      sourceKey: 'scan-bp-jia-3-1',
      ...nextCanonical,
      baseHash: hashCanonical(seedCanonical),
      payloadHash: hashCanonical(nextCanonical),
    }
    const pkg = {
      kind: 'gboldmap-offline-correction',
      format: 1,
      manifest: {
        packageId: 'pkg-stale-resolution',
        origin: '二次来包',
        preparedAt: '2026-09-30T01:00:00.000Z',
        counts: { sheets: 0, scans: 1, placePairs: 0 },
        packageHash: '',
      },
      sheets: [],
      scans: [item],
      placePairs: [],
    }
    pkg.manifest.packageHash = computePackageHash(pkg)

    // 馆员又改了扫描件 -> 与两边散列都不同
    await db.scans.update(scan.id, { pieces: 9 })
    await reconcileContentMeta()
    setActivePinia(createPinia())
    const store2 = useOfflineStore()
    const imported = await store2.importPackageFromText(JSON.stringify(pkg), 'stale.json')
    assert.equal(imported.staged.status, '待处理冲突')
    const conflict = imported.staged.conflicts[0]
    await store2.resolveConflict(conflict.packageId, conflict.id, 'take-package', '依据 X')
    // 裁定之后再改本地
    await db.scans.update(scan.id, { pieces: 10 })
    await reconcileContentMeta()
    const rechecked = await store2.reevaluate(conflict.packageId)
    assert.equal(rechecked.status, '待处理冲突')
    assert.equal(rechecked.conflicts[0].resolution, undefined)
  })

  await db.close()
})()

await run
console.log(`\n${passed} 项离线合并集成测试（全新库）通过`)
