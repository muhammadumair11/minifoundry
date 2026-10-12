'use client'

// M10 Platform API (Task 6-c) — /api-tokens: create (admin) with show-once
// secret, list with prefix chips + usage stats, revoke with confirm.
// Secrets created here are also remembered in localStorage (max 10) so the
// API Explorer (/api-docs) can pre-fill them. Backend contract: agent-ctx 6-b.
// Task 8-c: the 7-c client-side usage mini-dashboard became the full
// "API usage — last 24h" observability card (GET /api/tokens/usage, 8-b).

import { useState } from 'react'
import Link from '@/components/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowRight,
  Copy,
  KeyRound,
  Loader2,
  MoreVertical,
  Plus,
  ShieldAlert,
  Terminal,
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
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { GatedButton } from '@/components/foundry/governance/gated-button'
import { UsageDashboard } from '@/components/foundry/api/usage-dashboard'
import {
  SAVED_TOKENS_MAX,
  loadSavedTokens,
  removeSavedToken,
  saveTokenToLocalStorage,
} from '@/components/foundry/api/saved-tokens'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { formatRelative } from '@/lib/foundry-types'
import type {
  CreateTokenResponse,
  ApiTokenInfo,
  SessionResponse,
  TokensListResponse,
} from '@/lib/foundry-types'

// ── Page ─────────────────────────────────────────────────────────────

