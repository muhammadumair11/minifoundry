import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Copy, Loader2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { canChangeMember, grantableRoles, permissions, roleLabel } from '@/lib/permissions'
import type { SessionResponse } from '@/lib/foundry-types'

type Organization = { id: string; name: string; role: string }
type Member = { id: string; name: string; email: string; role: string; isActive: boolean }

export function OrganizationSettings({ rosterOnly = false }: { rosterOnly?: boolean }) {
  const client = useQueryClient()
  const { data: session } = useQuery<SessionResponse>({ queryKey: ['session'], queryFn: () => apiJson('/api/session'), staleTime: 30_000, refetchInterval: 30_000 })
  const access = permissions(session)
  const { data: organizations } = useQuery<{ organizations: Organization[] }>({
    queryKey: ['organizations'], queryFn: () => apiJson('/api/organizations'), enabled: Boolean(session?.session),
  })
  const organization = organizations?.organizations.find((value) => value.id === session?.organizationId)
  const roles = grantableRoles(session?.organizationRole)
  const members = useQuery<{ members: Member[] }>({
    queryKey: ['organization-members', session?.organizationId], queryFn: () => apiJson('/api/organization/members'),
    enabled: access.canViewMembers, retry: false,
  })
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('viewer')
  const [inviteUrl, setInviteUrl] = useState('')
  useEffect(() => { setInviteUrl(''); setEmail(''); setRole('viewer') }, [session?.organizationId])
  const invite = useMutation({
    mutationFn: () => apiSend<{ invitation: { acceptUrl: string } }>('/api/organization/invitations', 'POST', { email: email.trim(), role }),
    onSuccess: ({ invitation }) => {
      setInviteUrl(new URL(invitation.acceptUrl, window.location.origin).href)
      setEmail('')
      toast.success('Invitation created. Copy the link and share it with the recipient.')
    },
    onError: (error) => toastApiError(error, 'Could not invite member'),
  })
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => apiSend(`/api/organization/members/${id}`, 'PATCH', { role }),
    onSuccess: () => {
      toast.success('Organization role updated')
      void client.invalidateQueries({ queryKey: ['organization-members'] })
      void client.invalidateQueries({ queryKey: ['session'] })
      void client.invalidateQueries({ queryKey: ['organizations'] })
    },
    onError: (error) => toastApiError(error, 'Could not change role'),
  })
  if (!session?.session || (rosterOnly && !access.canViewMembers)) return null
  return (
    <section id={rosterOnly ? 'governance-members' : 'organization'} className="scroll-mt-20" aria-label="Organization and members">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{access.canViewMembers ? 'Organization & members' : 'Organization'}</h2>
      <Card className="py-0"><CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Building2 className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-sm font-semibold">{organization?.name ?? 'Your organization'}</span>
          <span className="rounded bg-primary/10 px-2 py-1 text-xs text-primary">{roleLabel(session.organizationRole ?? '')}</span>
        </div>
        {access.canManageMembers && <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <div><h3 className="text-sm font-medium">Invite people to this organization</h3><p className="text-xs text-muted-foreground">Create a link for a new or existing account. Invitations expire after seven days.</p></div>
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); if (!invite.isPending && roles.includes(role as typeof roles[number])) invite.mutate() }}>
            <Input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} aria-label="Invitee email" placeholder="colleague@example.com" disabled={invite.isPending} />
            <Select value={role} onValueChange={setRole} disabled={invite.isPending}><SelectTrigger className="sm:w-48" aria-label="Invitation role"><SelectValue /></SelectTrigger><SelectContent>{roles.map((value) => <SelectItem key={value} value={value}>{roleLabel(value)}</SelectItem>)}</SelectContent></Select>
            <Button type="submit" disabled={invite.isPending}>{invite.isPending ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />} Invite</Button>
          </form>
          {inviteUrl && <div className="space-y-1"><Label htmlFor="created-invitation">Share this invitation link</Label><div className="flex gap-2"><Input id="created-invitation" readOnly value={inviteUrl} /><Button variant="outline" aria-label="Copy invitation link" onClick={async () => { try { await navigator.clipboard.writeText(inviteUrl); toast.success('Link copied') } catch { toast.error('Select and copy the link above') } }}><Copy className="size-4" /></Button></div></div>}
        </div>}
        {access.canViewMembers && <div className="space-y-2">
          <h3 className="text-sm font-medium">Members</h3>
          {members.isLoading && <p className="text-sm text-muted-foreground">Loading members…</p>}
          {members.isError && <p role="alert" className="text-sm text-destructive">{members.error.message}</p>}
          {members.data?.members.map((member) => <div key={member.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2">
            <div className="min-w-0"><p className="truncate text-sm font-medium">{member.name}{member.email === session.session?.email ? ' (you)' : ''}</p><p className="truncate text-xs text-muted-foreground">{member.email}{!member.isActive ? ' · Inactive membership' : ''}</p></div>
            {member.isActive && member.email !== session.session?.email && canChangeMember(session.organizationRole, member.role) ? <Select value={member.role} disabled={changeRole.isPending} onValueChange={(role) => changeRole.mutate({ id: member.id, role })}><SelectTrigger className="w-48" aria-label={`Role for ${member.name}`}><SelectValue /></SelectTrigger><SelectContent>{roles.map((value) => <SelectItem key={value} value={value}>{roleLabel(value)}</SelectItem>)}</SelectContent></Select> : <span className="text-xs text-muted-foreground">{roleLabel(member.role)}</span>}
          </div>)}
        </div>}
      </CardContent></Card>
    </section>
  )
}
