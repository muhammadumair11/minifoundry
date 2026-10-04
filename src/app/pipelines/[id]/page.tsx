'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeTypes,
  type OnSelectionChangeParams,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { toast } from 'sonner'
import { useTheme } from 'next-themes'
import { ChevronDown, Loader2, Maximize2, NotebookPen, Play, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useFocusMode } from '@/components/foundry/focus-mode'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
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
import { StatusBadge } from '@/components/foundry/status-badge'
import { BuilderDatasetsContext } from '@/components/foundry/builder/builder-context'
import { FlowNode, type AppNode } from '@/components/foundry/builder/flow-node'
import { NodePalette } from '@/components/foundry/builder/node-palette'
import { ConfigPanel } from '@/components/foundry/builder/config-panel'
import { RunPanel } from '@/components/foundry/builder/run-panel'
import { VersionsControl } from '@/components/foundry/builder/versions-panel'
import { PipelineAutomation } from '@/components/foundry/pipeline-automation-card'
import { defaultNodeData, NODE_META } from '@/components/foundry/builder/node-meta'
import { formatDuration, shortId } from '@/lib/foundry-types'
import type {
  DatasetSummary,
  DatasetsListResponse,
  GraphNodeData,
  NodeTypeName,
  PipelineDetailResponse,
  PipelineGraph,
  PipelineVersionsResponse,
  RunSummary,
} from '@/lib/foundry-types'

type AppEdge = Edge

// R14 (additive): the pipeline GET payload gained trigger-automation fields;
// extend the shared type locally (foundry-types.ts is shared — keep this local).
type PipelineDetailWithAutomation = PipelineDetailResponse & {
  pipeline: { triggerMode?: string; upstreamDatasetIds?: string[]; maxRetries?: number }
}

type QueuedJobResponse = { job: {
  id: string
  status: string
  lastRunId?: string | null
  error?: string | null
} }

const nodeTypes: NodeTypes = {
  source: FlowNode,
  filter: FlowNode,
  derive: FlowNode,
  select: FlowNode,
  rename: FlowNode,
  join: FlowNode,
  aggregate: FlowNode,
  sort: FlowNode,
  dedupe: FlowNode,
  union: FlowNode,
  limit: FlowNode,
  output: FlowNode,
}

const EDGE_STYLE = { stroke: '#71717a' } // zinc-500

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

// Canonical graph body — exactly the shape PUT persists (id/type/data/position,
// id/source/target). Used both for saving and for M3.1 dirty tracking so a
// clean canvas never mints a redundant version snapshot.
function canonicalGraph(nodes: AppNode[], edges: AppEdge[]) {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, data: n.data, position: n.position })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  }
}

function canonicalGraphFromApi(graph: PipelineGraph | null | undefined) {
  return {
    nodes: (graph?.nodes ?? []).map((n) => ({
      id: n.id,
      type: n.type,
      data: n.data ?? {},
      position: n.position ?? { x: 0, y: 0 },
    })),
    edges: (graph?.edges ?? []).map((e) => ({ id: e.id, source: e.source, target: e.target })),
  }
}

