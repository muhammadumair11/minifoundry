'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useTheme } from 'next-themes'
import { Boxes, GitBranch, Info, Radar, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { apiJson } from '@/lib/foundry-api'
import type {
  LineageGraph,
  LineageImpactResponse,
  LineageNode,
  PipelinesListResponse,
  VersionLineageResponse,
} from '@/lib/foundry-types'

interface LineageNodeData extends Record<string, unknown> {
  name: string
  kind: 'source' | 'derived'
  rowCount: number
  highlighted: boolean
  selected?: boolean
  onSelect?: (id: string) => void
}

type LineageFlowNode = Node<LineageNodeData, 'dataset'>

const nodeTypes: NodeTypes = { dataset: DatasetNode }

function DatasetNode({ id, data }: NodeProps<LineageFlowNode>) {
  const d = data as LineageNodeData
  const isSource = d.kind === 'source'
  return (
    <button
      type="button"
      onClick={() => d.onSelect?.(id)}
      className={cn(
        'w-52 rounded-md border border-border bg-card text-left shadow-sm transition-colors hover:border-foreground/40',
        d.highlighted && 'border-2 border-foreground ring-2 ring-foreground/20',
        d.selected && 'border-2 border-amber-500/70 ring-2 ring-amber-500/20',
      )}
      aria-label={`Inspect dataset ${d.name}`}
    >
      <span
        className={cn('block h-1 rounded-t-md', isSource ? 'bg-emerald-500' : 'bg-rose-500')}
        aria-hidden
      />
      <span className="block px-3 py-2">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium text-foreground">{d.name}</span>
          <span
            className={cn(
              'shrink-0 rounded border px-1 py-0 font-mono text-[9px]',
              isSource
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
            )}
          >
            {d.kind}
          </span>
        </span>
        <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
          {d.rowCount.toLocaleString()} rows
        </span>
      </span>
      <Handle type="target" position={Position.Left} aria-label={`${d.name} input`} />
      <Handle type="source" position={Position.Right} aria-label={`${d.name} output`} />
    </button>
  )
}

/** Simple layered layout: sources on the left, one column per hop. */
function layoutGraph(
  lineageNodes: LineageNode[],
  edges: { from: string; to: string }[],
): Map<string, { x: number; y: number }> {
  const incoming = new Map<string, string[]>()
  for (const e of edges) {
    const list = incoming.get(e.to) ?? []
    list.push(e.from)
    incoming.set(e.to, list)
  }
  const layerOf = new Map<string, number>()

  const compute = (nodeId: string, path: Set<string>): number => {
    const cached = layerOf.get(nodeId)
    if (cached !== undefined) return cached
    if (path.has(nodeId)) return 0 // cycle guard
    path.add(nodeId)
    const preds = incoming.get(nodeId) ?? []
    const depth = preds.length === 0 ? 0 : Math.max(...preds.map((p) => compute(p, path))) + 1
    path.delete(nodeId)
    layerOf.set(nodeId, depth)
    return depth
  }
  lineageNodes.forEach((n) => compute(n.id, new Set()))

  const byLayer = new Map<number, string[]>()
  for (const n of lineageNodes) {
    const layer = layerOf.get(n.id) ?? 0
    const list = byLayer.get(layer) ?? []
    list.push(n.id)
    byLayer.set(layer, list)
  }

  const positions = new Map<string, { x: number; y: number }>()
  for (const [layer, idsInLayer] of byLayer) {
    idsInLayer.sort((a, b) => a.localeCompare(b))
    idsInLayer.forEach((nodeId, i) => {
      positions.set(nodeId, {
        x: layer * 320,
        y: (i - (idsInLayer.length - 1) / 2) * 150 + 300,
      })
    })
  }
  return positions
}

/**
 * P2: impact + provenance side panel — what sits downstream of the selected
 * dataset (transitive, via the dataset-level graph) and which exact versions
 * fed / consume the selected version (version-level lineage).
 */
function ImpactPanel({ datasetId, onClose }: { datasetId: string; onClose: () => void }) {
  const impactQuery = useQuery<LineageImpactResponse>({
    queryKey: ['lineage-impact', datasetId],
    queryFn: () => apiJson<LineageImpactResponse>(`/api/lineage/impact?datasetId=${datasetId}`),
  })

  // Provenance of the root dataset's head version (headVersion comes from the
  // impact payload; fall back to 0 until it loads — the query stays idle then).
  const headVersion = impactQuery.data?.root.headVersion ?? 0
  const versionsQuery = useQuery<VersionLineageResponse>({
    queryKey: ['lineage-versions', datasetId, headVersion],
    enabled: headVersion > 0,
    queryFn: () =>
      apiJson<VersionLineageResponse>(
        `/api/lineage/versions?datasetId=${datasetId}&versionNumber=${headVersion}`,
      ),
  })

  const impact = impactQuery.data

  return (
    <aside
      aria-label="Dataset impact panel"
      className="flex max-h-[calc(100dvh-19rem)] min-h-[460px] w-full flex-col rounded-lg border border-border bg-card lg:w-80 lg:shrink-0"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border p-3">
        <div className="flex min-w-0 items-center gap-2">
          <Radar className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="truncate text-xs font-medium text-foreground">
            {impact?.root.name ?? 'Impact'}
            {impact && (
              <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                head v{impact.root.headVersion}
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Close impact panel"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <div className="foundry-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {/* Downstream impact */}
        <section>
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Downstream impact
          </p>
          {impactQuery.isLoading ? (
            <div className="mt-2 space-y-1.5">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-4/5" />
            </div>
          ) : impactQuery.isError ? (
            <p className="mt-2 text-[11px] text-rose-600 dark:text-rose-400">Failed to compute impact.</p>
          ) : impact && impact.affected.length > 0 ? (
            <>
              <p className="mt-1 text-[11px] text-muted-foreground">
                A change here propagates to{' '}
                <span className="font-medium text-foreground">
                  {impact.total} dataset{impact.total === 1 ? '' : 's'}
                </span>{' '}
                across {impact.maxDepth} hop{impact.maxDepth === 1 ? '' : 's'}.
              </p>
              <ol className="mt-2 space-y-1.5">
                {impact.affected.map((a) => (
                  <li key={a.id} className="rounded-md border border-border bg-background px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Link
                        href={`/datasets/${a.id}`}
                        className="min-w-0 truncate text-[11px] font-medium text-foreground underline-offset-2 hover:underline"
                      >
                        {a.name}
                      </Link>
                      <span className="shrink-0 rounded border border-border bg-muted px-1 font-mono text-[9px] text-muted-foreground">
                        hop {a.depth}
                      </span>
                    </div>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      v{a.headVersion} · {a.rowCount.toLocaleString()} rows
                      {a.viaPipelineName ? ` · via ${a.viaPipelineName}` : ''}
                      {a.gated ? ' · gated' : ''}
                    </p>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Nothing downstream — no pipelines consume this dataset.
            </p>
          )}
        </section>

        {/* Version provenance */}
        <section>
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Version provenance
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Which exact versions produced v{headVersion} — and what it fed.
          </p>
          {versionsQuery.isLoading || (headVersion === 0 && impactQuery.isLoading) ? (
            <div className="mt-2 space-y-1.5">
              <Skeleton className="h-6 w-full" />
            </div>
          ) : versionsQuery.data &&
            (versionsQuery.data.upstream.length > 0 || versionsQuery.data.downstream.length > 0) ? (
            <div className="mt-2 space-y-2">
              {versionsQuery.data.upstream.length > 0 && (
                <div>
                  <p className="font-mono text-[10px] text-muted-foreground">inputs →</p>
                  <ul className="mt-1 space-y-1">
                    {versionsQuery.data.upstream.map((e) => (
                      <li key={`up-${e.fromDatasetId}`} className="rounded-md border border-border bg-background px-2 py-1.5">
                        <Link
                          href={`/datasets/${e.fromDatasetId}`}
                          className="text-[11px] font-medium text-foreground underline-offset-2 hover:underline"
                        >
                          {e.fromDatasetName} v{e.fromVersionNumber}
                        </Link>
                        {e.runId && (
                          <span
                            className={cn(
                              'ml-1.5 rounded border px-1 font-mono text-[9px]',
                              e.runTrigger === 'upstream'
                                ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400'
                                : e.runTrigger === 'replay'
                                  ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400'
                                  : 'border-border bg-muted text-muted-foreground',
                            )}
                          >
                            {e.runTrigger ?? 'run'}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {versionsQuery.data.downstream.length > 0 && (
                <div>
                  <p className="font-mono text-[10px] text-muted-foreground">fed into →</p>
                  <ul className="mt-1 space-y-1">
                    {versionsQuery.data.downstream.map((e) => (
                      <li key={`down-${e.toDatasetId}-${e.toVersionNumber}`} className="rounded-md border border-border bg-background px-2 py-1.5">
                        <Link
                          href={`/datasets/${e.toDatasetId}`}
                          className="text-[11px] font-medium text-foreground underline-offset-2 hover:underline"
                        >
                          {e.toDatasetName} v{e.toVersionNumber}
                        </Link>
                        {e.pipelineName && (
                          <span className="ml-1.5 font-mono text-[9px] text-muted-foreground">
                            via {e.pipelineName}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground">
              No version-level edges recorded yet — run a pipeline after this update to
              capture them.
            </p>
          )}
        </section>
      </div>

      <div className="border-t border-border p-3">
        <Button asChild size="sm" variant="outline" className="h-8 w-full text-xs">
          <Link href={`/datasets/${datasetId}`}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Open dataset
          </Link>
        </Button>
      </div>
    </aside>
  )
}

function LineageInner() {
  const searchParams = useSearchParams()
  const focusId = searchParams.get('dataset')
  const rf = useReactFlow()
  // Theme-aware canvas (12-c): dots/mask/labels follow light|dark.
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const [nodes, setNodes, onNodesChange] = useNodesState<LineageFlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  // P2: selected dataset for the impact panel (URL focus preselects it).
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const lineageQuery = useQuery<LineageGraph>({
    queryKey: ['lineage'],
    queryFn: async () => {
      const res = await fetch('/api/lineage')
      if (!res.ok) throw new Error('Failed to load lineage')
      return res.json()
    },
  })

  const pipelinesQuery = useQuery<PipelinesListResponse>({
    queryKey: ['pipelines'],
    queryFn: async () => {
      const res = await fetch('/api/pipelines')
      if (!res.ok) throw new Error('Failed to load pipelines')
      return res.json()
    },
  })

  const pipelineNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of pipelinesQuery.data?.pipelines ?? []) map.set(p.id, p.name)
    return map
  }, [pipelinesQuery.data])

  useEffect(() => {
    const data = lineageQuery.data
    if (!data) return
    const positions = layoutGraph(
      data.nodes,
      data.edges.map((e) => ({ from: e.from, to: e.to })),
    )
    setNodes(
      data.nodes.map((n) => ({
        id: n.id,
        type: 'dataset' as const,
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: {
          name: n.name,
          kind: n.kind,
          rowCount: n.rowCount,
          highlighted: n.id === focusId,
          selected: n.id === selectedId,
          onSelect: setSelectedId,
        },
      })),
    )
    setEdges(
      data.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        animated: true,
        label: e.pipelineId ? (pipelineNames.get(e.pipelineId) ?? 'pipeline') : undefined,
        style: { stroke: isDark ? '#52525b' : '#a1a1aa' },
        labelStyle: { fill: isDark ? '#a1a1aa' : '#52525b', fontSize: 10, fontFamily: 'var(--font-geist-mono)' },
        labelBgStyle: { fill: isDark ? '#18181b' : '#fafafa', fillOpacity: 0.9 },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#71717a', width: 16, height: 16 },
      })),
    )
    if (focusId) {
      setTimeout(() => {
        void rf.fitView({ nodes: [{ id: focusId }], duration: 500, maxZoom: 1.4, padding: 3 })
      }, 80)
    }
  }, [lineageQuery.data, pipelineNames, focusId, selectedId, setNodes, setEdges, rf, isDark])

  const nodeCount = lineageQuery.data?.nodes.length ?? 0
  const edgeCount = lineageQuery.data?.edges.length ?? 0

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* Header + legend */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className="text-sm font-medium tracking-tight text-foreground">Lineage</h1>
          <span className="text-xs text-muted-foreground">
            how data flows — sources → pipeline transforms → derived datasets
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px] text-muted-foreground">
            <Boxes className="h-3 w-3" aria-hidden />
            {nodeCount} datasets
          </span>
          <span className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px] text-muted-foreground">
            <GitBranch className="h-3 w-3" aria-hidden />
            {edgeCount} transforms
          </span>
          <span className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px] text-muted-foreground">
            <span aria-hidden className="h-2 w-2 rounded-sm bg-emerald-500" />
            source
          </span>
          <span className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px] text-muted-foreground">
            <span aria-hidden className="h-2 w-2 rounded-sm bg-rose-500" />
            derived
          </span>
        </div>
      </div>

      {/* Canvas + P2 impact panel (row at lg so the canvas height stays definite) */}
      <div className="flex flex-col gap-4 lg:flex-row">
        <div
          className={cn(
            'relative h-[calc(100dvh-19rem)] min-h-[460px] min-w-0 overflow-hidden rounded-lg border border-border bg-background lg:flex-1',
          )}
        >
        {lineageQuery.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <p className="font-mono text-xs text-muted-foreground">loading lineage…</p>
          </div>
        ) : edgeCount === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <Info className="h-8 w-8 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium text-foreground">No lineage edges yet</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                Run a pipeline to build lineage — every successful run records which source
                datasets produced which output.
              </p>
            </div>
            <Button asChild size="sm">
              <Link href="/pipelines">Open pipelines</Link>
            </Button>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            colorMode={isDark ? 'dark' : 'light'}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            minZoom={0.2}
            proOptions={{ hideAttribution: false }}
            className="bg-background"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color={isDark ? '#3f3f46' : '#d4d4d8'} />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap
              pannable
              zoomable
              maskColor={isDark ? 'rgb(9, 9, 11, 0.7)' : 'rgb(250, 250, 250, 0.7)'}
              position="bottom-right"
              className="hidden sm:block"
              nodeColor={(n) => {
                const kind = (n.data as LineageNodeData | undefined)?.kind
                return kind === 'derived' ? '#fb7185' : '#34d399'
              }}
            />
          </ReactFlow>
        )}
      </div>

        {selectedId && (
          <ImpactPanel datasetId={selectedId} onClose={() => setSelectedId(null)} />
        )}
      </div>

      <p className="mt-2 text-center text-[11px] text-muted-foreground/80">
        Click a dataset card to inspect downstream impact and version provenance
        {focusId ? ' · highlighted dataset focused from URL' : ''}
      </p>
    </div>
  )
}

export default function LineagePage() {
  return (
    <ReactFlowProvider>
      <Suspense
        fallback={
          <div className="mx-auto w-full max-w-6xl px-4 py-16 text-center font-mono text-xs text-muted-foreground">
            loading lineage…
          </div>
        }
      >
        <LineageInner />
      </Suspense>
    </ReactFlowProvider>
  )
}
