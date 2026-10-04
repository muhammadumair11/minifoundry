// POST /api/datasets/[id]/publish — publish a DRAFT version of a gated
// dataset (P2 trust workflow). Editor+ only; audited. Body:
//   { versionNumber?: number }  — defaults to the latest draft.
// Blocked with 403 + reasons when error-severity quality rules failed on the
// version (that is the gate doing its job).

import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { badRequest, jsonError, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import {
  PublicationError,
  latestDraftVersion,
  publishDatasetVersion,
} from '@/lib/publication'
import { createNotification } from '@/lib/notify'

export const dynamic = 'force-dynamic'

const publishSchema = z.object({
  versionNumber: z.number().int().positive().optional(),
})

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params

    let body: unknown = {}
    try {
      body = await req.json()
    } catch {
      body = {} // empty body = publish latest draft
    }
    const parsed = publishSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const target =
      parsed.data.versionNumber ?? (await latestDraftVersion(id))
    if (target == null) {
      return badRequest('No draft version to publish (new versions on gated datasets become drafts)')
    }

    try {
      const outcome = await publishDatasetVersion(id, target)
      audit({
        req,
        action: 'dataset.publish',
        resourceType: 'dataset',
        resourceId: id,
        resourceName: outcome.datasetName,
        detail: `v${outcome.versionNumber} published (quality state: ${outcome.qualityState}) — consumers now read v${outcome.publishedVersion}`,
      })
      await createNotification({
        type: 'system',
        title: `Published: ${outcome.datasetName} v${outcome.versionNumber}`,
        body: `Quality gate ${outcome.qualityState === 'passed' ? 'passed' : `state '${outcome.qualityState}'`} — consumers now read v${outcome.publishedVersion}.`,
        resourceType: 'dataset',
        resourceId: id,
        href: `/datasets/${id}`,
      })
      return jsonOk(outcome)
    } catch (err) {
      if (err instanceof PublicationError) {
        return jsonError(err.status, err.message, { reasons: err.reasons })
      }
      throw err
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to publish version')
  }
}
