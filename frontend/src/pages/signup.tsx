'use client'

// /signup — public self-registration.
// Mirrors the /login split-screen brand layout. Right card: name + email +
// password + confirm, client-side pre-validation (server messages win),
// exact server error surfaced inline. On success the backend auto-logs-in
// (session cookies), so we invalidate the query cache and honor ?next=.
// Every signup creates an organization and makes its creator the owner. The
// server exposes that owner as the compatible platform-admin role so existing
// role-gated product surfaces continue to work.

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from '@/components/link'
import { useRouter, useSearchParams } from '@/lib/next-navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Boxes,
  Building2,
  Eye,
  EyeOff,
  GitBranch,
  Loader2,
  Network,
  ShieldCheck,
  UserPlus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiSend } from '@/lib/foundry-api'
import { cn } from '@/lib/utils'
import { invalidateAuthBootstrap } from '@/routes/__root'
import type { LoginResponse, MeResponse } from '@/lib/foundry-types'

const FEATURES = [
  { icon: Boxes, text: 'Versioned datasets — every write is a transaction' },
  { icon: GitBranch, text: 'Visual pipelines — build ETL on a node canvas' },
  { icon: Network, text: 'Ontology — objects, links and write-back actions' },
  { icon: ShieldCheck, text: 'Governance — markings, approvals, full audit' },
]

const MIN_PASSWORD = 8
// Same pragmatic shape check as the server (one @, dot in the domain).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Only honor same-origin, app-relative post-signup destinations. */
function safeNext(value: string | null): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/'
}

