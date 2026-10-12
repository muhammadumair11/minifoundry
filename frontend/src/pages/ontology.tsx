'use client'

import { useMemo, useState } from 'react'
import Link from '@/components/link'
import { useRouter } from '@/lib/next-navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowRight,
  Circle,
  Database,
  ExternalLink,
  Link2,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Zap,
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { apiJson } from '@/lib/foundry-api'
import { formatRelative } from '@/lib/foundry-types'
import type {
  ActionLogsResponse,
  OntologyObjectType,
  OntologyListResponse,
  OutgoingLinkSummary,
  SeedOntologyResponse,
  SessionResponse,
} from '@/lib/foundry-types'
import { NewObjectTypeDialog } from '@/components/foundry/ontology/new-object-type-dialog'
import { LinkTypeEditor, type EditingLink } from '@/components/foundry/ontology/link-type-editor'
import { ActionTypeEditor, type OntologyActionFull } from '@/components/foundry/ontology/action-type-editor'
import {
  getCardinalityClasses,
  getCardinalityLabel,
  getObjectColorClasses,
  getOperationClasses,
  OntologyIcon,
} from '@/components/foundry/ontology/icon-map'

// ─── Object type card ─────────────────────────────────────────────────

function TypeCard({
  type,
  onRequestDelete,
}: {
  type: OntologyObjectType
  onRequestDelete: (t: OntologyObjectType) => void
}) {
  const router = useRouter()
  const color = getObjectColorClasses(type.color)

  const titleProp = type.properties.find((p) => p.isTitle)
  const previewProps = [titleProp, ...type.properties.filter((p) => !p.isTitle)]
    .filter((p): p is NonNullable<typeof p> => !!p)
    .slice(0, 3)

  const open = () => router.push(`/objects?type=${encodeURIComponent(type.apiName)}`)

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Open ${type.displayName} objects`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
      className="group relative flex cursor-pointer flex-col rounded-lg border border-border bg-card p-4 outline-none transition-colors hover:bg-accent focus-visible:border-foreground/40"
    >
      {/* Icon + names + menu */}
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border',
            color.border,
            color.bg,
          )}
        >
          <OntologyIcon name={type.icon} className={cn('h-5 w-5', color.text)} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{type.displayName}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{type.apiName}</p>
        </div>
        <span
          className="shrink-0"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={`Options for ${type.displayName}`}
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => open()}
                className="text-xs text-foreground"
              >
                <ExternalLink className="mr-2 h-3.5 w-3.5" aria-hidden />
                Open objects
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => onRequestDelete(type)}
                className="text-xs text-rose-600 dark:text-rose-400 hover:!bg-rose-500/10 hover:!text-rose-600"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden />
                Delete type…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>

      {/* Counts + backing dataset */}
      <div className="mt-3 flex items-baseline justify-between gap-2">
        <p className="font-mono text-xs text-foreground">
          {type.objectCount ?? '—'} <span className="text-muted-foreground">objects</span>
        </p>
        {type.sourceDatasetId ? (
          <Link
            href={`/datasets/${type.sourceDatasetId}`}
            onClick={(e) => e.stopPropagation()}
            className="truncate font-mono text-[11px] text-foreground hover:underline underline-offset-2"
            title={`Backing dataset — ${type.sourceDatasetName ?? 'dataset'}`}
          >
            {type.sourceDatasetName ?? 'dataset'}
          </Link>
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground/80">no dataset</span>
        )}
      </div>

      {/* Property / action chips */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {type.properties.length} props
        </span>
        <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {type.actions.length} actions
        </span>
        {type.linksOut.length + type.linksIn.length > 0 && (
          <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {type.linksOut.length + type.linksIn.length} links
          </span>
        )}
      </div>

      {/* Preview properties */}
      <ul className="mt-3 space-y-1 border-t border-border pt-2.5">
        {previewProps.map((p) => (
          <li key={p.apiName} className="truncate font-mono text-[11px]">
            <span className={cn(p.isTitle ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
              {p.displayName}
            </span>
            <span className="ml-1.5 text-muted-foreground/70">{p.dataType}</span>
          </li>
        ))}
      </ul>

      {/* Links summary */}
      <p className="mt-2.5 font-mono text-[10px] text-muted-foreground/80">
        {type.linksOut.length + type.linksIn.length > 0 ? (
          <>
            <span className="text-muted-foreground">→ {type.linksOut.length} outgoing</span>
            {' · '}
            <span className="text-muted-foreground">{type.linksIn.length} incoming</span>
          </>
        ) : (
          'no links'
        )}
      </p>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────

export default function OntologyPage() {
  const queryClient = useQueryClient()
  const [deleting, setDeleting] = useState<OntologyObjectType | null>(null)
  const [deletingAction, setDeletingAction] = useState<OntologyActionFull | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingAction, setEditingAction] = useState<OntologyActionFull | null>(null)
  const [linkEditorOpen, setLinkEditorOpen] = useState(false)
  const [editingLink, setEditingLink] = useState<EditingLink | null>(null)
  const [deletingLink, setDeletingLink] = useState<EditingLink | null>(null)
  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'], queryFn: () => apiJson<SessionResponse>('/api/session'), staleTime: 30_000,
  })
  const canEdit = sessionQuery.data?.role === 'editor' || sessionQuery.data?.role === 'admin'

  const ontologyQuery = useQuery<OntologyListResponse>({
    queryKey: ['ontology'],
    queryFn: () => apiJson<OntologyListResponse>('/api/ontology'),
  })
  const types = useMemo(() => ontologyQuery.data?.objectTypes ?? [], [ontologyQuery.data])

  const ontologyActionsQuery = useQuery<{ actions: OntologyActionFull[] }>({
    queryKey: ['ontology-actions'],
    queryFn: () => apiJson<{ actions: OntologyActionFull[] }>('/api/ontology/actions'),
  })
  const actions = useMemo(() => ontologyActionsQuery.data?.actions ?? [], [ontologyActionsQuery.data])

  // actionApiName → dataset the action's version chip should link to
  // (write-back target when configured, else the object type's backing dataset).
  const datasetIdByAction = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const a of actions) {
      map.set(a.apiName, a.writeback?.targetDatasetId ?? a.objectType.sourceDatasetId ?? null)
    }
    return map
  }, [actions])

  const logsQuery = useQuery<ActionLogsResponse>({
    queryKey: ['action-logs'],
    queryFn: () => apiJson<ActionLogsResponse>('/api/actions/logs?limit=10'),
    refetchInterval: 15_000,
  })
  const logs = useMemo(() => logsQuery.data?.logs ?? [], [logsQuery.data])

  // All links across types (deduped — linksIn mirror other types' linksOut).
  const allLinks = useMemo(() => {
    const rows: { id: string; from: OntologyObjectType; link: OutgoingLinkSummary }[] = []
    const seen = new Set<string>()
    for (const t of types) {
      for (const l of t.linksOut) {
        if (seen.has(l.id)) continue
        seen.add(l.id)
        rows.push({ id: l.id, from: t, link: l })
      }
    }
    return rows
  }, [types])

  const seedMutation = useMutation({
    mutationFn: () => apiJson<SeedOntologyResponse>('/api/ontology/seed-demo', { method: 'POST' }),
    onSuccess: (res) => {
      if (res.seeded) {
        toast.success('Demo ontology seeded', {
          description: `Created ${res.created.length} object types: ${res.created.join(', ')}`,
        })
      } else {
        toast.info('Demo ontology already present', { description: 'Nothing new to seed.' })
      }
      void queryClient.invalidateQueries({ queryKey: ['ontology'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
    onError: (err: Error) => toast.error('Seeding failed', { description: err.message }),
  })

  const deleteMutation = useMutation({
    mutationFn: (t: OntologyObjectType) =>
      apiJson<void>(`/api/ontology/${t.id}`, { method: 'DELETE' }),
    onSuccess: (_res, t) => {
      toast.success('Object type deleted', {
        description: `${t.displayName} removed from the ontology (links + actions cascaded).`,
      })
      void queryClient.invalidateQueries({ queryKey: ['ontology'] })
      void queryClient.invalidateQueries({ queryKey: ['actions'] })
      void queryClient.invalidateQueries({ queryKey: ['ontology-actions'] })
      void queryClient.invalidateQueries({ queryKey: ['action-logs'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      setDeleting(null)
    },
    onError: (err: Error) =>
      toast.error('Could not delete object type', { description: err.message }),
  })

  const deleteActionMutation = useMutation({
    mutationFn: (a: OntologyActionFull) =>
      apiJson<void>(`/api/ontology/actions/${encodeURIComponent(a.id)}`, { method: 'DELETE' }),
    onSuccess: (_res, a) => {
      toast.success('Action deleted', {
        description: `${a.displayName} removed (its write-back logs cascaded).`,
      })
      void queryClient.invalidateQueries({ queryKey: ['ontology-actions'] })
      void queryClient.invalidateQueries({ queryKey: ['actions'] })
      void queryClient.invalidateQueries({ queryKey: ['ontology'] })
      void queryClient.invalidateQueries({ queryKey: ['action-logs'] })
      setDeletingAction(null)
    },
    onError: (err: Error) => {
      toast.error('Could not delete action', { description: err.message })
      setDeletingAction(null)
    },
  })

  const deleteLinkMutation = useMutation({
    mutationFn: (item: EditingLink) => apiJson<void>(`/api/ontology/links/${item.link.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Link deleted')
      void queryClient.invalidateQueries({ queryKey: ['ontology'] })
      void queryClient.invalidateQueries({ queryKey: ['object'] })
      setDeletingLink(null)
    },
    onError: (error: Error) => toast.error('Could not delete link', { description: error.message }),
  })

  const loading = ontologyQuery.isLoading

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* a) Header (compact Foundry pattern) */}
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Network className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className="text-sm font-medium tracking-tight text-foreground">Ontology</h1>
          <span className="text-xs text-muted-foreground">
            the semantic layer — objects, links, write-back actions
          </span>
          {types.length > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground/80">
              {types.length} types · {allLinks.length} links · {actions.length} actions
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={types.length >= 3 || seedMutation.isPending}
            onClick={() => seedMutation.mutate()}
            className="h-8 gap-1.5 text-xs"
            title={
              types.length >= 3 ? 'Demo ontology already seeded' : 'Create the supply-chain demo ontology'
            }
          >
            <Sparkles
              className={cn('h-3.5 w-3.5', seedMutation.isPending && 'animate-pulse')}
              aria-hidden
            />
            Seed demo ontology
          </Button>
          <NewObjectTypeDialog />
        </div>
      </header>

      {/* b) Object type cards */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56 w-full" />
          ))}
        </div>
      ) : ontologyQuery.isError ? (
        <Card className="border-border bg-card">
          <CardContent className="p-6 text-center text-sm text-rose-600 dark:text-rose-400">
            {ontologyQuery.error instanceof Error
              ? ontologyQuery.error.message
              : 'Failed to load the ontology.'}
          </CardContent>
        </Card>
      ) : types.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <Network className="h-8 w-8 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-base font-medium text-foreground">No object types yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Seed the supply-chain demo (shipment, supplier, warehouse with links + actions) or
                map your own dataset into an object type.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {types.map((t) => (
            <TypeCard key={t.id} type={t} onRequestDelete={setDeleting} />
          ))}
        </div>
      )}

      {/* c) Links across types */}
      <Card className="mt-4 border-border bg-card">
        <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border p-4">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-muted-foreground" aria-hidden />
            <CardTitle className="text-sm font-semibold text-foreground">Links</CardTitle>
            {!loading && (
              <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {allLinks.length}
              </span>
            )}
          </div>
          {canEdit && <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs"
            disabled={types.length < 1} onClick={() => { setEditingLink(null); setLinkEditorOpen(true) }}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> New link
          </Button>}
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-2 p-4">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : allLinks.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No links yet. Create one to connect objects through a foreign key or relationship dataset.
            </div>
          ) : (
            <div className="foundry-scroll max-h-96 overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="h-9 px-4 text-xs text-muted-foreground">From → To</TableHead>
                    <TableHead className="h-9 px-3 text-xs text-muted-foreground">Cardinality</TableHead>
                    <TableHead className="h-9 px-3 text-xs text-muted-foreground">Link</TableHead>
                    {canEdit && <TableHead className="h-9 w-12 px-2"><span className="sr-only">Actions</span></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allLinks.map(({ id, from, link }) => (
                    <TableRow key={id} className="border-border">
                      <TableCell className="px-4 py-2">
                        <span className="flex flex-wrap items-center gap-1.5 text-sm">
                          <span className="font-medium text-foreground">{from.displayName}</span>
                          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                          <span className="font-medium text-foreground">{link.toTypeDisplayName}</span>
                        </span>
                      </TableCell>
                      <TableCell className="px-3 py-2">
                        <Badge
                          variant="outline"
                          className={cn('font-mono text-[10px]', getCardinalityClasses(link.cardinality))}
                        >
                          {getCardinalityLabel(link.cardinality)}
                        </Badge>
                      </TableCell>
                      <TableCell className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        <span>{link.displayName}</span>
                        <span className="block text-[10px]">{link.cardinality !== 'many-to-many'
                          ? `via ${link.fkSide === 'from' || (link.fkSide == null && link.cardinality === 'many-to-one') ? from.displayName : link.toTypeDisplayName}.${link.fkProperty ?? 'foreign key'}`
                          : `via ${link.linkDatasetName ?? 'relationship dataset'}${link.fromKeyColumn && link.toKeyColumn ? ` (${link.fromKeyColumn} → ${link.toKeyColumn})` : ''}`}</span>
                      </TableCell>
                      {canEdit && <TableCell className="px-2 py-2">
                        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Manage ${link.displayName}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => { setEditingLink({ from, link }); setLinkEditorOpen(true) }}><Pencil className="mr-2 h-3.5 w-3.5" />Edit link</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={() => setDeletingLink({ from, link })}><Trash2 className="mr-2 h-3.5 w-3.5" />Delete link</DropdownMenuItem>
                          </DropdownMenuContent></DropdownMenu>
                      </TableCell>}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {linkEditorOpen && <LinkTypeEditor key={editingLink?.link.id ?? 'new'} open={linkEditorOpen} onOpenChange={setLinkEditorOpen} types={types} editing={editingLink} />}
      <AlertDialog open={!!deletingLink} onOpenChange={(open) => { if (!open) setDeletingLink(null) }}>
        <AlertDialogContent className="sm:max-w-sm"><AlertDialogHeader>
          <AlertDialogTitle>Delete link?</AlertDialogTitle>
          <AlertDialogDescription>Remove {deletingLink?.link.displayName} from both object types? The objects and datasets stay in place.</AlertDialogDescription>
        </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={deleteLinkMutation.isPending} onClick={() => deletingLink && deleteLinkMutation.mutate(deletingLink)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete link</AlertDialogAction>
        </AlertDialogFooter></AlertDialogContent>
      </AlertDialog>

      {/* d) Actions — with R14.6 write-back config + editor */}
      <Card className="mt-4 border-border bg-card">
        <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border p-4">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-muted-foreground" aria-hidden />
            <CardTitle className="text-sm font-semibold text-foreground">Actions</CardTitle>
            {!ontologyActionsQuery.isLoading && (
              <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {actions.length}
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            disabled={types.length === 0}
            onClick={() => {
              setEditingAction(null)
              setEditorOpen(true)
            }}
            title={types.length === 0 ? 'Create an object type first' : 'Define a new action type'}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New action
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {ontologyActionsQuery.isLoading ? (
            <div className="space-y-2 p-4">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : ontologyActionsQuery.isError ? (
            <p className="p-6 text-center text-sm text-rose-600 dark:text-rose-400">
              {ontologyActionsQuery.error instanceof Error
                ? ontologyActionsQuery.error.message
                : 'Failed to load actions.'}
            </p>
          ) : actions.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No actions yet — actions are the write-back layer (create / update / delete objects
              as new dataset versions, or write into a target dataset).
            </div>
          ) : (
            <div className="foundry-scroll max-h-96 overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="h-9 px-4 text-xs text-muted-foreground">Action</TableHead>
                    <TableHead className="h-9 px-3 text-xs text-muted-foreground">Operation</TableHead>
                    <TableHead className="h-9 px-3 text-xs text-muted-foreground">Target</TableHead>
                    <TableHead className="h-9 px-3 text-xs text-muted-foreground">Write-back</TableHead>
                    <TableHead className="h-9 px-3 text-xs text-muted-foreground">Enabled</TableHead>
                    <TableHead className="h-9 px-3 text-right text-xs text-muted-foreground">
                      <span className="sr-only">Options</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {actions.map((a: OntologyActionFull) => {
                    const op = getOperationClasses(a.operation)
                    return (
                      <TableRow key={a.id} className="border-border">
                        <TableCell className="max-w-[240px] px-4 py-2">
                          <p className="truncate text-sm font-medium text-foreground">
                            {a.displayName}
                          </p>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">
                            {a.apiName} · {a.parameters.length} param{a.parameters.length === 1 ? '' : 's'}
                          </p>
                        </TableCell>
                        <TableCell className="px-3 py-2">
                          <Badge variant="outline" className={cn('text-[10px]', op.badge)}>
                            {a.operation}
                          </Badge>
                        </TableCell>
                        <TableCell className="px-3 py-2">
                          <Link
                            href={`/objects?type=${encodeURIComponent(a.objectType.apiName)}`}
                            className="text-sm text-foreground hover:underline underline-offset-2"
                          >
                            {a.objectType.displayName}
                          </Link>
                        </TableCell>
                        <TableCell className="px-3 py-2">
                          {a.writeback ? (
                            <span
                              className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground"
                              title={`Writes into ${a.writeback.targetDatasetName ?? 'dataset'} (${a.writeback.writeMode}${a.writeback.keyProperty ? `, key ${a.writeback.keyProperty}` : ''})`}
                            >
                              <Database className="h-3 w-3 text-muted-foreground" aria-hidden />
                              {a.writeback.targetDatasetName ?? 'dataset'}
                              <span className="text-muted-foreground">· {a.writeback.writeMode}</span>
                            </span>
                          ) : (
                            <span className="font-mono text-[10px] text-muted-foreground/70">—</span>
                          )}
                        </TableCell>
                        <TableCell className="px-3 py-2">
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[10px]',
                              a.enabled
                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                : 'border-border bg-muted text-muted-foreground',
                            )}
                          >
                            {a.enabled ? 'enabled' : 'disabled'}
                          </Badge>
                        </TableCell>
                        <TableCell className="px-3 py-2 text-right">
                          <span className="inline-flex items-center gap-1">
                            <Link
                              href={`/objects?type=${encodeURIComponent(a.objectType.apiName)}&action=${encodeURIComponent(a.apiName)}`}
                              className="inline-flex items-center gap-1 text-xs text-foreground hover:underline underline-offset-2"
                            >
                              View <ArrowRight className="h-3 w-3" aria-hidden />
                            </Link>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
                                  aria-label={`Options for action ${a.displayName}`}
                                >
                                  <MoreHorizontal className="h-4 w-4" aria-hidden />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onSelect={() => {
                                    setEditingAction(a)
                                    setEditorOpen(true)
                                  }}
                                  className="text-xs text-foreground"
                                >
                                  <Pencil className="mr-2 h-3.5 w-3.5" aria-hidden />
                                  Edit action…
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onSelect={() => setDeletingAction(a)}
                                  className="text-xs text-rose-600 dark:text-rose-400 hover:!bg-rose-500/10 hover:!text-rose-600"
                                >
                                  <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden />
                                  Delete action…
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </span>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* d) Action log — recent write-backs */}
      <Card className="mt-4 border-border bg-card">
        <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border p-4">
          <div className="flex items-center gap-2">
            <Circle className="h-4 w-4 text-muted-foreground" aria-hidden />
            <CardTitle className="text-sm font-semibold text-foreground">
              Recent write-backs
            </CardTitle>
          </div>
          <span className="font-mono text-[10px] text-muted-foreground/80">last 10 · refresh 15s</span>
        </CardHeader>
        <CardContent className="p-0">
          {logsQuery.isLoading ? (
            <div className="space-y-2 p-4">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : logs.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No write-backs yet — run an action from an object type to see it here.
            </div>
          ) : (
            <div className="foundry-scroll max-h-96 overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="h-9 px-4 text-xs text-muted-foreground">Result</TableHead>
                    <TableHead className="h-9 px-3 text-xs text-muted-foreground">Action</TableHead>
                    <TableHead className="h-9 px-3 text-xs text-muted-foreground">Object</TableHead>
                    <TableHead className="h-9 px-3 text-xs text-muted-foreground">Message</TableHead>
                    <TableHead className="h-9 px-3 text-xs text-muted-foreground">Version</TableHead>
                    <TableHead className="h-9 px-4 text-right text-xs text-muted-foreground">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow key={log.id} className="border-border">
                      <TableCell className="px-4 py-2">
                        <span
                          className={cn(
                            'inline-block h-2 w-2 rounded-full',
                            log.result === 'success' ? 'bg-emerald-500' : 'bg-rose-500',
                          )}
                          aria-label={log.result}
                        />
                      </TableCell>
                      <TableCell className="px-3 py-2">
                        <p className="truncate text-sm text-foreground">{log.actionDisplayName}</p>
                        <p className="truncate font-mono text-[10px] text-muted-foreground/80">
                          {log.objectTypeDisplayName}
                        </p>
                      </TableCell>
                      <TableCell className="max-w-[140px] truncate px-3 py-2 font-mono text-xs text-muted-foreground">
                        {log.objectPk ?? '—'}
                      </TableCell>
                      <TableCell
                        className="max-w-[280px] truncate px-3 py-2 text-xs text-muted-foreground"
                        title={log.message}
                      >
                        {log.message}
                      </TableCell>
                      <TableCell className="px-3 py-2">
                        {log.versionNumber != null ? (
                          datasetIdByAction.get(log.actionApiName) ? (
                            <Link
                              href={`/datasets/${datasetIdByAction.get(log.actionApiName)}`}
                              className="inline-block rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground transition-colors hover:bg-accent"
                              title={`Open dataset v${log.versionNumber}`}
                            >
                              v{log.versionNumber}
                            </Link>
                          ) : (
                            <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                              v{log.versionNumber}
                            </span>
                          )
                        ) : (
                          <span className="font-mono text-[10px] text-muted-foreground/70">—</span>
                        )}
                      </TableCell>
                      <TableCell
                        className="px-4 py-2 text-right font-mono text-xs text-muted-foreground"
                        title={log.createdAt}
                      >
                        {formatRelative(log.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action-type editor (create/edit, incl. R14.6 write-back section) */}
      <ActionTypeEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        action={editingAction}
        objectTypes={types.map((t) => ({
          id: t.id,
          apiName: t.apiName,
          displayName: t.displayName,
          primaryKey: t.primaryKey,
          sourceDatasetId: t.sourceDatasetId,
        }))}
      />

      {/* Delete-action confirmation */}
      <AlertDialog
        open={deletingAction !== null}
        onOpenChange={(next) => {
          if (!next) setDeletingAction(null)
        }}
      >
        <AlertDialogContent className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">Delete action?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              <span className="font-medium text-foreground">{deletingAction?.displayName}</span> (
              <span className="font-mono">{deletingAction?.apiName}</span>) will be removed together
              with its write-back logs. Datasets and versions are untouched. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingAction && deleteActionMutation.mutate(deletingAction)}
              disabled={deleteActionMutation.isPending}
              className="bg-rose-600 text-white hover:bg-rose-600/90 dark:bg-rose-500 dark:hover:bg-rose-500/90"
            >
              {deleteActionMutation.isPending ? 'Deleting…' : 'Delete action'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete-type confirmation (shared, opened from card menus) */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
      >
        <AlertDialogContent className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">Delete object type?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              <span className="font-medium text-foreground">{deleting?.displayName}</span> (
              <span className="font-mono">{deleting?.apiName}</span>) will be removed together with
              its links and actions. The backing dataset is untouched. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deleteMutation.mutate(deleting)}
              disabled={deleteMutation.isPending}
              className="bg-rose-600 text-white hover:bg-rose-600/90 dark:bg-rose-500 dark:hover:bg-rose-500/90"
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete type'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
