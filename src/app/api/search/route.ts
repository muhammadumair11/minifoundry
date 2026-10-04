// GET /api/search?q= — global platform search (any role).
//
// Substring case-insensitive across: datasets (name, description), pipelines
// (name), transforms (name), object types (displayName + apiName), object
// INSTANCES (title property values of each object type's backing dataset,
// latest version, capped at 5 hits per type), dashboards (title) and
// connectors (name). Max 20 results total. No caching (force-dynamic) but the
// queries are cheap: metadata searches select id/name-only columns; the
// object-instance search reads only the head dataJson of the (few) object
// types' source datasets.

import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { jsonOk, parseJsonSafe, serverError } from '@/lib/api-utils'
import type { Row } from '@/lib/dataset-service'
import type { SearchResultItem, SearchResponse } from '@/lib/foundry-types'

export const dynamic = 'force-dynamic'

/** Total result cap and per-object-type instance cap. */
const MAX_RESULTS = 20
const MAX_OBJECT_HITS_PER_TYPE = 5

/**
 * Object-instance search: match the title column of the object type's backing
 * dataset head version. Cheap by design — only object types (≈3 rows) are
 * scanned, one version read each, matches capped per type.
 */
async function searchObjectInstances(
  needle: string,
  budget: number,
): Promise<SearchResultItem[]> {
  if (budget <= 0) return []
  const types = await db.objectType.findMany({
    where: { sourceDatasetId: { not: null } },
    select: {
      id: true,
      apiName: true,
      displayName: true,
      sourceDatasetId: true,
      primaryKey: true,
      properties: {
        where: { isTitle: true },
        select: { apiName: true },
        take: 1,
      },
    },
  })

  const hits: SearchResultItem[] = []
  const seenGlobal = new Set<string>()
  for (const t of types) {
    if (hits.length >= budget) break
    const headVersion = await db.datasetVersion.findFirst({
      where: { datasetId: t.sourceDatasetId ?? '' },
      orderBy: { versionNumber: 'desc' },
      select: { dataJson: true },
    })
    if (!headVersion) continue
    const rows = parseJsonSafe<Row[]>(headVersion.dataJson, [])
    if (rows.length === 0) continue
    const titleColumn = t.properties[0]?.apiName ?? t.primaryKey
    if (!titleColumn) continue
    // Data rows often repeat a title (e.g. many shipments of one product) —
    // keep one hit per unique title per type, capped per type.
    const seenTitles = new Set<string>()
    for (const row of rows) {
      if (hits.length >= budget || seenTitles.size >= MAX_OBJECT_HITS_PER_TYPE) break
      const title = row[titleColumn]
      if (title === null || title === undefined) continue
      const titleText = String(title)
      if (!titleText.toLowerCase().includes(needle)) continue
      if (seenTitles.has(titleText)) continue
      seenTitles.add(titleText)
      const dedupeKey = `${t.apiName}|${titleText}`
      if (seenGlobal.has(dedupeKey)) continue
      seenGlobal.add(dedupeKey)
      // objects page supports ?pk= deep-linking onto the instance row — the
      // pk is the type's primary-key value, not the (repeatable) title
      const pk = t.primaryKey ? row[t.primaryKey] : null
      const href =
        pk !== null && pk !== undefined
          ? `/objects/${t.apiName}?pk=${encodeURIComponent(String(pk))}`
          : `/objects/${t.apiName}`
      hits.push({
        type: 'object',
        id: `${t.id}:${titleText}`,
        title: titleText,
        subtitle: t.displayName,
        href,
      })
    }
  }
  return hits
}

export async function GET(req: NextRequest) {
  try {
    const q = (new URL(req.url).searchParams.get('q') ?? '').trim()
    if (q.length < 1) return jsonOk<SearchResponse>({ results: [] })
    const needle = q.toLowerCase()

    // Cheap metadata lookups (id/name-only selects) — SQLite LIKE via Prisma
    // `contains` is case-insensitive for ASCII, matching our substring intent.
    const [datasets, pipelines, transforms, objectTypes, dashboards, connectors] =
      await Promise.all([
        db.dataset.findMany({
          where: { OR: [{ name: { contains: q } }, { description: { contains: q } }] },
          select: { id: true, name: true, description: true },
          take: 10,
          orderBy: { updatedAt: 'desc' },
        }),
        db.pipeline.findMany({
          where: { name: { contains: q } },
          select: { id: true, name: true, description: true },
          take: 10,
          orderBy: { updatedAt: 'desc' },
        }),
        db.transform.findMany({
          where: { name: { contains: q } },
          select: { id: true, name: true, description: true },
          take: 10,
          orderBy: { name: 'asc' },
        }),
        db.objectType.findMany({
          where: { OR: [{ displayName: { contains: q } }, { apiName: { contains: q } }] },
          select: { id: true, apiName: true, displayName: true, description: true },
          take: 10,
          orderBy: { displayName: 'asc' },
        }),
        db.dashboard.findMany({
          where: { OR: [{ title: { contains: q } }, { description: { contains: q } }] },
          select: { id: true, title: true, description: true },
          take: 10,
          orderBy: { updatedAt: 'desc' },
        }),
        db.connector.findMany({
          where: { name: { contains: q } },
          select: { id: true, name: true, type: true },
          take: 10,
          orderBy: { name: 'asc' },
        }),
      ])

    const results: SearchResultItem[] = [
      ...datasets.map<SearchResultItem>((d) => ({
        type: 'dataset',
        id: d.id,
        title: d.name,
        subtitle: d.description,
        href: `/datasets/${d.id}`,
      })),
      ...pipelines.map<SearchResultItem>((p) => ({
        type: 'pipeline',
        id: p.id,
        title: p.name,
        subtitle: p.description,
        href: `/pipelines/${p.id}`,
      })),
      ...transforms.map<SearchResultItem>((t) => ({
        type: 'transform',
        id: t.id,
        title: t.name,
        subtitle: t.description,
        href: '/transforms',
      })),
      ...objectTypes.map<SearchResultItem>((o) => ({
        type: 'objectType',
        id: o.id,
        title: o.displayName,
        subtitle: o.description ?? o.apiName,
        href: `/objects/${o.apiName}`,
      })),
    ]

    // Object instances fill whatever budget the metadata results left.
    const instances = await searchObjectInstances(needle, MAX_RESULTS - results.length)
    results.push(...instances)

    results.push(
      ...dashboards.map<SearchResultItem>((d) => ({
        type: 'dashboard',
        id: d.id,
        title: d.title,
        subtitle: d.description,
        href: `/dashboards/${d.id}`,
      })),
      ...connectors.map<SearchResultItem>((c) => ({
        type: 'connector',
        id: c.id,
        title: c.name,
        subtitle: c.type,
        href: '/connectors',
      })),
    )

    return jsonOk<SearchResponse>({ results: results.slice(0, MAX_RESULTS) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Search failed')
  }
}
