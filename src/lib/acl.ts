// MiniFoundry — R14 per-resource ACL checks.
//
// SEMANTICS (learning-scale, elevation-only):
//   - admin global role: everything allowed.
//   - global roles grant a BASELINE level: admin > editor > viewer.
//   - a ResourceAcl row ELEVATES a specific user on ONE resource
//     (e.g. global viewer + editor ACL on dataset X → can edit dataset X).
//   - "owner" need = managing ACLs for the resource (admin or explicit owner).
//   - never throws; on any error returns false for elevated needs.

import { db } from '@/lib/db'

export type AclLevel = 'viewer' | 'editor' | 'owner'
export type AclResourceType = 'dataset' | 'pipeline' | 'dashboard'

const ORDER: Record<AclLevel, number> = { viewer: 0, editor: 1, owner: 2 }

function levelAtLeast(level: string, need: AclLevel): boolean {
  const l = ORDER[level as AclLevel]
  return l !== undefined && l >= ORDER[need]
}

export interface AccessCheck {
  role: string
  email?: string | null
  resourceType: AclResourceType
  resourceId: string
  need: AclLevel
}

/**
 * Can this actor access the resource at the requested level?
 * Baseline from the global role, elevated by a per-resource ACL row.
 */
export async function canAccessResource(check: AccessCheck): Promise<boolean> {
  if (check.role === 'admin') return true
  const baseline: AclLevel = check.role === 'editor' ? 'editor' : 'viewer'
  if (levelAtLeast(baseline, check.need)) return true

  if (!check.email) return false
  try {
    const acl = await db.resourceAcl.findUnique({
      where: {
        resourceType_resourceId_userEmail: {
          resourceType: check.resourceType,
          resourceId: check.resourceId,
          userEmail: check.email,
        },
      },
      select: { level: true },
    })
    return acl ? levelAtLeast(acl.level, check.need) : false
  } catch (error) {
    console.error('[acl] check failed:', error)
    return false
  }
}

/**
 * Effective levels for LISTING UI (e.g. detail pages showing editable badges).
 * Returns the strongest level the actor holds.
 */
export async function effectiveResourceLevel(
  role: string,
  email: string | null | undefined,
  resourceType: AclResourceType,
  resourceId: string,
): Promise<AclLevel> {
  if (role === 'admin') return 'owner'
  if (role === 'editor') return 'editor'
  if (!email) return 'viewer'
  try {
    const acl = await db.resourceAcl.findUnique({
      where: {
        resourceType_resourceId_userEmail: {
          resourceType,
          resourceId,
          userEmail: email,
        },
      },
      select: { level: true },
    })
    return (acl?.level as AclLevel) ?? 'viewer'
  } catch {
    return 'viewer'
  }
}