export default function SignupPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const searchParams = useSearchParams()
  const next = safeNext(searchParams.get('next'))

  const [name, setName] = useState('')
  const [organizationName, setOrganizationName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitRef = useRef<HTMLButtonElement>(null)

  // Already signed in? Straight through (same convenience as /login).
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((me: MeResponse | null) => {
        if (!cancelled && me?.authenticated) router.replace(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [router, next])

  const clientIssue = useMemo(() => {
    if (!name.trim()) return null // let the server own required-field messages
    if (email && !EMAIL_RE.test(email.trim())) return 'Enter a valid email address.'
    if (password && password.length < MIN_PASSWORD)
      return `Password must be at least ${MIN_PASSWORD} characters.`
    if (confirm && confirm !== password) return 'Passwords do not match.'
    return null
  }, [name, email, password, confirm])

  const signupMutation = useMutation({
    mutationFn: () =>
      apiSend<LoginResponse>('/api/auth/signup', 'POST', {
        organizationName: organizationName.trim(),
        name: name.trim(),
        email: email.trim(),
        password,
      }),
    onSuccess: (res) => {
      const role = res.user.role
      toast.success(`Account created — welcome, ${res.user.name}`, {
        description:
          role === 'admin'
            ? 'Organization created — you are the organization owner.'
            : `Role: ${role} · your organization owner can manage access.`,
      })
      invalidateAuthBootstrap()
      queryClient.invalidateQueries()
      router.replace(next)
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Sign up failed')
    },
  })

  const passwordStrength = useMemo(() => {
    if (!password) return null
    let score = 0
    if (password.length >= MIN_PASSWORD) score++
    if (password.length >= 14) score++
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++
    if (/\d/.test(password)) score++
    if (/[^A-Za-z0-9]/.test(password)) score++
    const label = score <= 1 ? 'weak' : score <= 3 ? 'okay' : 'strong'
    const color =
      score <= 1 ? 'bg-rose-500' : score <= 3 ? 'bg-amber-500' : 'bg-emerald-500'
    return { label, color, score }
  }, [password])

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
            Create your account.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            One identity for the whole platform — datasets, pipelines, ontology and governance
            all respect your role and the markings you are cleared for.
          </p>
          <ul className="mt-8 space-y-3.5">
            {FEATURES.map((f) => (
              <li key={f.text} className="flex items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                  <f.icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                </span>
                <span className="text-sm text-foreground">{f.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ── RIGHT: sign-up card ───────────────────────────────────────── */}
      <div className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <Card>
            <CardHeader className="gap-1.5 p-6">
              <CardTitle className="text-base font-medium text-foreground">Create your organization</CardTitle>
              <CardDescription className="text-sm text-muted-foreground">
                You&apos;ll create an organization and become its owner with full access.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6 pt-0">
              <div className="mb-5 flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                <Building2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>Joining an existing organization? Use the invitation link sent by its administrator instead of creating a second organization.</span>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (clientIssue || confirm !== password) {
                    setError(clientIssue ?? 'Passwords do not match.')
                    return
                  }
                  if (!signupMutation.isPending) signupMutation.mutate()
                }}
                className="grid gap-4"
              >
                <div className="grid gap-2">
                  <Label htmlFor="signup-organization" className="text-xs text-muted-foreground">
                    Organization name
                  </Label>
                  <Input
                    id="signup-organization"
                    type="text"
                    autoComplete="organization"
                    placeholder="Acme Analytics"
                    value={organizationName}
                    onChange={(e) => { setOrganizationName(e.target.value); setError(null) }}
                    required
                    className="h-11"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="signup-name" className="text-xs text-muted-foreground">
                    Full name
                  </Label>
                  <Input
                    id="signup-name"
                    type="text"
                    autoComplete="name"
                    placeholder="Ada Lovelace"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      setError(null)
                    }}
                    required
                    className="h-11"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="signup-email" className="text-xs text-muted-foreground">
                    Email
                  </Label>
                  <Input
                    id="signup-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@minifoundry.dev"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value)
                      setError(null)
                    }}
                    required
                    className="h-11"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="signup-password" className="text-xs text-muted-foreground">
                    Password
                  </Label>
                  <div className="relative">
                    <Input
                      id="signup-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      placeholder={`at least ${MIN_PASSWORD} characters`}
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value)
                        setError(null)
                      }}
                      required
                      minLength={MIN_PASSWORD}
                      className="h-11 pr-11"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" aria-hidden />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden />
                      )}
                    </button>
                  </div>
                  {passwordStrength && (
                    <div className="flex items-center gap-2 pt-0.5">
                      <div className="flex h-1 flex-1 gap-1" aria-hidden>
                        {[1, 2, 3, 4, 5].map((i) => (
                          <span
                            key={i}
                            className={cn(
                              'h-full flex-1 rounded-full transition-colors',
                              i <= passwordStrength.score ? passwordStrength.color : 'bg-muted',
                            )}
                          />
                        ))}
                      </div>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {passwordStrength.label}
                      </span>
                    </div>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="signup-confirm" className="text-xs text-muted-foreground">
                    Confirm password
                  </Label>
                  <Input
                    id="signup-confirm"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="repeat your password"
                    value={confirm}
                    onChange={(e) => {
                      setConfirm(e.target.value)
                      setError(null)
                    }}
                    required
                    minLength={MIN_PASSWORD}
                    className="h-11"
                    aria-invalid={Boolean(confirm) && confirm !== password}
                  />
                  {confirm && confirm !== password && (
                    <p className="font-mono text-[11px] text-rose-600 dark:text-rose-400">
                      passwords do not match
                    </p>
                  )}
                </div>

                {error && (
                  <p
                    role="alert"
                    className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-600 dark:text-rose-400"
                  >
                    {error}
                  </p>
                )}

                <Button
                  ref={submitRef}
                  type="submit"
                  disabled={signupMutation.isPending || Boolean(clientIssue && name.trim())}
                  className="h-11"
                >
                  {signupMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <UserPlus className="h-4 w-4" aria-hidden />
                  )}
                  Create organization &amp; account
                </Button>
              </form>

              <p className="mt-5 border-t border-border pt-4 text-center text-xs text-muted-foreground">
                Already have an account?{' '}
                <Link
                  href={next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login'}
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                >
                  Sign in
                </Link>
              </p>
            </CardContent>
          </Card>

          <p className="mt-4 text-center font-mono text-[11px] leading-relaxed text-muted-foreground/80">
            Passwords are scrypt-hashed · sessions are signed JWTs in HttpOnly cookies ·{' '}
            <Link href="/" className="underline-offset-2 hover:text-foreground hover:underline">
              explore in demo mode instead
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