export default function ApiTokensPage() {
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [revoking, setRevoking] = useState<ApiTokenInfo | null>(null)

  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const isAdmin: boolean = sessionQuery.data?.role === 'admin'

  const tokensQuery = useQuery<TokensListResponse>({
    queryKey: ['tokens'],
    queryFn: () => apiJson<TokensListResponse>('/api/tokens'),
    retry: false,
    enabled: isAdmin,
  })
  const tokens = tokensQuery.data?.tokens ?? []
  const activeCount = tokens.filter((t) => !t.revokedAt).length

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiSend<{ ok: true }>(`/api/tokens/${id}`, 'DELETE'),
    onSuccess: (_res, id) => {
      toast.success('Token revoked', {
        description: 'Apps using it now receive 401 responses.',
      })
      // Drop the saved secret for this id (it no longer authenticates).
      removeSavedToken(id)
      queryClient.invalidateQueries({ queryKey: ['tokens'] })
      setRevoking(null)
    },
    onError: (err) => toastApiError(err, 'Could not revoke token'),
  })

  if (!isAdmin) return <p className="p-6 text-sm text-muted-foreground">{sessionQuery.isLoading ? 'Checking permissions…' : 'API tokens require Organization Owner or Organization Admin access.'}</p>

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* Header (compact Foundry pattern) */}
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-sm font-medium tracking-tight text-foreground">API Tokens</h1>
        <span className="text-xs text-muted-foreground">
          credentials for the read API{' '}
          <span className="font-mono">/api/foundry/v1/*</span> — tokens act as a viewer, markings
          enforced
        </span>
      </header>

      {/* Link banner → API Explorer */}
      <Link
        href="/api-docs"
        className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-sm transition-colors hover:bg-accent"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 text-muted-foreground">
            Read the API reference and try live requests in the{' '}
            <span className="font-medium text-foreground">API Explorer</span> →
          </span>
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>

      {/* API usage observability (Task 8-c) — 24h traffic card driven by
          GET /api/tokens/usage; admin-only (403 renders the note inside). */}
      {isAdmin && !tokensQuery.isError && <UsageDashboard isAdmin={isAdmin} />}

      {/* Create card */}
      <Card className="mb-4">
        <CardHeader className="gap-2 border-b border-border p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Plus className="h-4 w-4 text-muted-foreground" aria-hidden />
                Create a token
              </CardTitle>
              <CardDescription className="mt-1 text-xs text-muted-foreground">
                Tokens authenticate with{' '}
                <span className="font-mono text-foreground">Authorization: Bearer mf_live_…</span>.
                Admin only.
              </CardDescription>
            </div>
            <GatedButton
              allowed={isAdmin}
              reason="requires admin role (current role: viewer/editor)"
              size="sm"
              onClick={() => setCreateOpen(true)}
              className="shrink-0"
            >
              <KeyRound className="h-3.5 w-3.5" aria-hidden />
              New token
            </GatedButton>
          </div>
        </CardHeader>

        {/* Token list */}
        <CardContent className="p-0">
          {tokensQuery.isLoading ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : tokensQuery.isError ? (
            // GET /api/tokens is admin-only (6-b contract): for viewer/editor
            // render an expected-role note instead of a hard error.
            tokensQuery.error instanceof Error &&
            tokensQuery.error.message.includes('requires admin') ? (
              <div className="flex flex-col items-center gap-1.5 p-8 text-center">
                <ShieldAlert className="h-6 w-6 text-muted-foreground" aria-hidden />
                <p className="text-sm font-medium text-muted-foreground">
                  The token list is admin-only.
                </p>
                <p className="text-xs text-muted-foreground/80">
                  Switch to admin in the header to create and revoke tokens — you can still try the
                  read API in the{' '}
                  <Link
                    href="/api-docs"
                    className="text-foreground underline-offset-2 hover:underline"
                  >
                    Explorer
                  </Link>{' '}
                  with a token secret.
                </p>
              </div>
            ) : (
              <p className="p-6 text-center text-sm text-rose-600 dark:text-rose-400">
                {tokensQuery.error instanceof Error
                  ? tokensQuery.error.message
                  : 'Failed to load tokens.'}
              </p>
            )
          ) : tokens.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 p-8 text-center">
              <KeyRound className="h-6 w-6 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium text-muted-foreground">No tokens yet.</p>
              <p className="text-xs text-muted-foreground/80">
                Create one to call the public read API from apps or curl.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {tokens.map((token) => (
                <li
                  key={token.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50">
                    <KeyRound
                      className={token.revokedAt ? 'h-4 w-4 text-muted-foreground' : 'h-4 w-4 text-emerald-600 dark:text-emerald-400'}
                      aria-hidden
                    />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={
                          token.revokedAt
                            ? 'truncate text-sm font-medium text-muted-foreground line-through'
                            : 'truncate text-sm font-medium text-foreground'
                        }
                      >
                        {token.name}
                      </span>
                      {token.revokedAt ? (
                        <Badge
                          variant="outline"
                          className="border-border bg-muted px-1.5 py-0 font-mono text-[10px] text-muted-foreground"
                        >
                          revoked
                        </Badge>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1.5 font-mono text-[10px] text-emerald-600 dark:text-emerald-400"
                          aria-label="Active token"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                          Active
                        </span>
                      )}
                      <span
                        className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                        title={`Secret prefix ${token.prefix}… (the full secret is never stored)`}
                      >
                        {token.prefix}…
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
                      <span>
                        <span className="text-foreground">{token.requestCount.toLocaleString()}</span>{' '}
                        requests
                      </span>
                      <span>last used {formatRelative(token.lastUsedAt)}</span>
                      <span>created {formatRelative(token.createdAt)}</span>
                    </div>
                  </div>

                  {/* Row action menu: revoke (admin). Viewer/editor get a
                      disabled ghost button with the gating reason as tooltip. */}
                  <div className="shrink-0 sm:ml-auto">
                    {isAdmin ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 min-h-8 p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={`Token ${token.name} actions`}
                            disabled={revokeMutation.isPending}
                          >
                            <MoreVertical className="h-4 w-4" aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setRevoking(token)}
                            className="text-xs focus:text-rose-600 dark:focus:text-rose-600 dark:text-rose-400"
                          >
                            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
                            Revoke token
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <GatedButton
                        allowed={false}
                        reason="requires admin role"
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 min-h-8 p-0 text-muted-foreground"
                        aria-label={`Token ${token.name} actions`}
                      >
                        <MoreVertical className="h-4 w-4" aria-hidden />
                      </GatedButton>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Saved-secrets note */}
          <div className="border-t border-border px-4 py-3">
            <p className="text-[11px] leading-4 text-muted-foreground/80">
              Secrets you create are remembered locally in this browser (max {SAVED_TOKENS_MAX}) so
              the API Explorer can pre-fill them. Clear saved secrets in the{' '}
              <Link
                href="/api-docs"
                className="text-foreground underline-offset-2 hover:underline"
              >
                Explorer
              </Link>
              .
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Live counter strip */}
      <p className="font-mono text-[11px] text-muted-foreground/80">
        {tokensQuery.isLoading ? (
          '· · ·'
        ) : tokensQuery.isError ? (
          'token list requires admin role'
        ) : (
          <>
            <span className="text-foreground">{activeCount}</span> active ·{' '}
            <span className="text-foreground">{tokens.length}</span> total · rate limit{' '}
            <span className="text-foreground">60 req/min</span> per token
          </>
        )}
      </p>

      {/* Create dialog + show-once secret */}
      <CreateTokenDialog open={createOpen} onOpenChange={setCreateOpen} />

      {/* Revoke confirm */}
      <AlertDialog
        open={!!revoking}
        onOpenChange={(open) => {
          if (!open) setRevoking(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base text-foreground">
              Revoke “{revoking?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground">
              Apps using this token will immediately receive 401 responses. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revoking && revokeMutation.mutate(revoking.id)}
              disabled={revokeMutation.isPending}
              className="bg-rose-600 text-white hover:bg-rose-600/90 dark:bg-rose-500 dark:hover:bg-rose-500/90"
            >
              {revokeMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ShieldAlert className="h-4 w-4" aria-hidden />
              )}
              Revoke token
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Create dialog (name → POST → show-once secret panel) ────────────

function CreateTokenDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [created, setCreated] = useState<CreateTokenResponse | null>(null)

  const trimmed = name.trim()
  const nameValid = trimmed.length >= 1 && trimmed.length <= 64

  const createMutation = useMutation({
    mutationFn: () => apiSend<CreateTokenResponse>('/api/tokens', 'POST', { name: trimmed }),
    onSuccess: (res) => {
      // Remember locally for the Explorer before anything else can unmount.
      saveTokenToLocalStorage({
        id: res.token.id,
        name: res.token.name,
        prefix: res.token.prefix,
        secret: res.secret,
        createdAt: res.token.createdAt,
      })
      setCreated(res)
      queryClient.invalidateQueries({ queryKey: ['tokens'] })
    },
    onError: (err) => toastApiError(err, 'Could not create token'),
  })

  const handleClose = (next: boolean) => {
    if (!next) {
      setName('')
      setCreated(null)
      createMutation.reset()
    }
    onOpenChange(next)
  }

  const handleCopy = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.secret)
      toast.success('Secret copied to clipboard', {
        description: 'Store it in your app config — it will never be shown again.',
      })
    } catch {
      toast.error('Copy failed', { description: 'Select the secret and copy it manually.' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        {!created ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-base text-foreground">New API token</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Give the token a name so you can recognize it later. The secret is shown once.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 py-1">
              <Label htmlFor="token-name" className="text-xs text-muted-foreground">
                Token name <span className="text-muted-foreground/80">(1–64 characters)</span>
              </Label>
              <Input
                id="token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. mobile-app-read"
                maxLength={64}
                autoFocus
                className="font-mono text-sm"
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => handleClose(false)}
              >
                Cancel
              </Button>
              <Button
                data-dialog-submit
                onClick={() => createMutation.mutate()}
                disabled={!nameValid || createMutation.isPending}
                className="shrink-0"
              >
                {createMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <KeyRound className="h-4 w-4" aria-hidden />
                )}
                Create token
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base text-foreground">
                <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden />
                Token “{created.token.name}” created
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Prefix <span className="font-mono text-foreground">{created.token.prefix}…</span> ·
                created {formatRelative(created.token.createdAt)}
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
              <p className="flex items-start gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                Copy this secret now — it will never be shown again
              </p>
              <div className="mt-3 flex items-stretch gap-2">
                <code
                  className="foundry-scroll min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2.5 font-mono text-xs text-foreground"
                  aria-label="API token secret"
                >
                  {created.secret}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopy}
                  className="shrink-0 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                  aria-label="Copy secret to clipboard"
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  Copy
                </Button>
              </div>
            </div>

            <DialogFooter>
              <Button
                onClick={() => handleClose(false)}
                className="shrink-0"
              >
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
