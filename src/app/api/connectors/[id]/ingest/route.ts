// POST /api/connectors/[id]/ingest — REAL ingestion for a rest_url connector
// (R14 14-b). Reuses the platform ingestion flow (Ingestion row → dataset
// version via createDatasetFromRows → audit), but actually fetches the remote
// payload with the 14-b real-ingest library (10s timeout, 2MB cap, JSON/CSV).
// Emits version-created so upstream-triggered pipelines can fire.

import { z } from 'zod'
import { db } from '@/lib/db'
import {
  badRequest,
  jsonOk,
  notFound,
  parseJsonSafe,
  parseSchema,
  serverError,
  zodErrorMessage,
} from '@/lib/api-utils'
import { createDatasetFromRows } from '@/lib/dataset-service'
import { fetchConnectorRows, type RealIngestConfig } from '@/lib/real-ingest'
import { emitVersionCreated } from '@/lib/version-events'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const ingestSchema = z.object({
  datasetName: z.string().min(1).optional(),
})

/** A user-caused failure → 400 (vs unexpected → 500). */
class IngestInputError extends Error {}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const connector = await db.connector.findUnique({ where: { id } })
    if (!connector) return notFound(`Connector '${id}' not found`)

    // Body is optional — { datasetName } defaults to the connector's name.
    let datasetName = connector.name
    try {
      const text = await req.text()
      if (text.trim() !== '') {
        const parsed = ingestSchema.safeParse(JSON.parse(text))
        if (!parsed.success) return badRequest(zodErrorMessage(parsed))
        if (parsed.data.datasetName) datasetName = parsed.data.datasetName
      }
    } catch {
      return badRequest('Request body must be valid JSON')
    }

    const config = parseJsonSafe<Record<string, unknown>>(connector.config, {})
    let ingestConfig: RealIngestConfig
    if (connector.type === 'rest_url') {
      ingestConfig = {
        url: typeof config.url === 'string' ? config.url : '',
        format: config.format === 'csv' ? 'csv' : 'json',
        dataPath: typeof config.dataPath === 'string' && config.dataPath.trim() !== ''
          ? config.dataPath
          : undefined,
      }
      if (!ingestConfig.url) {
        return badRequest('This connector has no URL configured — edit it first')
      }
    } else {
      return badRequest(
        `Real ingestion is only available for rest_url connectors (this one is '${connector.type}')`,
      )
    }

    const ingestion = await db.ingestion.create({
      data: { connectorId: connector.id, status: 'running' },
    })

    try {
      const fetched = await fetchConnectorRows(ingestConfig)
      const sourceDesc = `connector '${connector.name}' (${fetched.format})`

      const { dataset, version, schema, rowCount, truncated } = await createDatasetFromRows({
        name: datasetName,
        connectorId: connector.id,
        createdBy: ingestion.id,
        rows: fetched.rows,
      })

      const message =
        `Ingested ${rowCount} rows from ${sourceDesc} into dataset '${dataset.name}' ` +
        `(v${version.versionNumber}, ${schema.length} columns)` +
        (truncated ? ' — truncated to 5000 rows' : '')

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

      // R14: announce the new version — upstream-triggered pipelines listen.
      await emitVersionCreated({
        datasetId: dataset.id,
        versionNumber: version.versionNumber,
        source: `connector:${connector.name}`,
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
      // Fetch/parse failures are user-caused (bad URL, bad payload) → 400.
      return badRequest(msg)
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to ingest from connector')
  }
}
