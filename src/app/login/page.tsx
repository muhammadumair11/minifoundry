'use client'

// M9 Real auth (Task 7-c) — /login: split-screen auth showpiece.
// LEFT (lg+): brand panel on a muted surface with a subtle grid texture.
// RIGHT: sign-in card (email + password with show/hide, exact server error
// surfaced inline) + demo identity quick-fill chips. Demo chips FILL the form
// only (no auto-submit) so the credentials stay visible before signing in.
// On success: full query-cache invalidation (role-gated data re-resolves for
// the new identity) + redirect home. Backend contract: agent-ctx 7-b.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Boxes,
  Eye,
  EyeOff,
  GitBranch,
  Loader2,
  LogIn,
  Network,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiSend } from '@/lib/foundry-api'
import { cn } from '@/lib/utils'
import { getRoleClasses } from '@/components/foundry/governance/role-badge'
import type { FoundryRole, LoginResponse, MeResponse } from '@/lib/foundry-types'

// Seeded demo identities (password shared — see the mono note under the form).
const DEMO_PASSWORD = '<redacted>'
const DEMO_IDENTITIES: { name: string; email: string; role: FoundryRole }[] = [
  { name: 'Ada Admin', email: 'demo-admin@example.invalid', role: 'admin' },
  { name: 'Eddie Editor', email: 'demo-editor@example.invalid', role: 'editor' },
  { name: 'Vera Viewer', email: 'demo-viewer@example.invalid', role: 'viewer' },
]

const FEATURES = [
  { icon: Boxes, text: 'Versioned datasets — every write is a transaction' },
  { icon: GitBranch, text: 'Visual pipelines — build ETL on a node canvas' },
  { icon: Network, text: 'Ontology — objects, links and write-back actions' },
  { icon: ShieldCheck, text: 'Governance — markings, approvals, full audit' },
]

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export default function LoginPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitRef = useRef<HTMLButtonElement>(null)

  // Already signed in? Straight to the platform (session cookie still valid).
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((me: MeResponse | null) => {
        if (!cancelled && me?.authenticated) router.replace('/')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [router])

  const loginMutation = useMutation({
    mutationFn: () =>
      apiSend<LoginResponse>('/api/auth/login', 'POST', {
        email: email.trim(),
        password,
      }),
    onSuccess: (res) => {
      toast.success(`Signed in as ${res.user.name}`, {
        description: `Role: ${res.user.role} · session valid for 7 days.`,
      })
      // Full sweep — role-gated data (masking, tokens, users) re-resolves
      // under the new identity. ['session'] refetch flips the header menu.
      queryClient.invalidateQueries()
      router.push('/')
    },
    onError: (err) => {
      // Exact server message (401 'invalid email or password' etc.).
      setError(err instanceof Error ? err.message : 'Sign in failed')
    },
  })

  const fillDemo = (identity: (typeof DEMO_IDENTITIES)[number]) => {
    setEmail(identity.email)
    setPassword(DEMO_PASSWORD)
    setError(null)
    submitRef.current?.focus()
  }

  return (
    <div className="grid flex-1 lg:grid-cols-2">
      {/* ── LEFT: brand panel (hidden on mobile) ─────────────────────── */}
      <div className="relative hidden overflow-hidden border-r border-border bg-muted/40 lg:flex lg:flex-col lg:justify-center">
        {/* Texture: subtle grid (themed in globals.css) */}
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
            The learning-scale data platform.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Sign in to operate the full loop — ingest, transform, govern. Or stay anonymous and
            explore in demo mode.
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

      {/* ── RIGHT: sign-in card ───────────────────────────────────────── */}
      <div className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <Card>
            <CardHeader className="gap-1.5 p-6">
              <CardTitle className="text-base font-medium text-foreground">Sign in</CardTitle>
              <CardDescription className="text-sm text-muted-foreground">
                Use a demo identity or your own account.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6 pt-0">
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!loginMutation.isPending) loginMutation.mutate()
                }}
                className="grid gap-4"
              >
                <div className="grid gap-2">
                  <Label htmlFor="login-email" className="text-xs text-muted-foreground">
                    Email
                  </Label>
                  <Input
                    id="login-email"
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
                  <Label htmlFor="login-password" className="text-xs text-muted-foreground">
                    Password
                  </Label>
                  <div className="relative">
                    <Input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      placeholder="••••••••••••"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value)
                        setError(null)
                      }}
                      required
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
                  disabled={loginMutation.isPending}
                  className="h-11"
                >
                  {loginMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <LogIn className="h-4 w-4" aria-hidden />
                  )}
                  Sign in
                </Button>
              </form>

              {/* Demo identity quick-fill — fills the form, never auto-submits */}
              <div className="mt-6 border-t border-border pt-5">
                <p className="text-xs font-medium text-muted-foreground">Demo identities</p>
                <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {DEMO_IDENTITIES.map((d) => {
                    const classes = getRoleClasses(d.role)
                    return (
                      <button
                        key={d.email}
                        type="button"
                        onClick={() => fillDemo(d)}
                        className="flex min-h-11 items-center gap-2 rounded-md border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-accent"
                        aria-label={`Fill credentials for ${d.name} (${d.role})`}
                      >
                        <span
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted font-mono text-[9px] font-bold text-foreground"
                          aria-hidden
                        >
                          {initialsOf(d.name)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium text-foreground">
                            {d.name.split(' ')[0]}
                          </span>
                          <span className={cn('block font-mono text-[10px]', classes.text)}>
                            {d.role}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
                <p className="mt-3 font-mono text-[11px] text-muted-foreground/80">
                  seeded password: <span className="text-muted-foreground"><redacted></span>
                </p>
              </div>
            </CardContent>
          </Card>

          <p className="mt-4 text-center font-mono text-[11px] leading-relaxed text-muted-foreground/80">
            Sessions are stateless HMAC tokens · 7-day expiry · HttpOnly cookie ·{' '}
            <Link href="/" className="underline-offset-2 hover:text-foreground hover:underline">
              back to demo mode
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