function Builder() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const queryClient = useQueryClient()
  const rf = useReactFlow()
  const [, setFocus] = useFocusMode()
  // Theme-aware canvas (12-c): ReactFlow dots/mask follow light|dark.
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const pipelineQuery = useQuery<PipelineDetailWithAutomation>({
    queryKey: ['pipeline', id],
    queryFn: async () => apiJson(`/api/pipelines/${id}`),
  })

  const datasetsQuery = useQuery<DatasetsListResponse>({
    queryKey: ['datasets'],
    queryFn: async () => apiJson('/api/datasets'),
  })
  const datasets: DatasetSummary[] = useMemo(() => datasetsQuery.data?.datasets ?? [], [datasetsQuery])
  const datasetsById = useMemo(() => new Map(datasets.map((d) => [d.id, d])), [datasets])

  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<AppEdge>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [runPanelOpen, setRunPanelOpen] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)
  const jobQuery = useQuery<QueuedJobResponse>({
    queryKey: ['execution-job', pendingJobId],
    queryFn: () => apiJson(`/api/execution-jobs/${pendingJobId}`),
    enabled: pendingJobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.job.status
      return status === 'succeeded' || status === 'failed' ? false : 2_000
    },
  })
  useEffect(() => {
    if (!pendingJobId) return
    if (jobQuery.isError) {
      toast.error('Could not refresh run status', { description: 'The job remains visible in Orchestration.' })
      setPendingJobId(null)
      setRunning(false)
      return
    }
    const job = jobQuery.data?.job
    if (!job || (job.status !== 'succeeded' && job.status !== 'failed')) return
    setPendingJobId(null)
    setRunning(false)
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['pipeline', id] }),
      queryClient.invalidateQueries({ queryKey: ['stats'] }),
      queryClient.invalidateQueries({ queryKey: ['lineage'] }),
      queryClient.invalidateQueries({ queryKey: ['datasets'] }),
      queryClient.invalidateQueries({ queryKey: ['runs'] }),
      queryClient.invalidateQueries({ queryKey: ['health'] }),
      queryClient.invalidateQueries({ queryKey: ['pipeline-versions', id] }),
    ])
    if (job.lastRunId) {
      setSelectedRunId(job.lastRunId)
      setRunPanelOpen(true)
      setTimeout(() => runPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100)
    }
    if (job.status === 'succeeded') toast.success('Run succeeded')
    else toast.error('Run failed', { description: job.error ?? 'Check the run logs in Orchestration.' })
  }, [pendingJobId, jobQuery.data, jobQuery.isError, queryClient, id])
  const [saveNoteOpen, setSaveNoteOpen] = useState(false)
  const [versionNote, setVersionNote] = useState('')
  const initializedRef = useRef(false)
  const runPanelRef = useRef<HTMLDivElement | null>(null)
  // M3.1: canonical JSON of the last loaded/saved graph — dirty-tracking ref
  // so Run/Save only snapshot when the canvas actually differs.
  const savedGraphRef = useRef<string>('')

  // Seed the flow state from a graph payload; also records it as the saved
  // baseline. Used by the one-shot init effect AND after restores (which must
  // re-seed the canvas imperatively — refetches never clobber edits).
  const applyGraph = useCallback(
    (graph: PipelineGraph | null | undefined) => {
      const g = graph ?? { nodes: [], edges: [] }
      setNodes(
        g.nodes.map((n) => ({
          id: n.id,
          type: n.type,
          data: (n.data ?? {}) as GraphNodeData,
          position: n.position ?? { x: 0, y: 0 },
        })),
      )
      setEdges(
        g.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          animated: true,
          style: { ...EDGE_STYLE },
        })),
      )
      savedGraphRef.current = JSON.stringify(canonicalGraphFromApi(g))
      if (g.nodes.length > 0) {
        setTimeout(() => rf.fitView({ padding: 0.2, maxZoom: 1.1, duration: 300 }), 60)
      }
    },
    [setNodes, setEdges, rf],
  )

  // Load graph from the server exactly once (refetches must not clobber edits).
  useEffect(() => {
    const data = pipelineQuery.data
    if (!data || initializedRef.current) return
    initializedRef.current = true
    applyGraph(data.pipeline.graph)
    setNameInput(data.pipeline.name)
    setSelectedRunId(data.runs[0]?.id ?? null)
  }, [pipelineQuery.data, applyGraph])

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            id: `e-${connection.source}-${connection.target}-${Date.now()}`,
            animated: true,
            style: { ...EDGE_STYLE },
          },
          eds,
        ),
      )
    },
    [setEdges],
  )

  const onSelectionChange = useCallback(({ nodes: selected }: OnSelectionChangeParams) => {
    setSelectedNodeId(selected[0]?.id ?? null)
  }, [])

  const onPaneClick = useCallback(() => setSelectedNodeId(null), [])

  const addNode = useCallback(
    (type: NodeTypeName) => {
      const newNode: AppNode = {
        id: `${type}-${Date.now()}`,
        type,
        position: { x: 80 + nodes.length * 40, y: 80 + (nodes.length % 5) * 90 },
        data: defaultNodeData(type),
      }
      setNodes((nds) => [...nds, newNode])
      setSelectedNodeId(newNode.id)
      toast.info(`${NODE_META[type].label} node added`, {
        description: NODE_META[type].hint,
      })
    },
    [nodes.length, setNodes],
  )

  const updateNodeData = useCallback(
    (nodeId: string, patch: Partial<GraphNodeData>) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)),
      )
    },
    [setNodes],
  )

  const deleteNodeById = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId))
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
      setSelectedNodeId((current) => (current === nodeId ? null : current))
      toast.info('Node removed')
    },
    [setNodes, setEdges],
  )

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  )

  // M3.1: canvas differs from the last loaded/saved graph?
  const isDirty = useMemo(() => {
    if (!initializedRef.current || !savedGraphRef.current) return false
    return JSON.stringify(canonicalGraph(nodes, edges)) !== savedGraphRef.current
  }, [nodes, edges])

  const runs: RunSummary[] = pipelineQuery.data?.runs ?? []
  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null
  const latestRun = runs[0] ?? null

  const validateGraph = (): boolean => {
    if (nodes.length === 0) {
      toast.error('Cannot save an empty graph', {
        description: 'Add at least a source node and one output node.',
      })
      return false
    }
    const outputs = nodes.filter((n) => n.type === 'output')
    if (outputs.length !== 1) {
      toast.error('Exactly one output node required', {
        description: `Found ${outputs.length} output node${outputs.length === 1 ? '' : 's'}.`,
      })
      return false
    }
    return true
  }

  const savePipeline = useCallback(
    async (opts?: { silent?: boolean; versionNote?: string }): Promise<boolean> => {
      if (!validateGraph()) return false
      setSaving(true)
      try {
        await apiJson(`/api/pipelines/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: nameInput.trim() || 'Untitled pipeline',
            graph: canonicalGraph(nodes, edges),
            // M3.1: free-text label stored on the version snapshot this save
            // creates (name-only saves never snapshot).
            ...(opts?.versionNote ? { versionNote: opts.versionNote } : {}),
          }),
        })
        savedGraphRef.current = JSON.stringify(canonicalGraph(nodes, edges))
        await queryClient.invalidateQueries({ queryKey: ['pipeline', id] })
        await queryClient.invalidateQueries({ queryKey: ['pipelines'] })
        // Every graph save snapshots a version — refresh the versions panel
        // (awaited so the toast below can read the new version number).
        await queryClient.invalidateQueries({ queryKey: ['pipeline-versions', id] })
        if (!opts?.silent) {
          const versionsData = queryClient.getQueryData<PipelineVersionsResponse>([
            'pipeline-versions',
            id,
          ])
          const newVersion = versionsData?.versions[0]?.versionNumber
          if (newVersion !== undefined) {
            toast.success(`Pipeline saved as v${newVersion}`, {
              description: opts?.versionNote || `Graph snapshotted as version v${newVersion}.`,
            })
          } else {
            toast.success('Pipeline saved')
          }
        }
        return true
      } catch (err) {
        toast.error('Save failed', {
          description: err instanceof Error ? err.message : 'Unknown error',
        })
        return false
      } finally {
        setSaving(false)
      }
    },
    // validateGraph reads current state; including it keeps the callback fresh.
    [id, nameInput, nodes, edges, queryClient],
  )

  const handleSaveWithNote = useCallback(async () => {
    const ok = await savePipeline({ versionNote: versionNote.trim() || undefined })
    if (ok) {
      setSaveNoteOpen(false)
      setVersionNote('')
    }
  }, [savePipeline, versionNote])

  // M3.1: re-seed the canvas from the restored graph (the one-shot init effect
  // stays closed; restore applies the authoritative response graph directly).
  const handleRestored = useCallback(
    (graph: PipelineGraph | null) => {
      applyGraph(graph)
      toast.info('Canvas reloaded', {
        description: 'The restored graph replaced the canvas contents.',
      })
    },
    [applyGraph],
  )

  const handleRename = useCallback(async () => {
    const current = pipelineQuery.data?.pipeline.name
    if (!current || nameInput.trim() === current || !nameInput.trim()) return
    try {
      await apiJson(`/api/pipelines/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.trim() }),
      })
      toast.success('Renamed', { description: nameInput.trim() })
      await queryClient.invalidateQueries({ queryKey: ['pipeline', id] })
      await queryClient.invalidateQueries({ queryKey: ['pipelines'] })
    } catch (err) {
      toast.error('Rename failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }, [id, nameInput, pipelineQuery.data, queryClient])

  const handleRun = useCallback(async () => {
    if (isDirty) {
      const saved = await savePipeline({ silent: true })
      if (!saved) return
    }
    setRunning(true)
    try {
      const { job } = await apiJson<QueuedJobResponse>(`/api/pipelines/${id}/run`, { method: 'POST' })
      setPendingJobId(job.id)
      toast.message('Run queued', { description: `Job ${shortId(job.id, 8)} is waiting for the worker.` })
    } catch (err) {
      setRunning(false)
      toast.error('Run request failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }, [id, savePipeline, isDirty])

  if (pipelineQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-3 px-4 py-8">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-[520px] w-full" />
      </div>
    )
  }

  if (pipelineQuery.isError || !pipelineQuery.data) {
    return (
      <div className="px-4 py-16 text-center">
        <p className="text-sm text-rose-600 dark:text-rose-400">
          {pipelineQuery.error instanceof Error
            ? pipelineQuery.error.message
            : 'Pipeline not found.'}
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/pipelines">Back to pipelines</Link>
        </Button>
      </div>
    )
  }

  return (
    <BuilderDatasetsContext.Provider value={datasets}>
      <div className="flex min-h-[560px] flex-col overflow-hidden lg:min-h-0 lg:flex-1">
        {/* ── Toolbar ── */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
          <Input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={() => void handleRename()}
            aria-label="Pipeline name"
            className="h-8 min-w-0 max-w-[240px] border-transparent bg-transparent px-2 text-sm font-medium text-foreground hover:border-border focus-visible:border-border"
          />
          {latestRun && (
            <div className="hidden items-center gap-2 sm:flex" title="Latest run">
              <StatusBadge status={latestRun.status} />
              <span className="font-mono text-[10px] text-muted-foreground">
                {formatDuration(latestRun.startedAt, latestRun.finishedAt)}
              </span>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            {/* R14: trigger automation (upstream + retries) — editor-gated dialog. */}
            <div className="hidden md:block">
              <PipelineAutomation
                pipelineId={id}
                config={{
                  triggerMode: pipelineQuery.data.pipeline.triggerMode ?? 'manual',
                  upstreamDatasetIds: pipelineQuery.data.pipeline.upstreamDatasetIds ?? [],
                  maxRetries: pipelineQuery.data.pipeline.maxRetries ?? 0,
                }}
                datasets={datasets}
              />
            </div>
            <button
              type="button"
              onClick={() => setFocus(true)}
              aria-label="Focus mode — hide app chrome (Esc exits)"
              title="Focus mode (Esc exits)"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Maximize2 className="h-4 w-4" aria-hidden />
            </button>
            <VersionsControl
              pipelineId={id}
              versionCount={pipelineQuery.data.pipeline.versionCount}
              onRestored={handleRestored}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => void savePipeline()}
              disabled={saving || running}
              className="h-8 gap-1.5 text-xs"
              aria-label="Save pipeline"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Save className="h-3.5 w-3.5" aria-hidden />
              )}
              Save
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving || running}
                  className="h-8 w-6 px-0"
                  aria-label="More save options"
                >
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => void savePipeline()}
                  className="gap-1.5 text-xs"
                >
                  <Save className="h-3.5 w-3.5" aria-hidden />
                  Save
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSaveNoteOpen(true)}
                  className="gap-1.5 text-xs"
                >
                  <NotebookPen className="h-3.5 w-3.5" aria-hidden />
                  Save with note…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              onClick={() => void handleRun()}
              disabled={saving || running}
              className="relative h-8 gap-1.5 text-xs"
              aria-label="Run pipeline"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Play className="h-3.5 w-3.5" aria-hidden />
              )}
              {pendingJobId ? (jobQuery.data?.job.status === 'running' ? 'Running' : 'Queued') : 'Run'}
              {running && (
                <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5" aria-hidden>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full border border-background bg-emerald-500" />
                </span>
              )}
            </Button>
          </div>
        </div>

        {/* Mobile palette chips */}
        <div className="px-3 pt-2 lg:hidden">
          <NodePalette compact onAdd={addNode} />
        </div>

        {/* ── Main area + Run panel share vertical space ── */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <NodePalette onAdd={addNode} className="hidden lg:flex" />

            <div className="relative min-h-[300px] flex-1 lg:min-h-[300px]">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onSelectionChange={onSelectionChange}
                onPaneClick={onPaneClick}
                nodeTypes={nodeTypes}
                colorMode={isDark ? 'dark' : 'light'}
                fitView
                fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
                minZoom={0.2}
                deleteKeyCode={['Backspace', 'Delete']}
                className="bg-background"
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={22}
                  size={1.4}
                  color={isDark ? '#3f3f46' : '#d4d4d8'}
                />
                <Controls showInteractive={false} position="bottom-left" />
              </ReactFlow>
            </div>

            {/* Desktop config panel */}
            <aside className="hidden w-80 shrink-0 border-l border-border bg-muted/30 lg:block">
              <ConfigPanel
                node={selectedNode}
                datasets={datasets}
                onPatchData={updateNodeData}
                onDelete={deleteNodeById}
                nodeCount={nodes.length}
                edgeCount={edges.length}
              />
            </aside>
          </div>

          {/* Mobile config panel */}
          {selectedNode && (
            <div className="max-h-[45vh] overflow-y-auto border-t border-border bg-muted/30 foundry-scroll lg:hidden">
              <ConfigPanel
                node={selectedNode}
                datasets={datasets}
                onPatchData={updateNodeData}
                onDelete={deleteNodeById}
                nodeCount={nodes.length}
                edgeCount={edges.length}
              />
            </div>
          )}

          {/* ── Run panel — shrinks canvas above it ── */}
          <div ref={runPanelRef} className="shrink-0">
            {runPanelOpen && (
              <RunPanel
                runs={runs}
                selectedRun={selectedRun}
                onSelectRun={setSelectedRunId}
                onClose={() => setRunPanelOpen(false)}
              />
            )}
          </div>
        </div>

        {/* Save with a version note (M3.1) — snapshots the graph as the next
            immutable version and stores the note on it. */}
        <Dialog open={saveNoteOpen} onOpenChange={setSaveNoteOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-base text-foreground">Save pipeline</DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                Snapshots the current graph as the next immutable version. Runs will pin it.
              </DialogDescription>
            </DialogHeader>
            <Input
              value={versionNote}
              onChange={(e) => setVersionNote(e.target.value)}
              placeholder="Version note — what changed? (optional)"
              aria-label="Version note"
              className="text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSaveWithNote()
              }}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setSaveNoteOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void handleSaveWithNote()}
                disabled={saving}
                className="gap-1.5"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Save className="h-4 w-4" aria-hidden />
                )}
                Save version
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </BuilderDatasetsContext.Provider>
  )
}

export default function PipelineBuilderPage() {
  return (
    <ReactFlowProvider>
      <Builder />
    </ReactFlowProvider>
  )
}
