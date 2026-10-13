'use client'

import { roleLabel } from '@/lib/permissions'

import { useState } from 'react'
import Link from '@/components/link'
import { useRouter } from '@/lib/next-navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import { toast } from 'sonner'
import {
  Activity,
  ArrowRight,
  Boxes,
  Database,
  GitBranch,
  GraduationCap,
  HeartPulse,
  LayoutDashboard,
  Network,
  Play,
  ShieldCheck,
  Sparkles,
  SquareCode,
  Terminal,
  Upload,
  UserCircle,
  Workflow,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StatusBadge } from '@/components/foundry/status-badge'
import { apiJson } from '@/lib/foundry-api'
import { cn } from '@/lib/utils'
import {
  STALE_THRESHOLD_MINUTES,
  formatDuration,
  type ApiStats,
} from '@/lib/foundry-types'
import type {
  ApiUsageResponse,
  ApprovalsListResponse,
  HealthResponse,
  MarkingsListResponse,
  OntologyListResponse,
  SeedResponse,
  SessionResponse,
  TokensListResponse,
  TransformsListResponse,
} from '@/lib/foundry-types'

interface CurriculumStepStatus {
  id: string
  title: string
  href: string
  cta: string
  verify: 'auto' | 'manual'
  done: boolean
}

interface CurriculumStatus {
  steps: CurriculumStepStatus[]
  completed: number
  total: number
  percent: number
  nextStepId: string | null
}

function StatCard({
  title,
  icon: Icon,
  value,
  loading,
  href,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  value: React.ReactNode
  loading?: boolean
  /** When set, the whole card navigates (e.g. Projects → /projects). */
  href?: string
  children?: React.ReactNode
}) {
  const card = (
    <Card className={cn('gap-0 py-0', href && 'h-full transition-colors group-hover:border-foreground/25')}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="mt-2 flex items-end justify-between gap-2">
          {loading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <p className="text-2xl font-semibold tabular-nums text-foreground">{value}</p>
          )}
          {children}
        </div>
      </CardContent>
    </Card>
  )
  if (!href) return card
  return (
    <Link href={href} className="group block rounded-lg" aria-label={`Open ${title}`}>
      {card}
    </Link>
  )
}

/** Subtle "ontology: N types · M actions" chip — shares the ['ontology'] cache. */
function OntologyHealthChip() {
  const { data } = useQuery<OntologyListResponse>({
    queryKey: ['ontology'],
    queryFn: () => apiJson<OntologyListResponse>('/api/ontology'),
  })
  if (!data) return null
  const typeCount = data.objectTypes.length
  const actionCount = data.objectTypes.reduce((n, t) => n + t.actions.length, 0)
  return (
    <Link
      href="/ontology"
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      aria-label={`Ontology — ${typeCount} object type${typeCount === 1 ? '' : 's'}, ${actionCount} action${actionCount === 1 ? '' : 's'}. Open ontology.`}
    >
      <Network className="h-3 w-3 text-muted-foreground" aria-hidden />
      <span>
        ontology:{' '}
        <span className="text-foreground">{typeCount}</span> type{typeCount === 1 ? '' : 's'} ·{' '}
        <span className="text-foreground">{actionCount}</span> action{actionCount === 1 ? '' : 's'}
      </span>
    </Link>
  )
}

/** "code: N workbooks" chip — shares the ['transforms'] cache. */
function CodeWorkbooksChip() {
  const { data } = useQuery<TransformsListResponse>({
    queryKey: ['transforms'],
    queryFn: () => apiJson<TransformsListResponse>('/api/transforms'),
  })
  if (!data) return null
  const count = data.transforms.length
  return (
    <Link
      href="/transforms"
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      aria-label={`Code workbooks — ${count} transform${count === 1 ? '' : 's'}. Open transforms.`}
    >
      <SquareCode className="h-3 w-3 text-muted-foreground" aria-hidden />
      <span>
        code: <span className="text-foreground">{count}</span> workbook{count === 1 ? '' : 's'}
      </span>
    </Link>
  )
}

