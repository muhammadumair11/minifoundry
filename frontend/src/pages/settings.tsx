'use client'

// Settings (Task 12-d) — workspace configuration:
//   Appearance  → theme (light/dark) + editor font size (applies to all
//                 Monaco surfaces via the editor-prefs store)
//   Data        → workspace overview counts + one-click sample domain
//   Danger zone → admin-only full reset (type-to-confirm) that wipes every
//                 dataset, pipeline, run, transform, ontology, token, log…
//                 keeping only login users (POST /api/settings/reset)
//   Session     → who you are + the role-simulation note

import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@/lib/next-navigation'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import {
  DatabaseZap,
  Loader2,
  Moon,
  RotateCcw,
  Settings as SettingsIcon,
  ShieldAlert,
  Sun,
  Type,
  UserRound,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { GatedButton } from '@/components/foundry/governance/gated-button'
import { RoleBadge } from '@/components/foundry/governance/role-badge'
import { useEditorFontSize, EDITOR_FONT_SIZES, type EditorFontSize } from '@/components/foundry/editor-prefs'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { OrganizationSettings } from '@/components/foundry/organization-settings'
import { permissions, roleLabel } from '@/lib/permissions'
import type { ResetResponse, SessionResponse, WorkspaceOverview } from '@/lib/foundry-types'

// ── Appearance ───────────────────────────────────────────────────────────

