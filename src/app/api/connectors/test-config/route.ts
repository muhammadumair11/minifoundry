// POST /api/connectors/test-config — dry-run fetch WITHOUT a saved connector
// (R14 14-b). The new-connector dialog uses this for "Test connection" before
// the connector exists. No dataset version is created. Always answers 200 with
// ok:false + error for user-caused failures so the dialog can render inline.

import { z } from 'zod'
import { jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { fetchConnectorRows } from '@/lib/real-ingest'
import { requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const testSchema = z.object({
  url: z.string().min(1, 'url is required'),
  format: z.enum(['json', 'csv']).default('json'),
  dataPath: z.string().optional(),
})

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return jsonOk({ ok: false, error: 'Request body must be valid JSON' })
    }
    const parsed = testSchema.safeParse(body)
    if (!parsed.success) return jsonOk({ ok: false, error: zodErrorMessage(parsed) })

    const startedAt = Date.now()
    try {
      const result = await fetchConnectorRows({
        url: parsed.data.url,
        format: parsed.data.format,
        dataPath: parsed.data.dataPath?.trim() || undefined,
      })
      return jsonOk({
        ok: true,
        rowCount: result.rowCount,
        sampleColumns: result.columns,
        durationMs: Date.now() - startedAt,
      })
    } catch (err) {
      return jsonOk({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Test connection failed')
  }
}
