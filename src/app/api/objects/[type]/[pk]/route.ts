// GET /api/objects/[type]/[pk] — single object instance + its links in BOTH
// directions (outgoing: this type -> other; incoming: other -> this).
// R14.8: each link entry carries direction, `total` (all related instances),
// `fkProperty` (one-to-many, for "view all" deep links) and up to 5 sample
// targets [{pk, _title}].
// Governance: the object's row values are masked per the caller's role
// (additive "_masked" lists the masked columns) and link target titles are
// masked too when the target type's title column is marked above the role.

import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, parseJsonSafe, serverError } from '@/lib/api-utils'
import { getDatasetVersion, resolveConsumerVersion, type Row } from '@/lib/dataset-service'
import { findObjectType, getLinksFor, looseEqual } from '@/lib/ontology-service'
import { applyMasking, getRole, maskedColumnsFor, MASK_LITERAL } from '@/lib/governance'
import type { LinkEntry } from '@/lib/ontology-service'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

/** Mask link-target titles whose backing column is marked above the role. */
async function maskLinkTitles(
  links: LinkEntry[],
  full: {
    outgoingLinks: Array<{ id: string; toType: { id: string; primaryKey: string | null; sourceDatasetId: string | null; properties: Array<{ apiName: string; isTitle: boolean }> } | null }>
    incomingLinks: Array<{ id: string; fromType: { id: string; primaryKey: string | null; sourceDatasetId: string | null; properties: Array<{ apiName: string; isTitle: boolean }> } | null }>
  } | null,
  role: string,
): Promise<LinkEntry[]> {
  if (!full || links.length === 0) return links

  // link id -> other-side type (title column + backing dataset)
  const otherByLinkId = new Map<string, { primaryKey: string | null; sourceDatasetId: string | null; properties: Array<{ apiName: string; isTitle: boolean }> }>()
  for (const l of full.outgoingLinks) if (l.toType) otherByLinkId.set(l.id, l.toType)
  for (const l of full.incomingLinks) if (l.fromType) otherByLinkId.set(l.id, l.fromType)

  // datasetId -> set of masked column names for this role (cached per dataset)
  const maskedByDataset = new Map<string, Set<string>>()

  return Promise.all(
    links.map(async (entry) => {
      const other = otherByLinkId.get(entry.id)
      const titleColumn = other
        ? (other.properties.find((p) => p.isTitle)?.apiName ?? other.primaryKey)
        : null
      if (!other?.sourceDatasetId || !titleColumn) return entry

      let masked = maskedByDataset.get(other.sourceDatasetId)
      if (!masked) {
        masked = new Set(await maskedColumnsFor(other.sourceDatasetId, role))
        maskedByDataset.set(other.sourceDatasetId, masked)
      }
      if (!masked.has(titleColumn)) return entry

      return { ...entry, targets: entry.targets.map((t) => ({ ...t, _title: MASK_LITERAL })) }
    }),
  )
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ type: string; pk: string }> }) {
  try {
    const { type, pk } = await params
    const role = getRole(req)

    const objectType = await findObjectType(type)
    if (!objectType) return notFound(`Object type '${type}' not found`)
    if (!objectType.primaryKey) {
      return badRequest(`Object type '${objectType.apiName}' has no primary key configured`)
    }
    if (!objectType.sourceDatasetId) {
      return notFound(`Object type '${objectType.apiName}' has no backing dataset`)
    }

    // P2: consumer read — gated datasets serve the last published version.
    const consumer = await resolveConsumerVersion(objectType.sourceDatasetId)
    const version = consumer?.versionNumber == null
      ? null
      : await getDatasetVersion(objectType.sourceDatasetId, consumer.versionNumber)
    if (!version) {
      return notFound(`Dataset for object type '${objectType.apiName}' has no versions`)
    }

    const rows = parseJsonSafe<Row[]>(version.dataJson, [])
    const row = rows.find((r) => looseEqual(r[objectType.primaryKey as string], pk))
    if (!row) {
      return notFound(`Object '${pk}' not found in type '${objectType.apiName}'`)
    }
    const pkValue = row[objectType.primaryKey]

    // Full type incl. both link directions (other side types with properties
    // so link targets can resolve their titles).
    const full = await db.objectType.findUnique({
      where: { id: objectType.id },
      include: {
        properties: true,
        outgoingLinks: { include: { toType: { include: { properties: true } } } },
        incomingLinks: { include: { fromType: { include: { properties: true } } } },
      },
    })
    let links = full ? await getLinksFor(full, pkValue) : []
    links = await maskLinkTitles(links, full ?? null, role)

    // Mask the object's own values per role (single row).
    const { rows: [maskedRow], maskedColumns } = await applyMasking(objectType.sourceDatasetId, [row], role)

    return jsonOk({
      objectType: {
        id: objectType.id,
        apiName: objectType.apiName,
        displayName: objectType.displayName,
        primaryKey: objectType.primaryKey,
        icon: objectType.icon,
        color: objectType.color,
        titleProperty:
          objectType.properties.find((p) => p.isTitle)?.apiName ?? objectType.primaryKey ?? null,
      },
      object: { pk: maskedRow?.[objectType.primaryKey] ?? null, values: maskedRow, _masked: maskedColumns },
      links,
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load object')
  }
}
