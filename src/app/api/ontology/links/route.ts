import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import { linkConfigSchema, normalizedLinkConfig, validateLinkConfig } from '@/lib/ontology-link-config'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied
    let body: unknown
    try { body = await req.json() } catch { return badRequest('Request body must be valid JSON') }
    const parsed = linkConfigSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const input = parsed.data
    const error = await validateLinkConfig(input)
    if (error) return badRequest(error)
    const taken = await db.linkType.findUnique({
      where: { fromTypeId_apiName: { fromTypeId: input.fromTypeId, apiName: input.apiName } },
    })
    if (taken) return badRequest(`Link API name '${input.apiName}' already exists on this source type`)
    const link = await db.linkType.create({ data: normalizedLinkConfig(input) })
    audit({ req, action: 'ontology.link.create', resourceType: 'ontology', resourceId: link.id,
      resourceName: link.displayName, detail: `${link.fromTypeId} -> ${link.toTypeId}` })
    return jsonOk({ link }, 201)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create link')
  }
}
