'use client'

// Sign-in and organization onboarding. A new identity clears cached role-gated data.

import { useEffect, useRef, useState } from 'react'
import Link from '@/components/link'
import { useSearchParams } from '@/lib/next-navigation'
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
import { roleLabel } from '@/lib/permissions'
import { invalidateAuthBootstrap } from '@/routes/__root'
import type { LoginResponse, MeResponse } from '@/lib/foundry-types'

const FEATURES = [
  { icon: Boxes, text: 'Versioned datasets — every write is a transaction' },
  { icon: GitBranch, text: 'Visual pipelines — build ETL on a node canvas' },
  { icon: Network, text: 'Ontology — objects, links and write-back actions' },
  { icon: ShieldCheck, text: 'Governance — markings, approvals, full audit' },
]

/** Only honor same-origin, app-relative post-login destinations. */
function safeNext(value: string | null): string {
  return value?.startsWith('/') && !value.startsWith('//') && !/[\\\u0000-\u0020]/.test(value) ? value : '/'
}

export default function LoginPage() {
  const queryClient = useQueryClient()
  const searchParams = useSearchParams()
  // Auth-gate deep link: /login?next=/datasets%3Fproject%3Dx
  const next = safeNext(searchParams.get('next'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitRef = useRef<HTMLButtonElement>(null)

  // Already signed in? Straight to the platform (session cookie still valid).
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((me: MeResponse | null) => {
        if (!cancelled && me?.authenticated) {
          invalidateAuthBootstrap()
          window.location.replace(next)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [next])

  const loginMutation = useMutation({
    mutationFn: () =>
      apiSend<LoginResponse>('/api/auth/login', 'POST', {
        email: email.trim(),
        password,
      }),
    onSuccess: (res) => {
      toast.success(`Signed in as ${res.user.name}`, {
        description: roleLabel(res.user.organizationRole),
      })
      // Full sweep — role-gated data (masking, tokens, users) re-resolves
      // under the new identity. ['session'] refetch flips the header menu.
      invalidateAuthBootstrap()
      queryClient.clear()
      // Remount the shell so no previous identity/query observer survives signin.
      window.location.replace(next)
    },
    onError: (err) => {
      // Exact server message (401 'invalid email or password' etc.).
      setError(err instanceof Error ? err.message : 'Sign in failed')
    },
  })

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
            Sign in to your organization to ingest, transform, govern, and collaborate on data.
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
              <CardTitle className="text-base font-medium text-foreground">Sign in to your organization</CardTitle>
              <CardDescription className="text-sm text-muted-foreground">
                Use the email address and password for your MiniFoundry account.
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

              <p className="mt-5 border-t border-border pt-4 text-center text-xs text-muted-foreground">
                Need a new organization?{' '}
                <Link
                  href={next !== '/' ? `/signup?next=${encodeURIComponent(next)}` : '/signup'}
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                >
                  Create an organization
                </Link>{' '}
                — new accounts create an organization and start as its owner.
              </p>
            </CardContent>
          </Card>

          <p className="mt-4 text-center font-mono text-[11px] leading-relaxed text-muted-foreground/80">
            Signed JWT access tokens (15 min) + rotating 7-day refresh · HttpOnly cookies ·{' '}
            Have an invitation? Open the unique link from your organization administrator.
          </p>
        </div>
      </div>
    </div>
  )
}
