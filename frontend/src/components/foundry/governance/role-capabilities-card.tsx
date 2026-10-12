import { useQuery } from '@tanstack/react-query'
import { Check, Minus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { apiJson } from '@/lib/foundry-api'
import type { SessionResponse } from '@/lib/foundry-types'
import { ORGANIZATION_ROLES, grantableRoles, canViewMembers, roleLabel } from '@/lib/permissions'

export function RoleCapabilitiesCard() {
  const { data: session } = useQuery<SessionResponse>({ queryKey: ['session'], queryFn: () => apiJson('/api/session'), staleTime: 30_000 })
  return <Card>
    <CardHeader><CardTitle className="text-sm">Organization roles & permissions</CardTitle>
      <p className="text-xs text-muted-foreground">Your role: {session?.organizationRole ? roleLabel(session.organizationRole) : 'Loading…'}. Permissions apply to the active organization.</p>
    </CardHeader>
    <CardContent className="overflow-x-auto">
      <Table><TableHeader><TableRow>
        {['Role', 'Read data', 'Edit data', 'View members', 'Invite & assign roles', 'Governance & tokens'].map((label) => <TableHead key={label} className="text-xs">{label}</TableHead>)}
      </TableRow></TableHeader><TableBody>{ORGANIZATION_ROLES.map((role) => {
        const admin = role === 'owner' || role === 'org_admin'
        const values = [true, admin || role === 'editor', canViewMembers(role), grantableRoles(role).length > 0, admin]
        return <TableRow key={role} className={role === session?.organizationRole ? 'bg-muted' : ''}>
          <TableCell className="text-xs font-medium">{roleLabel(role)}</TableCell>
          {values.map((allowed, index) => <TableCell key={index}>{allowed ? <Check className="size-4 text-emerald-600" aria-label="Allowed" /> : <Minus className="size-4 text-muted-foreground" aria-label="Not allowed" />}</TableCell>)}
        </TableRow>
      })}</TableBody></Table>
      <p className="mt-3 text-xs text-muted-foreground">Access Managers can invite and change Editors and Viewers. Auditors can inspect members but cannot change them. Ownership and your own role cannot be changed here.</p>
    </CardContent>
  </Card>
}