/** "governance: N markings · M pending" chip — shares ['markings']/['approvals'] caches. */
function GovernanceHealthChip() {
  const markingsQuery = useQuery<MarkingsListResponse>({
    queryKey: ['markings'],
    queryFn: () => apiJson<MarkingsListResponse>('/api/markings'),
  })
  const approvalsQuery = useQuery<ApprovalsListResponse>({
    queryKey: ['approvals', 'pending'],
    queryFn: () => apiJson<ApprovalsListResponse>('/api/approvals?status=pending'),
  })
  if (!markingsQuery.data) return null
  const markingCount = markingsQuery.data.markings.length
  const pendingCount = approvalsQuery.data?.approvals.length ?? 0
  return (
    <Link
      href="/governance"
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      aria-label={`Governance — ${markingCount} marking${markingCount === 1 ? '' : 's'}, ${pendingCount} pending approval${pendingCount === 1 ? '' : 's'}. Open governance.`}
    >
      <ShieldCheck className="h-3 w-3 text-muted-foreground" aria-hidden />
      <span>
        governance:{' '}
        <span className="text-foreground">{markingCount}</span> marking{markingCount === 1 ? '' : 's'} ·{' '}
        <span className={pendingCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}>
          {pendingCount}
        </span>{' '}
        pending
      </span>
    </Link>
  )
}

/** "api: …" chip — ONE adaptive entry point (merged in 8-d): admins get the
    24h usage window ("N req / 24h · M tokens", → /api-tokens usage dashboard);
    non-admins (or admins before usage loads) get token/Explorer labels
    ("M tokens · v1" / "v1 read endpoints", → /api-docs). Queries are gated on
    the effective role so they don't 403 for viewer/editor. */
function ApiChip() {
  // Same ['session'] pattern as site-header — `role` is the effective role.
  const { data: session } = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const isAdmin = session?.role === 'admin'
  const tokensQuery = useQuery<TokensListResponse>({
    queryKey: ['tokens'],
    queryFn: () => apiJson<TokensListResponse>('/api/tokens'),
    enabled: isAdmin,
    retry: false,
    staleTime: 30_000,
  })
  const usageQuery = useQuery<ApiUsageResponse>({
    queryKey: ['api-usage'],
    queryFn: () => apiJson<ApiUsageResponse>('/api/tokens/usage'),
    enabled: isAdmin,
    retry: false,
  })
  const activeCount = tokensQuery.data?.tokens.filter((t) => !t.revokedAt).length ?? 0
  const total = usageQuery.data?.total
  const href = isAdmin ? '/api-tokens' : '/api-docs'
  const label = isAdmin
    ? total !== undefined
      ? total > 0
        ? `${total.toLocaleString()} req / 24h · ${activeCount} token${activeCount === 1 ? '' : 's'}`
        : `idle · ${activeCount} token${activeCount === 1 ? '' : 's'}`
      : `${activeCount} token${activeCount === 1 ? '' : 's'} · v1`
    : 'v1 read endpoints'
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      aria-label={
        isAdmin
          ? `API usage — ${total ?? 0} requests in the last 24h, ${activeCount} active token${activeCount === 1 ? '' : 's'}. Open API tokens.`
          : 'Public read API — open the API Explorer.'
      }
    >
      <Activity className="h-3 w-3 text-muted-foreground" aria-hidden />
      <span>
        api:{' '}
        <span className="text-foreground">{label}</span>
      </span>
    </Link>
  )
}

/** "signed in: Ada Admin (admin)" chip (Task 7-c) — shares the ['session']
    cache with the header; only rendered when a real session is present. */
function SignedInChip({ session }: { session: SessionResponse }) {
  const user = session.session
  if (!user) return null
  return (
    <Link
      href="/governance"
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      aria-label={`Signed in as ${user.name} (${roleLabel(session.organizationRole ?? user.role)}) — open governance.`}
    >
      <UserCircle className="h-3 w-3 text-muted-foreground" aria-hidden />
      <span>
        signed in: <span className="text-foreground">{user.name}</span>{' '}
        <span
          className={
            user.role === 'admin'
              ? 'text-emerald-600 dark:text-emerald-400'
              : user.role === 'editor'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-muted-foreground'
          }
        >
          ({roleLabel(session.organizationRole ?? user.role)})
        </span>
      </span>
    </Link>
  )
}

/** P3: "resume where you left off" — slim banner above the stat cards that
    deep-links to the next incomplete curriculum step. Hidden until loaded;
    collapses to a subtle chip when the path is finished. */