function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const [fontSize, setFontSize] = useEditorFontSize()

  return (
    <section aria-labelledby="settings-appearance">
      <h2 id="settings-appearance" className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Appearance
      </h2>
      <Card className="py-0">
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {theme === 'dark' ? (
                <Moon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <Sun className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <div>
                <Label htmlFor="theme-select" className="text-[13px]">Theme</Label>
                <p className="text-xs text-muted-foreground">Light is the Foundry-style default.</p>
              </div>
            </div>
            <Select value={theme ?? 'light'} onValueChange={setTheme}>
              <SelectTrigger id="theme-select" size="sm" className="w-24">
                <SelectValue placeholder="Theme" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Type className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <div>
                <Label htmlFor="editor-font-select" className="text-[13px]">Editor font size</Label>
                <p className="text-xs text-muted-foreground">Applies to every code editor.</p>
              </div>
            </div>
            <Select
              value={String(fontSize)}
              onValueChange={(v) => setFontSize(Number(v) as EditorFontSize)}
            >
              <SelectTrigger id="editor-font-select" size="sm" className="w-24">
                <SelectValue placeholder="Size" />
              </SelectTrigger>
              <SelectContent>
                {EDITOR_FONT_SIZES.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} px
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}

// ── Workspace data ───────────────────────────────────────────────────────

const OVERVIEW_ROWS: Array<{ key: keyof WorkspaceOverview; label: string }> = [
  { key: 'projects', label: 'Projects' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'datasets', label: 'Datasets' },
  { key: 'datasetVersions', label: 'Dataset versions' },
  { key: 'pipelines', label: 'Pipelines' },
  { key: 'pipelineVersions', label: 'Pipeline versions' },
  { key: 'pipelineRuns', label: 'Pipeline runs' },
  { key: 'schedules', label: 'Schedules' },
  { key: 'transforms', label: 'Code workbooks' },
  { key: 'transformRuns', label: 'Workbook runs' },
  { key: 'objectTypes', label: 'Object types' },
  { key: 'actions', label: 'Actions' },
  { key: 'markings', label: 'Markings' },
  { key: 'pendingApprovals', label: 'Pending approvals' },
  { key: 'apiTokens', label: 'API tokens' },
  { key: 'apiRequestLogs', label: 'API request logs' },
  { key: 'auditEntries', label: 'Audit entries' },
  { key: 'users', label: 'Users' },
]

function DataSection() {
  const queryClient = useQueryClient()
  const overviewQuery = useQuery<WorkspaceOverview>({
    queryKey: ['settings-overview'],
    queryFn: () => apiJson<WorkspaceOverview>('/api/settings/overview'),
    staleTime: 5_000,
  })

  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const canEdit = sessionQuery.data?.role === 'admin' || sessionQuery.data?.role === 'editor'

  const seedMutation = useMutation({
    mutationFn: () => apiSend<{ seeded: boolean; datasets: string[] }>('/api/seed', 'POST'),
    onSuccess: (result) => {
      if (result.seeded) {
        toast.success('Sample datasets loaded', {
          description: `Seeded ${result.datasets.length} datasets: ${result.datasets.join(', ')}`,
        })
      } else {
        toast.info('Seed skipped', {
          description: 'The workspace already contains datasets — reset first for a from-empty seed.',
        })
      }
      void queryClient.invalidateQueries()
    },
    onError: (err) => toastApiError(err, 'Could not load sample data'),
  })

  return (
    <section aria-labelledby="settings-data">
      <h2 id="settings-data" className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Workspace data
      </h2>
      <Card className="py-0">
        <CardContent className="p-4">
          {overviewQuery.isLoading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {Array.from({ length: 12 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : overviewQuery.isError || !overviewQuery.data ? (
            <p className="text-sm text-rose-600 dark:text-rose-400">
              Could not load workspace overview: {(overviewQuery.error as Error | null)?.message ?? 'unknown error'}
            </p>
          ) : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
              {OVERVIEW_ROWS.map(({ key, label }) => (
                <div key={key} className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-1.5">
                  <dt className="text-[11px] text-muted-foreground">{label}</dt>
                  <dd className="font-mono text-[13px] tabular-nums text-foreground">
                    {overviewQuery.data[key] ?? 0}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <p className="max-w-prose text-xs text-muted-foreground">
              Load sample connectors and datasets. Then build a pipeline, seed the Ontology demo,
              or open Workbooks to load code examples. Existing datasets are preserved.
            </p>
            <GatedButton
              allowed={canEdit}
              reason={
                sessionQuery.isLoading
                  ? 'checking role…'
                  : `requires editor role (current: ${sessionQuery.data?.role ?? 'unknown'})`
              }
              size="sm"
              variant="outline"
              onClick={() => seedMutation.mutate()}
              disabled={seedMutation.isPending}
            >
              {seedMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <DatabaseZap className="h-3.5 w-3.5" aria-hidden />
              )}
              Load sample datasets
            </GatedButton>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}

// ── Danger zone (reset) ──────────────────────────────────────────────────

const CONFIRM_WORD = 'RESET'

function DangerZoneSection() {
  const queryClient = useQueryClient()
  const router = useRouter()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const confirmInputRef = useRef<HTMLInputElement>(null)

  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const isAdmin = permissions(sessionQuery.data).canReset

  const resetMutation = useMutation({
    mutationFn: () => apiSend<ResetResponse>('/api/settings/reset', 'POST'),
    onSuccess: (result) => {
      const c = result.counts ?? {}
      const summary = [
        `${c.datasets ?? 0} datasets`,
        `${c.pipelines ?? 0} pipelines`,
        `${c.pipelineRuns ?? 0} runs`,
        `${c.transforms ?? 0} workbooks`,
        `${c.objectTypes ?? 0} object types`,
        `${c.apiTokens ?? 0} tokens`,
      ].join(' · ')
      toast.success('Workspace reset', {
        description: `Deleted ${summary}. Users and login were kept.`,
        duration: 8_000,
      })
      queryClient.clear()
      setDialogOpen(false)
      setConfirmText('')
      router.refresh()
    },
    onError: (err) => toastApiError(err, 'Reset failed'),
  })

  if (!isAdmin) return null

  return (
    <section aria-labelledby="settings-danger">
      <h2 id="settings-danger" className="mb-2 text-xs font-medium uppercase tracking-wider text-rose-600 dark:text-rose-400">
        Danger zone
      </h2>
      <Card className="border-rose-600/30 py-0 dark:border-rose-400/30">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />
            <div>
              <p className="text-[13px] font-medium text-foreground">Reset workspace</p>
              <p className="max-w-prose text-xs text-muted-foreground">
                Permanently deletes <span className="text-foreground">everything</span> — datasets, versions,
                pipelines, runs, schedules, code workbooks and their outputs, ontology objects, actions,
                markings, approvals, connectors, API tokens and all logs — returning the platform to a
                totally empty default. Your login users are kept.
              </p>
            </div>
          </div>
          <GatedButton
            allowed={isAdmin}
            reason={
              sessionQuery.isLoading
                ? 'checking role…'
                : `requires admin role (current: ${sessionQuery.data?.role ?? 'unknown'})`
            }
            variant="destructive"
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Reset everything…
          </GatedButton>
        </CardContent>
      </Card>

      <AlertDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setConfirmText('')
        }}
      >
        <AlertDialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            confirmInputRef.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Reset the workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes all datasets, pipelines, runs, workbooks, ontology, governance and API
              tokens, and cannot be undone. Only your login users survive. Type{' '}
              <span className="font-mono text-foreground">{CONFIRM_WORD}</span>, then press Enter to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (confirmText === CONFIRM_WORD && !resetMutation.isPending) resetMutation.mutate()
            }}
          >
            <Input
              ref={confirmInputRef}
              aria-label={`Type ${CONFIRM_WORD} to confirm`}
              placeholder={CONFIRM_WORD}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="font-mono"
            />
            <AlertDialogFooter>
              <AlertDialogCancel type="button" data-key-hint="Esc" aria-keyshortcuts="Escape">
                Cancel <Kbd>Esc</Kbd>
              </AlertDialogCancel>
              <Button
                type="submit"
                keyHint="Enter after RESET"
                disabled={confirmText !== CONFIRM_WORD || resetMutation.isPending}
                className="bg-rose-600 text-white hover:bg-rose-500 dark:bg-rose-500 dark:text-zinc-950 dark:hover:bg-rose-400"
              >
                {resetMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : null}
                Delete everything
                <Kbd>Enter</Kbd>
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

// ── Session ──────────────────────────────────────────────────────────────

function SessionSection() {
  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const session = sessionQuery.data?.session ?? null

  return (
    <section aria-labelledby="settings-session">
      <h2 id="settings-session" className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Session
      </h2>
      <Card className="py-0">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-2">
            <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            {sessionQuery.isLoading ? (
              <Skeleton className="h-4 w-48" />
            ) : (
              <div className="text-[13px]">
                {session ? (
                  <span className="text-foreground">
                    {session.name} <span className="font-mono text-xs text-muted-foreground">{session.email}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Role simulator (no signed-in user) — switch roles from the top bar.
                  </span>
                )}
              </div>
            )}
            {sessionQuery.data?.organizationRole ? <span className="text-xs font-medium">{roleLabel(sessionQuery.data.organizationRole)}</span> : sessionQuery.data ? <RoleBadge role={sessionQuery.data.role} /> : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Your active organization role determines which actions are available.
          </p>
        </CardContent>
      </Card>
    </section>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:py-8">
      <header className="mb-5 flex flex-wrap items-center gap-2">
        <SettingsIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-sm font-medium tracking-tight text-foreground">Settings</h1>
        <span className="text-xs text-muted-foreground">
          appearance · workspace data · danger zone · session
        </span>
      </header>

      <div className="space-y-5">
        <AppearanceSection />
        <OrganizationSettings />
        <DataSection />
        <DangerZoneSection />
        <SessionSection />
      </div>
    </div>
  )
}
