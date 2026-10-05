import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import { linkConfigSchema, normalizedLinkConfig, validateLinkConfig } from '@/lib/ontology-link-config'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Context) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied
    const { id } = await params
    const existing = await db.linkType.findUnique({ where: { id } })
    if (!existing) return notFound(`Link '${id}' not found`)
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
    if (taken && taken.id !== id) return badRequest(`Link API name '${input.apiName}' already exists on this source type`)
    const link = await db.linkType.update({ where: { id }, data: normalizedLinkConfig(input) })
    audit({ req, action: 'ontology.link.update', resourceType: 'ontology', resourceId: id,
      resourceName: link.displayName, detail: `${link.fromTypeId} -> ${link.toTypeId}` })
    return jsonOk({ link })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update link')
  }
}

export async function DELETE(req: NextRequest, { params }: Context) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied
    const { id } = await params
    const existing = await db.linkType.findUnique({ where: { id } })
    if (!existing) return notFound(`Link '${id}' not found`)
    await db.linkType.delete({ where: { id } })
    audit({ req, action: 'ontology.link.delete', resourceType: 'ontology', resourceId: id,
      resourceName: existing.displayName, detail: `${existing.fromTypeId} -> ${existing.toTypeId}` })
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete link')
  }
}