function CurriculumResumeBanner({ canEdit }: { canEdit: boolean }) {
  const { data } = useQuery<CurriculumStatus>({
    queryKey: ['curriculum'],
    queryFn: () => apiJson<CurriculumStatus>('/api/curriculum'),
    staleTime: 15_000,
    enabled: canEdit,
  })
  if (!canEdit) return <Link href="/learn" className="my-4 block rounded border bg-card p-3 text-xs">Explore datasets, objects and applications with the learning path for your role.</Link>
  if (!data) return null
  // 'Up next' comes from the API's pick (tour-first for new users, then
  // actionable auto steps before manual check-offs) so the banner and the
  // Learn tracker always agree.
  const next = data.steps.find((s) => s.id === data.nextStepId) ?? null

  if (!next) {
    return (
      <Link
        href="/learn"
        className="my-4 inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-1.5 font-mono text-[11px] text-emerald-600 transition-colors hover:bg-emerald-500/10 dark:text-emerald-400"
        aria-label={`Curriculum complete — all ${data.total} steps verified. Open Learn.`}
      >
        <GraduationCap className="h-3 w-3" aria-hidden />
        <span>
          curriculum: <span className="font-semibold">complete</span> · {data.total}/{data.total} steps
        </span>
      </Link>
    )
  }

  // Adaptive heading: "Getting started" is only true at the very beginning —
  // a 78%-complete user should read momentum, not an invitation to start.
  const heading = data.percent === 0 ? 'Getting started' : 'Keep going'

  return (
    <div
      className="my-4 flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid="curriculum-resume"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <GraduationCap className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 text-xs font-medium text-foreground">
            {heading}
            <span className="font-mono text-[10px] font-normal text-muted-foreground">
              {data.completed}/{data.total} steps · {data.percent}%
            </span>
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            Up next:{' '}
            <span className="font-medium text-foreground/90">{next.title}</span>
            {next.verify === 'manual' && (
              <span className="text-muted-foreground/70"> (check-off in Learn)</span>
            )}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Progress
          value={data.percent}
          aria-label={`Curriculum progress ${data.percent}%`}
          className="h-1.5 w-24 bg-amber-500/15 [&_[data-slot=progress-indicator]]:bg-amber-500"
        />
        <Button asChild size="sm" variant="outline" className="h-7 gap-1.5 border-amber-500/40 text-xs text-amber-700 hover:bg-amber-500/10 dark:text-amber-400">
          <Link href={`/learn?step=${next.id}`}>
            Resume
            <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        </Button>
      </div>
    </div>
  )
}

