// POST /api/ingest — ingest data into a (new) dataset from a sample pack, raw
// CSV/JSON text, or a URL. Creates an Ingestion record + Dataset + DatasetVersion.

import { z } from 'zod'
import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  parseJsonSafe,
  parseSchema,
  serverError,
  zodErrorMessage,
} from '@/lib/api-utils'
import { createDatasetFromRows, type Row } from '@/lib/dataset-service'
import { parseRawText, fetchRowsFromUrl } from '@/lib/parsers'
import { emitVersionCreated } from '@/lib/version-events'
import { SAMPLE_PACKS } from '@/lib/sample-data'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const ingestSchema = z.object({
  connectorId: z.string().optional(),
  type: z.enum(['sample', 'raw', 'url']),
  datasetName: z.string().min(1, 'datasetName is required'),
  raw: z.string().optional(),
  url: z.string().min(1).optional(),
  sampleKey: z.string().optional(),
})

/** A user-caused failure -> 400 (vs unexpected -> 500). */
class IngestInputError extends Error {}

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = ingestSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const { connectorId, type, datasetName, raw, url, sampleKey } = parsed.data

    if (connectorId) {
      const connector = await db.connector.findUnique({ where: { id: connectorId } })
      if (!connector) return badRequest(`Connector '${connectorId}' not found`)
    }

    const ingestion = await db.ingestion.create({
      data: { connectorId: connectorId ?? null, status: 'running' },
    })

    try {
      let rawRows: Row[] = []
      let sourceDesc = ''

      if (type === 'sample') {
        if (!sampleKey) {
          throw new IngestInputError('type "sample" requires a sampleKey')
        }
        const pack = SAMPLE_PACKS[sampleKey]
        if (!pack) {
          throw new IngestInputError(
            `Unknown sampleKey '${sampleKey}' (available: ${Object.keys(SAMPLE_PACKS).join(', ')})`,
          )
        }
        rawRows = pack.rows as Row[]
        sourceDesc = `sample pack '${sampleKey}'`
      } else if (type === 'raw') {
        if (!raw) {
          throw new IngestInputError('type "raw" requires a raw payload (CSV or JSON text)')
        }
        const parsedSource = parseRawText(raw)
        rawRows = parsedSource.rows
        sourceDesc = `raw ${parsedSource.format}`
      } else {
        if (!url) {
          throw new IngestInputError('type "url" requires a url')
        }
        const fetched = await fetchRowsFromUrl(url)
        rawRows = fetched.rows
        sourceDesc = `url (${fetched.format})`
      }

      const { dataset, version, schema, rowCount, truncated } = await createDatasetFromRows({
        name: datasetName,
        connectorId: connectorId ?? null,
        createdBy: ingestion.id,
        rows: rawRows,
      })

      const message =
        `Ingested ${rowCount} rows from ${sourceDesc} into dataset '${dataset.name}' ` +
        `(v${version.versionNumber}, ${schema.length} columns)` +
        (truncated ? ' — truncated to 5000 rows' : '')

      // R14: announce the new version — upstream-triggered pipelines listen.
      // P2: emit for EVERY ingest (connector or raw/url) — the quality
      // auto-evaluator also listens here and must see all new versions.
      let source = 'ingest'
      if (connectorId) {
        const connector = await db.connector.findUnique({
          where: { id: connectorId },
          select: { name: true },
        })
        source = `connector:${connector?.name ?? connectorId}`
      }
      await emitVersionCreated({
        datasetId: dataset.id,
        versionNumber: version.versionNumber,
        source,
      })

      const finished = await db.ingestion.update({
        where: { id: ingestion.id },
        data: {
          datasetId: dataset.id,
          status: 'success',
          rowsIngested: rowCount,
          message,
          finishedAt: new Date(),
        },
      })

      audit({
        req,
        action: 'ingest.complete',
        resourceType: 'dataset',
        resourceId: dataset.id,
        resourceName: dataset.name,
        detail: `ingested ${rowCount} rows from ${sourceDesc} (v${version.versionNumber}, ${schema.length} columns)`,
      })

      return jsonOk({
        ingestion: finished,
        dataset: {
          id: dataset.id,
          name: dataset.name,
          description: dataset.description,
          projectId: dataset.projectId,
          sourceConnectorId: dataset.sourceConnectorId,
          tags: parseJsonSafe<string[]>(dataset.tags, []),
          updatedAt: dataset.updatedAt,
          version: {
            id: version.id,
            versionNumber: version.versionNumber,
            rowCount: version.rowCount,
            columnCount: parseSchema(version).length,
            schema: parseSchema(version),
          },
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await db.ingestion.update({
        where: { id: ingestion.id },
        data: { status: 'failed', message: `Ingestion failed: ${msg}`, finishedAt: new Date() },
      })

      audit({
        req,
        action: 'ingest.failed',
        resourceType: 'dataset',
        resourceName: datasetName,
        detail: msg,
      })

      if (err instanceof IngestInputError) return badRequest(msg)
      return serverError(msg)
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to ingest data')
  }
}
