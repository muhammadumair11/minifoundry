'use client'

// Per-resource ACL management dialog — Task 14-e.
//
// CONTRACT (used by dataset/pipeline detail pages): default export
//   AclDialog({ resourceType, resourceId, canManage, children? })
//   - resourceType: 'dataset' | 'pipeline' | 'dashboard'
//   - canManage:    admin gate from the host page (add/remove grants UI)
//   - children:     optional custom DialogTrigger (a Button); when omitted a
//                   ghost "Access" button with a Users icon is rendered.
// Self-contained data: GET /api/acl (grants), GET /api/acl/check (your
// level), POST /api/acl + DELETE /api/acl/[aclId] (admin only).

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { cn } from '@/lib/utils'
import type { AclCheckResponse, ResourceAclInfo, ResourceAclListResponse } from '@/lib/foundry-types'

type AclResourceType = 'dataset' | 'pipeline' | 'dashboard'
type AclLevel = 'viewer' | 'editor' | 'owner'

const LEVELS: AclLevel[] = ['viewer', 'editor', 'owner']

function levelBadgeClass(level: string): string {
  switch (level) {
    case 'owner':
      return 'bg-primary text-primary-foreground'
    case 'editor':
      return 'border-border bg-accent text-accent-foreground'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export default function AclDialog({
  resourceType,
  resourceId,
  canManage,
  children,
}: {
  resourceType: AclResourceType
  resourceId: string
  canManage: boolean
  children?: React.ReactNode
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [level, setLevel] = useState<AclLevel>('editor')

  const aclKey = ['acl', resourceType, resourceId]
  const checkKey = ['acl-check', resourceType, resourceId]

  const { data: check } = useQuery<AclCheckResponse>({
    queryKey: checkKey,
    queryFn: () =>
      apiJson<AclCheckResponse>(
        `/api/acl/check?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}`,
      ),
    enabled: open,
  })

  const { data, isPending } = useQuery<ResourceAclListResponse>({
    queryKey: aclKey,
    queryFn: () =>
      apiJson<ResourceAclListResponse>(
        `/api/acl?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}`,
      ),
    enabled: open,
  })
  const acls = data?.acls ?? []

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: aclKey })
  }

  const addGrant = useMutation({
    mutationFn: () =>
      apiSend<ResourceAclInfo>('/api/acl', 'POST', { resourceType, resourceId, userEmail: email.trim(), level }),
    onSuccess: (grant) => {
      toast.success(`Access granted: ${grant.userEmail} (${capitalize(grant.level)})`)
      setEmail('')
      invalidate()
    },
    onError: (err) => toastApiError(err, 'Could not grant access'),
  })

  const removeGrant = useMutation({
    mutationFn: (aclId: string) => apiSend<{ ok: boolean }>(`/api/acl/${aclId}`, 'DELETE'),
    onSuccess: () => invalidate(),
    onError: (err) => toastApiError(err, 'Could not revoke access'),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children ?? (
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground hover:text-foreground">
            <Users className="h-4 w-4" aria-hidden />
            Access
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Access control</DialogTitle>
          <DialogDescription className="text-xs">
            Per-user grants elevate teammates on this {resourceType} beyond their global role.
          </DialogDescription>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          Your access:{' '}
          <span className="font-medium text-foreground">
            {capitalize(check?.level ?? '…')}
          </span>
        </p>

        <div className="foundry-scroll max-h-60 overflow-y-auto rounded-md border border-border">
          {isPending ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">Loading grants…</p>
          ) : acls.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              No per-user grants — everyone uses their global role.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {acls.map((acl: ResourceAclInfo) => (
                <li key={acl.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-[13px]">{acl.userEmail}</span>
                  <Badge variant="outline" className={cn('h-5 px-1.5 text-[10px]', levelBadgeClass(acl.level))}>
                    {capitalize(acl.level)}
                  </Badge>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:bg-accent hover:text-rose-600 dark:hover:text-rose-400"
                      aria-label={`Revoke access for ${acl.userEmail}`}
                      onClick={() => removeGrant.mutate(acl.id)}
                      disabled={removeGrant.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {canManage && (
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-center"
            onSubmit={(e) => {
              e.preventDefault()
              if (email.trim()) addGrant.mutate()
            }}
          >
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@minifoundry.dev"
              className="h-8 flex-1 text-[13px]"
              aria-label="User email"
            />
            <Select value={level} onValueChange={(v) => setLevel(v as AclLevel)}>
              <SelectTrigger className="h-8 w-full text-[13px] sm:w-28" aria-label="Access level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEVELS.map((l) => (
                  <SelectItem key={l} value={l} className="text-[13px]">
                    {capitalize(l)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" size="sm" className="h-8 sm:w-16" disabled={addGrant.isPending || !email.trim()}>
              Add
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