export default function HomePage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [seeding, setSeeding] = useState(false)

  const { data, isLoading } = useQuery<ApiStats>({
    queryKey: ['stats'],
    queryFn: async () => {
      const res = await fetch('/api/stats')
      if (!res.ok) throw new Error('Failed to load stats')
      return res.json()
    },
  })

  const healthQuery = useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: () => apiJson<HealthResponse>('/api/health'),
  })
  const health = healthQuery.data

  // M9 (7-c): shared session cache — powers the signed-in chip below.
  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const canEdit = sessionQuery.data?.role === 'admin' || sessionQuery.data?.role === 'editor'
  const staleDatasets =
    health?.datasets.filter((d) => d.freshnessMinutes > STALE_THRESHOLD_MINUTES).length ?? 0

  const seedMutation = useMutation({
    mutationFn: async (): Promise<SeedResponse> => {
      const res = await fetch('/api/seed', { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? 'Seeding failed')
      }
      return res.json()
    },
    onSuccess: (res) => {
      toast.success('Sample data loaded', {
        description:
          res.datasets.length > 0
            ? `Ingested ${res.datasets.length} datasets: ${res.datasets.join(', ')}`
            : 'Sample datasets already present.',
      })
      queryClient.invalidateQueries()
    },
    onError: (err: Error) => toast.error('Seeding failed', { description: err.message }),
  })

  const newPipelineMutation = useMutation({
    mutationFn: async (): Promise<{ pipeline: { id: string; name: string } }> => {
      const res = await fetch('/api/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Untitled pipeline' }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? 'Failed to create pipeline')
      }
      return res.json()
    },
    onSuccess: (res) => {
      toast.success('Pipeline created', { description: res.pipeline.name })
      queryClient.invalidateQueries({ queryKey: ['pipelines'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
      router.push(`/pipelines/${res.pipeline.id}`)
    },
    onError: (err: Error) => toast.error('Could not create pipeline', { description: err.message }),
  })

  const handleSeed = () => {
    setSeeding(true)
    seedMutation.mutate(undefined, { onSettled: () => setSeeding(false) })
  }

  const hasNoData = data !== undefined && data.datasets === 0

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* Page header (compact Foundry pattern) */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <LayoutDashboard className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className="truncate text-sm font-medium tracking-tight text-foreground">
            Platform Overview
          </h1>
          {data && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {data.datasets} dataset{data.datasets === 1 ? '' : 's'} ·{' '}
              {data.pipelines} pipeline{data.pipelines === 1 ? '' : 's'} ·{' '}
              {data.runs} run{data.runs === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canEdit && <Button
            size="sm"
            onClick={() => newPipelineMutation.mutate()}
            disabled={newPipelineMutation.isPending}
          >
              {newPipelineMutation.isPending ? (
                <Sparkles className="h-4 w-4 animate-pulse" aria-hidden />
              ) : (
                <Play className="h-4 w-4" aria-hidden />
              )}
              New pipeline
            </Button>}
          {canEdit && <Button asChild size="sm" variant="outline">
            <Link href="/connectors">
              <Upload className="h-4 w-4" aria-hidden />
              Upload data
            </Link>
          </Button>}
        </div>
      </div>

      {/* Empty state — no data yet */}
      {hasNoData && (
        <Card className="mb-4 border-dashed">
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <Database className="h-8 w-8 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium text-foreground">No data yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                {canEdit
                  ? 'Load the sample supply-chain pack to explore datasets, pipelines and lineage.'
                  : 'No datasets are available yet. Ask an editor or organization administrator to load data.'}
              </p>
            </div>
            {canEdit && <Button size="sm" onClick={handleSeed} disabled={seedMutation.isPending}>
              {seedMutation.isPending ? (
                <>
                  <Sparkles className="h-4 w-4 animate-pulse" aria-hidden />
                  Loading sample data…
                </>
              ) : (
                <>
                  <Database className="h-4 w-4" aria-hidden />
                  Load sample supply-chain data
                </>
              )}
            </Button>}
          </CardContent>
        </Card>
      )}

      {/* P3: resume the guided curriculum from where you left off */}
      <CurriculumResumeBanner canEdit={canEdit} />

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Projects"
          icon={Workflow}
          value={data?.projects ?? 0}
          loading={isLoading}
          href="/projects"
        />
        <StatCard title="Datasets" icon={Boxes} value={data?.datasets ?? 0} loading={isLoading} />
        <StatCard title="Pipelines" icon={GitBranch} value={data?.pipelines ?? 0} loading={isLoading} />
        <StatCard
          title="Pipeline Runs"
          icon={Play}
          value={data?.runs ?? 0}
          loading={isLoading}
        >
          {data && data.runs > 0 && (
            <div
              className="flex items-center gap-1.5 pb-1"
              title={`${data.successRuns} succeeded · ${data.failedRuns} failed`}
              aria-label={`${data.successRuns} succeeded, ${data.failedRuns} failed`}
            >
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
              <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400">{data.successRuns}</span>
              <span className="inline-block ml-1 h-2 w-2 rounded-full bg-rose-500" aria-hidden />
              <span className="font-mono text-xs text-rose-600 dark:text-rose-400">{data.failedRuns}</span>
            </div>
          )}
        </StatCard>
      </div>

      {/* Platform health chip row */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {health && (
          <Link
            href="/orchestration"
            className="group inline-flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={`Platform health — success rate ${health.successRatePct}%, ${health.failingPipelines.length} failing pipeline${health.failingPipelines.length === 1 ? '' : 's'}, ${staleDatasets} stale dataset${staleDatasets === 1 ? '' : 's'}. Open orchestration.`}
          >
            <span className="flex items-center gap-1.5">
              <HeartPulse
                className={`h-3 w-3 ${health.failingPipelines.length > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}
                aria-hidden
              />
              <span className="text-muted-foreground group-hover:text-foreground">Platform Health</span>
            </span>
            <span aria-hidden className="text-border">|</span>
            <span>
              success{' '}
              <span
                className={
                  health.successRatePct >= 95
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : health.successRatePct >= 70
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-rose-600 dark:text-rose-400'
                }
              >
                {health.successRatePct}%
              </span>
            </span>
            <span aria-hidden className="text-border">|</span>
            <span>
              failing pipeline{health.failingPipelines.length === 1 ? '' : 's'}{' '}
              <span className={health.failingPipelines.length > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}>
                {health.failingPipelines.length}
              </span>
            </span>
            <span aria-hidden className="text-border">|</span>
            <span>
              stale dataset{staleDatasets === 1 ? '' : 's'}{' '}
              <span className={staleDatasets > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}>
                {staleDatasets}
              </span>
            </span>
          </Link>
        )}
        <OntologyHealthChip />
        <GovernanceHealthChip />
        <CodeWorkbooksChip />
        <ApiChip />
        {sessionQuery.data && <SignedInChip session={sessionQuery.data} />}
      </div>

      {/* Recent runs + recent datasets */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="gap-0 py-0 lg:col-span-3">
          <CardHeader className="flex flex-row items-center justify-between border-b border-border p-4 [.border-b]:pb-4">
            <CardTitle className="text-sm font-medium text-foreground">Recent Runs</CardTitle>
            <Link
              href="/pipelines"
              className="flex items-center gap-1 text-xs text-foreground underline-offset-2 hover:underline"
            >
              All pipelines <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="space-y-2 p-4">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : data && data.recentRuns.length > 0 ? (
              <div className="foundry-scroll overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border bg-muted/40 hover:bg-transparent">
                      <TableHead className="h-9 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Pipeline</TableHead>
                      <TableHead className="h-9 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Status</TableHead>
                      <TableHead className="h-9 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Started</TableHead>
                      <TableHead className="h-9 px-4 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        Duration
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recentRuns.map((run) => (
                      <TableRow key={run.id} className="border-border">
                        <TableCell className="px-4 py-2 text-[13px] text-foreground">
                          {run.pipelineName}
                        </TableCell>
                        <TableCell className="px-4 py-2">
                          <StatusBadge status={run.status} />
                        </TableCell>
                        <TableCell
                          className="px-4 py-2 font-mono text-xs text-muted-foreground"
                          title={format(parseISO(run.startedAt), 'MMM d, HH:mm:ss')}
                        >
                          {formatDistanceToNow(parseISO(run.startedAt), { addSuffix: true })}
                        </TableCell>
                        <TableCell className="px-4 py-2 text-right font-mono text-xs text-muted-foreground">
                          {formatDuration(run.startedAt, run.finishedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="p-4 text-center text-sm text-muted-foreground">
                No runs yet — open a pipeline and press <span className="font-mono text-foreground">Run</span>.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="gap-0 py-0 lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between border-b border-border p-4 [.border-b]:pb-4">
            <CardTitle className="text-sm font-medium text-foreground">Recent Datasets</CardTitle>
            <Link
              href="/datasets"
              className="flex items-center gap-1 text-xs text-foreground underline-offset-2 hover:underline"
            >
              Catalog <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          </CardHeader>
          <CardContent className="p-2">
            {isLoading ? (
              <div className="space-y-2 p-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : data && data.recentDatasets.length > 0 ? (
              <ul className="space-y-1">
                {data.recentDatasets.map((ds) => (
                  <li key={ds.id}>
                    <Link
                      href={`/datasets/${ds.id}`}
                      className="flex items-center justify-between gap-2 rounded-md border border-transparent px-3 py-2 transition-colors hover:bg-accent"
                    >
                      <span className="truncate text-[13px] text-foreground">{ds.name}</span>
                      <span className="shrink-0 text-right">
                        <span className="block font-mono text-xs text-muted-foreground">
                          {ds.rowCount.toLocaleString()} rows
                        </span>
                        <span className="block font-mono text-[10px] text-muted-foreground">
                          {formatDistanceToNow(parseISO(ds.updatedAt), { addSuffix: true })}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4 text-center text-sm text-muted-foreground">
                Nothing ingested yet — visit{' '}
                <Link href="/connectors" className="text-foreground underline-offset-2 hover:underline">
                  Connectors
                </Link>
                .
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
