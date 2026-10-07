'use client'

import { useRouter } from '@/lib/next-navigation'
import Link from '@/components/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { toast } from 'sonner'
import { GitBranch, History, Loader2, Network, Play, Plus, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/foundry/status-badge'
import { apiJson } from '@/lib/foundry-api'
import type {
  CreatePipelineResponse,
  PipelineVersionsResponse,
  PipelinesListResponse,
} from '@/lib/foundry-types'

// M3.1: latest-version badge on a pipeline card ("v3 · 3 versions"). Reads
// the shared ['pipeline-versions', id] cache (same key the builder panel uses).
// Renders nothing while loading / on error / when no versions exist yet.
function PipelineVersionBadge({ pipelineId }: { pipelineId: string }) {
  const { data, isLoading } = useQuery<PipelineVersionsResponse>({
    queryKey: ['pipeline-versions', pipelineId],
    queryFn: () => apiJson<PipelineVersionsResponse>(`/api/pipelines/${pipelineId}/versions`),
    staleTime: 30_000,
  })
  const versions = data?.versions ?? []
  if (isLoading || versions.length === 0) return null
  const latest = versions[0]
  return (
    <span className="flex items-center gap-1" title="Latest pipeline version">
      <History className="h-3 w-3" aria-hidden />
      <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1 text-[10px] leading-4 text-emerald-600 dark:text-emerald-400">
        v{latest.versionNumber}
      </span>
      <span aria-hidden className="text-muted-foreground/80">
        ·
      </span>
      <span>
        {versions.length} {versions.length === 1 ? 'version' : 'versions'}
      </span>
    </span>
  )
}

export default function PipelinesPage() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery<PipelinesListResponse>({
    queryKey: ['pipelines'],
    queryFn: async () => {
      const res = await fetch('/api/pipelines')
      if (!res.ok) throw new Error('Failed to load pipelines')
      return res.json()
    },
  })

  const createMutation = useMutation({
    mutationFn: async (): Promise<CreatePipelineResponse> => {
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

  const pipelines = data?.pipelines ?? []

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* Header (compact Foundry pattern) */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className="truncate text-sm font-medium tracking-tight text-foreground">Pipelines</h1>
          {data && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {data.pipelines.length} pipelines · {data.pipelines.reduce((n, p) => n + p.runsCount, 0)} runs
            </span>
          )}
        </div>
        <Button
          size="sm"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="shrink-0"
        >
          {createMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Plus className="h-4 w-4" aria-hidden />
          )}
          New pipeline
        </Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      ) : pipelines.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <Workflow className="h-8 w-8 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium text-foreground">No pipelines yet</p>
              <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                Pipelines transform datasets: pick a source, add filter / join / aggregate steps on
                the visual canvas, and run it to write a new dataset version. Create one and wire
                it to your data.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Create your first pipeline
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pipelines.map((p) => {
            const nodeCount = p.graph?.nodes?.length ?? 0
            return (
              <Link
                key={p.id}
                href={`/pipelines/${p.id}`}
                className="group rounded-lg border border-border bg-card transition-colors hover:border-foreground/25"
                aria-label={`Open pipeline ${p.name}`}
              >
                <CardContent className="flex h-full flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/50">
                        <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden />
                      </span>
                      <h2 className="truncate text-sm font-medium text-foreground">
                        {p.name}
                      </h2>
                    </div>
                  </div>
                  {p.description && (
                    <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{p.description}</p>
                  )}
                  <div className="mt-auto space-y-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Network className="h-3 w-3" aria-hidden />
                        {nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}
                      </span>
                      <span className="flex items-center gap-1">
                        <Play className="h-3 w-3" aria-hidden />
                        {p.runsCount} {p.runsCount === 1 ? 'run' : 'runs'}
                      </span>
                      <PipelineVersionBadge pipelineId={p.id} />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      {p.lastRun ? (
                        <>
                          <StatusBadge status={p.lastRun.status} />
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {formatDistanceToNow(parseISO(p.lastRun.startedAt), {
                              addSuffix: true,
                            })}
                          </span>
                        </>
                      ) : (
                        <span className="font-mono text-[11px] text-muted-foreground/80">
                          never run — click to open builder
                        </span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
