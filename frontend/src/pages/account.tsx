'use client'

// /account — signed-in identity + password management.
// Identity card from GET /api/auth/me; password change posts to
// POST /api/auth/password ({ currentPassword, newPassword }) and surfaces
// the exact server error inline. Other devices sign out within the 15-minute
// access-token TTL (their refresh tokens are revoked immediately).

import { useMemo, useState } from 'react'
import Link from '@/components/link'
import { useRouter } from '@/lib/next-navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { KeyRound, Loader2, LogOut, ShieldCheck, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { RoleBadge } from '@/components/foundry/governance/role-badge'
import { invalidateAuthBootstrap } from '@/routes/__root'
import type { MeResponse } from '@/lib/foundry-types'

const MIN_PASSWORD = 8

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function AccountPage() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const meQuery = useQuery<MeResponse>({
    queryKey: ['auth-me'],
    queryFn: () => apiJson<MeResponse>('/api/auth/me'),
  })

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const user = meQuery.data?.authenticated ? meQuery.data.user : null

  const clientIssue = useMemo(() => {
    if (!next) return null
    if (next.length < MIN_PASSWORD) return `New password must be at least ${MIN_PASSWORD} characters.`
    if (confirm && confirm !== next) return 'Passwords do not match.'
    return null
  }, [next, confirm])

  const changeMutation = useMutation({
    mutationFn: () =>
      apiSend<{ ok: true }>('/api/auth/password', 'POST', {
        currentPassword: current,
        newPassword: next,
      }),
    onSuccess: () => {
      toast.success('Password changed', {
        description: 'Other devices are signed out as their sessions expire.',
      })
      setCurrent('')
      setNext('')
      setConfirm('')
      setFormError(null)
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : 'Could not change password')
    },
  })

  const logoutMutation = useMutation({
    mutationFn: () => apiSend<{ ok: true }>('/api/auth/logout', 'POST'),
    onSuccess: async () => {
      invalidateAuthBootstrap()
      queryClient.clear()
      toast.success('Signed out')
      router.replace('/login')
    },
    onError: (err) => toastApiError(err, 'Could not sign out'),
  })

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-sm font-medium tracking-tight text-foreground">Account</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Your identity, role and password on this MiniFoundry workspace.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => logoutMutation.mutate()}
          disabled={logoutMutation.isPending || !user}
        >
          {logoutMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <LogOut className="h-3.5 w-3.5" aria-hidden />
          )}
          Sign out
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* ── Identity ─────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="gap-1 p-5">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden />
              Identity
            </CardTitle>
            <CardDescription className="text-xs">
              How the platform sees you — every role guard, marking and audit entry uses this.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 p-5 pt-0 text-sm">
            {meQuery.isLoading && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> loading…
              </p>
            )}
            {!meQuery.isLoading && !user && (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                You are browsing in <span className="font-mono">demo mode</span> — anonymous
                sandbox identity.{' '}
                <Link href="/login" className="font-medium text-foreground underline-offset-2 hover:underline">
                  Sign in
                </Link>{' '}
                or{' '}
                <Link href="/signup" className="font-medium text-foreground underline-offset-2 hover:underline">
                  create an account
                </Link>{' '}
                to get a real identity.
              </div>
            )}
            {user && (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">Name</span>
                  <span className="truncate font-medium text-foreground">{user.name}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">Email</span>
                  <span className="truncate font-mono text-xs text-foreground">{user.email}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">Role</span>
                  <RoleBadge role={user.role} />
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">Last sign-in</span>
                  <span className="font-mono text-xs text-foreground">
                    {fmtDate(user.lastLoginAt)}
                  </span>
                </div>
                {user.role === 'admin' && (
                  <>
                    <Separator />
                    <p className="flex items-start gap-2 pt-1 text-xs text-muted-foreground">
                      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      Admins manage users, roles and activation in{' '}
                      <Link
                        href="/governance"
                        className="font-medium text-foreground underline-offset-2 hover:underline"
                      >
                        Governance → Users
                      </Link>
                      .
                    </p>
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* ── Password ─────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="gap-1 p-5">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden />
              Change password
            </CardTitle>
            <CardDescription className="text-xs">
              Minimum {MIN_PASSWORD} characters. Changing it revokes sessions on your other
              devices.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-5 pt-0">
            {!user ? (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                Password management requires a signed-in account (demo-mode anonymous sessions
                have no password).
              </p>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!current || !next) {
                    setFormError('Fill in your current password and the new one.')
                    return
                  }
                  if (clientIssue) {
                    setFormError(clientIssue)
                    return
                  }
                  setFormError(null)
                  if (!changeMutation.isPending) changeMutation.mutate()
                }}
                className="grid gap-3.5"
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="pw-current" className="text-xs text-muted-foreground">
                    Current password
                  </Label>
                  <Input
                    id="pw-current"
                    type="password"
                    autoComplete="current-password"
                    value={current}
                    onChange={(e) => {
                      setCurrent(e.target.value)
                      setFormError(null)
                    }}
                    className="h-10"
                    required
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="pw-new" className="text-xs text-muted-foreground">
                    New password
                  </Label>
                  <Input
                    id="pw-new"
                    type="password"
                    autoComplete="new-password"
                    value={next}
                    onChange={(e) => {
                      setNext(e.target.value)
                      setFormError(null)
                    }}
                    minLength={MIN_PASSWORD}
                    className="h-10"
                    required
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="pw-confirm" className="text-xs text-muted-foreground">
                    Confirm new password
                  </Label>
                  <Input
                    id="pw-confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => {
                      setConfirm(e.target.value)
                      setFormError(null)
                    }}
                    minLength={MIN_PASSWORD}
                    className="h-10"
                    required
                    aria-invalid={Boolean(confirm) && confirm !== next}
                  />
                  {confirm && confirm !== next && (
                    <p className="font-mono text-[11px] text-rose-600 dark:text-rose-400">
                      passwords do not match
                    </p>
                  )}
                </div>

                {formError && (
                  <p
                    role="alert"
                    className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-600 dark:text-rose-400"
                  >
                    {formError}
                  </p>
                )}

                <Button
                  type="submit"
                  disabled={changeMutation.isPending || Boolean(clientIssue)}
                  className="h-10"
                >
                  {changeMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <KeyRound className="h-4 w-4" aria-hidden />
                  )}
                  Update password
                </Button>
                <p className="font-mono text-[11px] leading-relaxed text-muted-foreground/80">
                  scrypt-hashed · other devices keep working up to 15 minutes (access-token TTL)
                  before their refresh is rejected
                </p>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
