// GET  /api/acl?resourceType=&resourceId= — list per-resource grants (any
//      role; the list is non-sensitive, content is not).
// POST /api/acl — upsert one grant (ADMIN only): { resourceType, resourceId,
//      userEmail, level } on the (resourceType, resourceId, userEmail) unique
//      key. The user must exist (400 "unknown user"); level must be
//      viewer|editor|owner.

import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, getActor, requireRole } from '@/lib/governance'
import type { ResourceAclInfo, ResourceAclListResponse } from '@/lib/foundry-types'

export const dynamic = 'force-dynamic'

const RESOURCE_TYPES = ['dataset', 'pipeline', 'dashboard'] as const
type AclResourceType = (typeof RESOURCE_TYPES)[number]

const LEVELS = ['viewer', 'editor', 'owner'] as const

function serialize(acl: {
  id: string
  resourceType: string
  resourceId: string
  userEmail: string
  level: string
  grantedBy: string | null
  createdAt: Date
}): ResourceAclInfo {
  return {
    id: acl.id,
    resourceType: acl.resourceType,
    resourceId: acl.resourceId,
    userEmail: acl.userEmail,
    level: (LEVELS as readonly string[]).includes(acl.level)
      ? (acl.level as ResourceAclInfo['level'])
      : 'viewer',
    grantedBy: acl.grantedBy,
    createdAt: acl.createdAt.toISOString(),
  }
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const resourceType = url.searchParams.get('resourceType') ?? ''
    const resourceId = url.searchParams.get('resourceId') ?? ''
    if (!(RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
      return badRequest(`resourceType must be one of: ${RESOURCE_TYPES.join(', ')}`)
    }
    if (!resourceId) return badRequest('resourceId is required')

    const acls = await db.resourceAcl.findMany({
      where: { resourceType, resourceId },
      orderBy: [{ createdAt: 'asc' }, { userEmail: 'asc' }],
    })

    return jsonOk<ResourceAclListResponse>({ acls: acls.map(serialize) })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to list ACL grants')
  }
}

const createSchema = z.object({
  resourceType: z.enum(RESOURCE_TYPES),
  resourceId: z.string().min(1, 'resourceId is required'),
  userEmail: z.string().min(3, 'userEmail is required').email('userEmail must be an email'),
  level: z.enum(LEVELS),
})

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'admin')
    if (denied) return denied
    const actor = getActor(req)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const { resourceType, resourceId, userEmail, level } = parsed.data

    // The grantee must be a real platform user.
    const user = await db.user.findUnique({ where: { email: userEmail }, select: { email: true } })
    if (!user) return badRequest('unknown user')

    const acl = await db.resourceAcl.upsert({
      where: { resourceType_resourceId_userEmail: { resourceType, resourceId, userEmail } },
      update: { level, grantedBy: actor.email },
      create: { resourceType, resourceId, userEmail, level, grantedBy: actor.email },
    })

    audit({
      req,
      action: 'acl.grant',
      resourceType,
      resourceId,
      resourceName: userEmail,
      detail: `level=${level}`,
    })

    return jsonOk<ResourceAclInfo>(serialize(acl), 201)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to grant ACL')
  }
}
