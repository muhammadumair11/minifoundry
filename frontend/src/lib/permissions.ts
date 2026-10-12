import type { SessionResponse } from '@/lib/foundry-types'

export const ORGANIZATION_ROLES = ['owner', 'org_admin', 'access_manager', 'auditor', 'editor', 'viewer'] as const
export type OrganizationRole = typeof ORGANIZATION_ROLES[number]

export function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    owner: 'Organization Owner', org_admin: 'Organization Admin',
    access_manager: 'Access Manager', auditor: 'Auditor', editor: 'Editor', viewer: 'Viewer',
    admin: 'Admin', anonymous: 'Signed out',
  }
  return labels[role] ?? role
}

export function grantableRoles(role?: string | null): OrganizationRole[] {
  if (role === 'owner' || role === 'org_admin') return ORGANIZATION_ROLES.filter((value) => value !== 'owner')
  if (role === 'access_manager') return ['editor', 'viewer']
  return []
}

export function canViewMembers(role?: string | null): boolean {
  return role === 'auditor' || grantableRoles(role).length > 0
}

export function canChangeMember(actorRole: string | null | undefined, targetRole: string): boolean {
  return grantableRoles(actorRole).includes(targetRole as OrganizationRole)
}

export function permissions(session?: SessionResponse) {
  const role = session?.role
  return {
    canEdit: role === 'admin' || role === 'editor',
    canAdminister: role === 'admin',
    canViewMembers: canViewMembers(session?.organizationRole),
    canManageMembers: grantableRoles(session?.organizationRole).length > 0,
    canReset: Boolean(session?.demoMode && role === 'admin'),
    canAudit: role === 'admin' || session?.organizationRole === 'auditor',
  }
}
