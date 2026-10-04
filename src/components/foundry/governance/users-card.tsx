'use client'

// Governance console — section (e): user management (Task 7-c, M9 real auth).
// Admin-gated: lists seeded/real users with role Select + active Switch.
// The caller's own row is locked (server 400s self role-changes and
// self-deactivation — surfaced as a "you" chip + disabled controls).
// Deactivating another user asks for confirmation; reactivating is immediate.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Loader2,
  LockKeyhole,
  ShieldAlert,
  UserRoundX,
  Users as UsersIcon,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { formatRelative } from '@/lib/foundry-types'
import type {
  AdminUser,
  FoundryRole,
  SessionResponse,
  UserMutationResponse,
  UsersListResponse,
} from '@/lib/foundry-types'
import { cn } from '@/lib/utils'

const ROLES: FoundryRole[] = ['viewer', 'editor', 'admin']

const ROLE_TEXT: Record<FoundryRole, string> = {
  admin: 'text-emerald-600 dark:text-emerald-400',
  editor: 'text-amber-600 dark:text-amber-400',
  viewer: 'text-muted-foreground',
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export function UsersCard() {
  const queryClient = useQueryClient()
  const [deactivating, setDeactivating] = useState<AdminUser | null>(null)

  const { data: session } = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const isAdminRole = session?.role === 'admin'
  const myEmail = session?.session?.email ?? null

  const usersQuery = useQuery<UsersListResponse>({
    queryKey: ['users'],
    queryFn: () => apiJson<UsersListResponse>('/api/users'),
    retry: false,
    enabled: isAdminRole,
  })

  const invalidateUsers = () => {
    queryClient.invalidateQueries({ queryKey: ['users'] })
    queryClient.invalidateQueries({ queryKey: ['audit'] })
  }

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: FoundryRole }) =>
      apiSend<UserMutationResponse>(`/api/users/${id}`, 'PATCH', { role }),
    onSuccess: (res) => {
      toast.success(`Role updated — ${res.user.name} is now ${res.user.role}`)
      invalidateUsers()
    },
    onError: (err) => toastApiError(err, 'Could not update role'),
  })

  const activeMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiSend<UserMutationResponse>(`/api/users/${id}`, 'PATCH', { isActive }),
    onSuccess: (res) => {
      toast.success(
        res.user.isActive ? `${res.user.name} reactivated` : `${res.user.name} deactivated`,
        {
          description: res.user.isActive
            ? 'They can sign in again.'
            : 'Sign-in attempts now fail with 401.',
        },
      )
      invalidateUsers()
      setDeactivating(null)
    },
    onError: (err) => toastApiError(err, 'Could not update user'),
  })

  const users = usersQuery.data?.users ?? []
  const activeCount = users.filter((u) => u.isActive).length

  return (
    <Card>
      <CardHeader className="gap-1.5 border-b border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <UsersIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
            Users
            {!usersQuery.isLoading && isAdminRole && (
              <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
                {activeCount} / {users.length} active
              </span>
            )}
          </CardTitle>
        </div>
        <CardDescription className="text-xs leading-relaxed text-muted-foreground">
          Real identities behind the platform. Role changes and deactivations are audited with your
          email — you cannot change your own account.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!isAdminRole ? (
          // Viewer/editor: muted locked note instead of the admin list.
          <div className="flex flex-col items-center gap-1.5 p-8 text-center">
            <LockKeyhole className="h-6 w-6 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium text-foreground">
              Sign in as an admin to manage users
            </p>
            <p className="text-xs text-muted-foreground/80">
              The user list and its controls require the admin role — try the demo identity Ada
              Admin on the sign-in page.
            </p>
          </div>
        ) : usersQuery.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : usersQuery.isError ? (
          <p className="p-6 text-center text-sm text-rose-600 dark:text-rose-400">
            {usersQuery.error instanceof Error
              ? usersQuery.error.message
              : 'Failed to load users.'}
          </p>
        ) : (
          <div className="foundry-scroll max-h-96 overflow-y-auto">
            <ul className="divide-y divide-border">
              {users.map((u) => {
                const isMe = myEmail !== null && u.email === myEmail
                return (
                  <li key={u.id} className="flex items-center gap-3 px-4 py-3">
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-muted font-mono text-[10px] font-bold text-muted-foreground"
                      aria-hidden
                    >
                      {initialsOf(u.name)}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {u.name}
                        </span>
                        {isMe && (
                          <Badge
                            variant="outline"
                            className="border-emerald-500/40 bg-emerald-500/10 px-1 py-0 font-mono text-[9px] text-emerald-600 dark:text-emerald-400"
                          >
                            you
                          </Badge>
                        )}
                        {u.isActive ? (
                          <span
                            className="inline-flex items-center gap-1.5 font-mono text-[10px] text-emerald-600 dark:text-emerald-400"
                            aria-label="Active user"
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" aria-hidden />
                            Active
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1.5 font-mono text-[10px] text-rose-600 dark:text-rose-400"
                            aria-label="Deactivated user"
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-rose-500 dark:bg-rose-400" aria-hidden />
                            Deactivated
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
                        <span className="truncate">{u.email}</span>
                        <span>last login {formatRelative(u.lastLoginAt)}</span>
                      </div>
                    </div>

                    {/* Role Select — locked on your own row (server 400s it) */}
                    <Select
                      value={u.role}
                      disabled={isMe || roleMutation.isPending}
                      onValueChange={(next) => {
                        if (next !== u.role) roleMutation.mutate({ id: u.id, role: next as FoundryRole })
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label={`Role for ${u.name}`}
                        className={cn(
                          'h-7 w-[104px] shrink-0 gap-1.5 rounded-md px-2 text-xs font-medium data-[size=sm]:h-7',
                          ROLE_TEXT[u.role],
                        )}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="min-w-0">
                        {ROLES.map((r) => (
                          <SelectItem
                            key={r}
                            value={r}
                            className="gap-2 text-xs"
                          >
                            <span className={cn('font-mono', ROLE_TEXT[r])}>{r}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {/* Active toggle — confirm before deactivating someone else */}
                    <span className="flex w-14 shrink-0 items-center justify-end gap-1.5">
                      <Switch
                        checked={u.isActive}
                        disabled={isMe || activeMutation.isPending}
                        onCheckedChange={(next) => {
                          if (next) {
                            activeMutation.mutate({ id: u.id, isActive: true })
                          } else {
                            setDeactivating(u)
                          }
                        }}
                        aria-label={
                          isMe
                            ? 'Your account — cannot be deactivated'
                            : `Toggle active state for ${u.name}`
                        }
                      />
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </CardContent>

      {/* Deactivate confirm */}
      <AlertDialog
        open={!!deactivating}
        onOpenChange={(open) => {
          if (!open) setDeactivating(null)
        }}
      >
        <AlertDialogContent className="bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base text-foreground">
              Deactivate “{deactivating?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground">
              Their sign-ins will immediately fail with 401 until reactivated. You can undo this by
              toggling them back to active.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-muted-foreground hover:text-foreground">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deactivating && activeMutation.mutate({ id: deactivating.id, isActive: false })}
              disabled={activeMutation.isPending}
              className="bg-rose-600 text-white hover:bg-rose-500 dark:bg-rose-500 dark:text-zinc-950 dark:hover:bg-rose-400"
            >
              {activeMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ShieldAlert className="h-4 w-4" aria-hidden />
              )}
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Icon-only legend for the toggle column */}
      <div className="flex items-center gap-1.5 border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground/80">
        <UserRoundX className="h-3 w-3" aria-hidden />
        Toggle deactivates sign-in instantly — your own row is locked.
      </div>
    </Card>
  )
}
