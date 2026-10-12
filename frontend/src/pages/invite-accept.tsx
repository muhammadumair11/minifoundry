'use client'

// /invite/[token] — invitation acceptance page.
// Public page (no auth required) that shows invitation details and allows
// the recipient to accept by creating an account or signing in.
// On success: auto-login via session cookies + redirect to home.

import { useEffect, useState, useRef, useMemo } from 'react'
import Link from '@/components/link'
import { useParams, useRouter, useSearchParams } from '@/lib/next-navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertCircle,
  Building2,
  CheckCircle,
  Eye,
  EyeOff,
  Loader2,
  Mail,
  Shield,
  User,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { apiSend } from '@/lib/foundry-api'
import { invalidateAuthBootstrap } from '@/routes/__root'
import { cn } from '@/lib/utils'
import type { LoginResponse } from '@/lib/foundry-types'

const MIN_PASSWORD = 8
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface Invitation {
  id: string
  organizationId: string
  organizationName: string
  email: string
  role: string
  expiresAt: string
}

interface AcceptResponse {
  user: {
    id: string
    email: string
    name: string
    role: string
    organizationId: string
  }
}

function safeNext(value: string | null): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/'
}

function formatRole(role: string): { label: string; color: string } {
  const roles: Record<string, { label: string; color: string }> = {
    owner: { label: 'Owner', color: 'bg-amber-100 text-amber-800' },
    org_admin: { label: 'Org Admin', color: 'bg-purple-100 text-purple-800' },
    access_manager: { label: 'Access Manager', color: 'bg-blue-100 text-blue-800' },
    auditor: { label: 'Auditor', color: 'bg-gray-100 text-gray-800' },
    editor: { label: 'Editor', color: 'bg-green-100 text-green-800' },
    viewer: { label: 'Viewer', color: 'bg-sky-100 text-sky-800' },
  }
  return roles[role] || { label: role, color: 'bg-muted text-muted-foreground' }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function InviteAcceptPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const searchParams = useSearchParams()
  const params = useParams()
  const token = params.token as string
  const next = safeNext(searchParams.get('next'))

  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const submitRef = useRef<HTMLButtonElement>(null)

  // Fetch invitation details
  useEffect(() => {
    let cancelled = false
    async function fetchInvitation() {
      try {
        const res = await fetch(`/api/invitations/${token}`)
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || 'Invitation not found')
        }
        const data = await res.json()
        if (!cancelled) {
          setInvitation(data.invitation)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load invitation')
          setLoading(false)
        }
      }
    }
    fetchInvitation()
    return () => { cancelled = true }
  }, [token])

  // Check if already signed in
  useEffect(() => {
    if (invitation) {
      fetch('/api/auth/me')
        .then((res) => (res.ok ? res.json() : null))
        .then((me) => {
          if (me?.authenticated) {
            // User is already signed in - they can accept directly
            // We'll let the form handle this
          }
        })
        .catch(() => {})
    }
  }, [invitation])

  const clientIssue = useMemo(() => {
    if (!name.trim()) return null
    if (password && password.length < MIN_PASSWORD)
      return `Password must be at least ${MIN_PASSWORD} characters.`
    if (confirm && confirm !== password) return 'Passwords do not match.'
    return null
  }, [name, password, confirm])

  const acceptMutation = useMutation({
    mutationFn: () =>
      apiSend<AcceptResponse>(`/api/invitations/${token}/accept`, 'POST', {
        name: name.trim(),
        password,
      }),
    onSuccess: (res) => {
      toast.success(`Welcome to ${invitation?.organizationName}, ${res.user.name}!`, {
        description: `Role: ${res.user.role}`,
      })
      invalidateAuthBootstrap()
      queryClient.invalidateQueries()
      router.replace(next)
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : 'Failed to accept invitation')
    },
  })

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
      </div>
    )
  }

  if (error || !invitation) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <Card className="w-full max-w-md border-rose-500/40 bg-rose-500/10">
          <CardContent className="p-6 text-center">
            <AlertCircle className="h-12 w-12 mx-auto text-rose-500" aria-hidden />
            <CardTitle className="mt-4 text-rose-600">Invitation Not Found</CardTitle>
            <CardDescription className="mt-2 text-muted-foreground">
              {error || 'This invitation link is invalid or has expired.'}
            </CardDescription>
            <div className="mt-6">
              <Link href="/login" className="text-primary hover:underline">
                Sign in instead
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const roleInfo = formatRole(invitation.role)
  const isExpired = new Date(invitation.expiresAt) < new Date()

  return (
    <div className="grid flex-1 lg:grid-cols-2">
      {/* ── LEFT: brand panel (hidden on mobile) ─────────────────────── */}
      <div className="relative hidden overflow-hidden border-r border-border bg-muted/40 lg:flex lg:flex-col lg:justify-center">
        <div className="foundry-grid-bg pointer-events-none absolute inset-0 opacity-60" aria-hidden />
        <div className="relative mx-auto w-full max-w-md px-10">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-foreground font-mono text-lg font-bold text-background">
              ▚
            </span>
            <span className="text-lg font-semibold tracking-tight text-foreground">
              MiniFoundry
            </span>
          </div>
          <p className="mt-5 text-2xl font-semibold leading-snug tracking-tight text-foreground">
            You&apos;ve been invited!
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Join <strong>{invitation.organizationName}</strong> as a <strong>{roleInfo.label}</strong>.
            Accept the invitation to create your account and start collaborating.
          </p>
          <ul className="mt-8 space-y-3.5">
            <li className="flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden />
              </span>
              <span className="text-sm text-foreground">Versioned datasets — every write is a transaction</span>
            </li>
            <li className="flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                <Shield className="h-4 w-4 text-muted-foreground" aria-hidden />
              </span>
              <span className="text-sm text-foreground">Governance — markings, approvals, full audit</span>
            </li>
          </ul>
        </div>
      </div>

      {/* ── RIGHT: acceptance card ────────────────────────────────────── */}
      <div className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <Card className={isExpired ? 'border-rose-500/40 bg-rose-500/10' : ''}>
            <CardHeader className="gap-1.5 p-6">
              <div className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-primary" aria-hidden />
                <CardTitle className="text-base font-medium text-foreground">
                  {invitation.organizationName}
                </CardTitle>
              </div>
              <CardDescription className="text-sm text-muted-foreground">
                Invitation for {invitation.email}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6 pt-0">
              {/* Invitation details */}
              <div className="grid gap-3 mb-4 p-3 rounded-md bg-muted/50">
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground" aria-hidden />
                  <span className="text-muted-foreground">Email:</span>
                  <span className="font-medium text-foreground ml-auto">{invitation.email}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Shield className="h-4 w-4 text-muted-foreground" aria-hidden />
                  <span className="text-muted-foreground">Role:</span>
                  <span className={cn('font-medium px-2 py-0.5 rounded text-xs', roleInfo.color)} ml-auto>
                    {roleInfo.label}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="h-4 w-4 text-muted-foreground" aria-hidden>⏰</span>
                  <span className="text-muted-foreground">Expires:</span>
                  <span className="font-medium text-foreground ml-auto">{formatDate(invitation.expiresAt)}</span>
                </div>
              </div>

              {isExpired && (
                <div className="mb-4 p-3 rounded-md border border-rose-500/40 bg-rose-500/10 text-sm text-rose-600">
                  This invitation has expired. Please request a new one from your organization admin.
                </div>
              )}

              <Separator className="my-4" />

              {/* Accept form */}
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!acceptMutation.isPending && !isExpired) acceptMutation.mutate()
                }}
                className="grid gap-4"
              >
                <div className="grid gap-2">
                  <Label htmlFor="invite-name" className="text-xs text-muted-foreground">
                    Your Name
                  </Label>
                  <Input
                    id="invite-name"
                    type="text"
                    autoComplete="name"
                    placeholder="Your full name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      setFormError(null)
                    }}
                    required
                    disabled={isExpired || acceptMutation.isPending}
                    className="h-11"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="invite-password" className="text-xs text-muted-foreground">
                    Password
                  </Label>
                  <div className="relative">
                    <Input
                      id="invite-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      placeholder="••••••••••••"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value)
                        setFormError(null)
                      }}
                      required
                      disabled={isExpired || acceptMutation.isPending}
                      className="h-11 pr-11"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      disabled={isExpired || acceptMutation.isPending}
                      className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" aria-hidden />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden />
                      )}
                    </button>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="invite-confirm" className="text-xs text-muted-foreground">
                    Confirm Password
                  </Label>
                  <Input
                    id="invite-confirm"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="••••••••••••"
                    value={confirm}
                    onChange={(e) => {
                      setConfirm(e.target.value)
                      setFormError(null)
                    }}
                    required
                    disabled={isExpired || acceptMutation.isPending}
                    className="h-11"
                  />
                </div>

                {(formError || clientIssue) && (
                  <p
                    role="alert"
                    className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-600 dark:text-rose-400"
                  >
                    {formError || clientIssue}
                  </p>
                )}

                <Button
                  ref={submitRef}
                  type="submit"
                  disabled={acceptMutation.isPending || isExpired || !name.trim() || !password || password !== confirm}
                  className="h-11 w-full"
                >
                  {acceptMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <CheckCircle className="h-4 w-4" aria-hidden />
                  )}
                  {isExpired ? 'Invitation Expired' : 'Accept Invitation'}
                </Button>
              </form>

              <p className="mt-4 text-center text-xs text-muted-foreground">
                By accepting, you agree to MiniFoundry&apos;s Terms of Service and Privacy Policy.
              </p>

              <div className="mt-4 text-center">
                <Link href="/login" className="text-sm text-primary hover:underline">
                  Already have an account? Sign in
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}