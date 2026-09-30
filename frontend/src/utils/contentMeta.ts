/**
 * contentMeta 与业务表的对账工具。
 * 编目台是本地唯一写入方：图幅/扫描件/地名的任何新增或修改之后调用
 * reconcileContentMeta，血缘散列即可与当前内容保持一致，供离线合并比对。
 */
import { db, type ContentMeta } from './db'
import type { PlacePair } from '../types/placePair'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import {
  canonicalOfLocalPlace,
  canonicalOfLocalScan,
  canonicalOfLocalSheet,
} from './offlineMerge'
import { hashCanonical } from './hash'

type MetaTable = ContentMeta['table']

export async function reconcileContentMeta(): Promise<void> {
  const [sheets, scans, pairs, existing] = await Promise.all([
    db.sheets.toArray(),
    db.scans.toArray(),
    db.placePairs.toArray(),
    db.contentMeta.toArray(),
  ])
  const existingByKey = new Map(existing.map((meta) => [meta.key, meta]))
  const codeById = new Map(sheets.map((sheet) => [sheet.id, sheet.code]))
  const now = new Date().toISOString()
  const next: ContentMeta[] = []
  const seenKeys = new Set<string>()

  function push(
    table: MetaTable,
    localId: string,
    fallbackSourceKey: string,
    hash: string,
  ): void {
    const key = `${table}:${localId}`
    seenKeys.add(key)
    const previous = existingByKey.get(key)
    if (previous && previous.sourceKey) {
      next.push({
        ...previous,
        hash,
        updatedAt: previous.hash === hash ? previous.updatedAt : now,
      })
      return
    }
    next.push({
      key,
      table,
      localId,
      sourceKey: fallbackSourceKey,
      origin: 'local-catalog',
      hash,
      updatedAt: now,
    })
  }

  for (const sheet of sheets) {
    push('sheets', sheet.id, sheet.sourceKey ?? sheet.id, hashCanonical(canonicalOfLocalSheet(sheet)))
  }
  for (const scan of scans) {
    push(
      'scans',
      scan.id,
      scan.sourceKey ?? scan.id,
      hashCanonical(canonicalOfLocalScan(scan, codeById.get(scan.sheetId) ?? '')),
    )
  }
  for (const pair of pairs) {
    push(
      'placePairs',
      pair.id,
      pair.sourceKey ?? pair.id,
      hashCanonical(canonicalOfLocalPlace(pair, codeById.get(pair.sheetId) ?? '')),
    )
  }

  const staleKeys = existing
    .map((meta) => meta.key)
    .filter((key) => !seenKeys.has(key))

  await db.transaction('rw', db.contentMeta, async () => {
    if (next.length) {
      await db.contentMeta.bulkPut(next)
    }
    if (staleKeys.length) {
      await db.contentMeta.bulkDelete(staleKeys)
    }
  })
}
