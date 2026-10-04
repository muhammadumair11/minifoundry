'use client'

// Governance console — section (b): markings list + admin CRUD (Task 4-c).
// Admin: New marking dialog, per-marking "Attach columns" dialog (attach full
// checked list + detach computed removals), Delete with confirm. Non-admin:
// read-only with gated buttons. 403s surface the server message via toast.

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Tag, Unplug, X } from 'lucide-react'
import { toast } from 'sonner'
import { formatDistanceToNowStrict } from 'date-fns'
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
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import type {
  DatasetDetailResponse,
  DatasetsListResponse,
  FoundryRole,
  Marking,
  MarkingColor,
  MarkingResponse,
  MarkingsListResponse,
  SessionResponse,
} from '@/lib/foundry-types'
import { RoleBadge } from '@/components/foundry/governance/role-badge'
import {
  getMarkingColorClasses,
  MarkingChip,
  MarkingColorDot,
  MARKING_COLOR_CHOICES,
} from '@/components/foundry/governance/marking-colors'
import { GatedButton } from '@/components/foundry/governance/gated-button'

const ADMIN_REASON = 'requires admin role'

// ─── New marking dialog ───────────────────────────────────────────────

function NewMarkingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<MarkingColor>('rose')
  const [minRole, setMinRole] = useState<FoundryRole>('editor')

  const createMutation = useMutation({
    mutationFn: (body: { name: string; description?: string; color: MarkingColor; minRole: FoundryRole }) =>
      apiSend<MarkingResponse>('/api/markings', 'POST', body),
    onSuccess: (res) => {
      toast.success(`Marking “${res.marking.name}” created`)
      queryClient.invalidateQueries({ queryKey: ['markings'] })
      setName('')
      setDescription('')
      setColor('rose')
      setMinRole('editor')
      onClose()
    },
    onError: (err) => toastApiError(err, 'Could not create marking'),
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm text-foreground">New marking</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Columns attached to this marking render{' '}
            <span className="font-mono italic text-foreground">------</span> for roles below
            minRole.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="marking-name" className="text-xs text-muted-foreground">
              Name
            </Label>
            <Input
              id="marking-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. PII"
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="marking-description" className="text-xs text-muted-foreground">
              Description <span className="text-muted-foreground/80">(optional)</span>
            </Label>
            <Input
              id="marking-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Why does this data need gating?"
              className="h-8 text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Color</Label>
              <Select value={color} onValueChange={(v) => setColor(v as MarkingColor)}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MARKING_COLOR_CHOICES.map((c) => (
                    <SelectItem key={c} value={c} className="text-xs capitalize">
                      <span className="flex items-center gap-2">
                        <MarkingColorDot color={c} />
                        {c}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Minimum role</Label>
              <Select value={minRole} onValueChange={(v) => setMinRole(v as FoundryRole)}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['viewer', 'editor', 'admin'] as FoundryRole[]).map((r) => (
                    <SelectItem key={r} value={r} className="text-xs capitalize">
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            data-dialog-submit
            size="sm"
            disabled={!name.trim() || createMutation.isPending}
            onClick={() =>
              createMutation.mutate({
                name: name.trim(),
                description: description.trim() || undefined,
                color,
                minRole,
              })
            }
          >
            Create marking
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Attach columns dialog ────────────────────────────────────────────

function AttachColumnsDialog({ marking, onClose }: { marking: Marking | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [datasetId, setDatasetId] = useState<string>('')
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const datasetsQuery = useQuery<DatasetsListResponse>({
    queryKey: ['datasets'],
    queryFn: () => apiJson<DatasetsListResponse>('/api/datasets'),
    enabled: marking !== null,
  })

  const schemaQuery = useQuery<DatasetDetailResponse>({
    queryKey: ['dataset', datasetId],
    queryFn: () => apiJson<DatasetDetailResponse>(`/api/datasets/${datasetId}`),
    enabled: marking !== null && datasetId !== '',
  })

  // Columns of this marking on the selected dataset (the baseline for diffing).
  const originallyAttached = useMemo(() => {
    if (!marking || !datasetId) return new Set<string>()
    return new Set(
      marking.columns.filter((c) => c.datasetId === datasetId).map((c) => c.columnName),
    )
  }, [marking, datasetId])

  const selectDataset = (id: string) => {
    setDatasetId(id)
    const base = new Set(
      (marking?.columns ?? []).filter((c) => c.datasetId === id).map((c) => c.columnName),
    )
    setChecked(base)
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!marking || !datasetId) return
      const checkedList = [...checked]
      const removed = [...originallyAttached].filter((c) => !checked.has(c))
      if (checkedList.length > 0) {
        await apiSend(`/api/markings/${marking.id}/attach`, 'POST', {
          datasetId,
          columns: checkedList,
        })
      }
      if (removed.length > 0) {
        await apiSend(`/api/markings/${marking.id}/detach`, 'POST', {
          datasetId,
          columns: removed,
        })
      }
      return { attached: checkedList.length, removed: removed.length }
    },
    onSuccess: (res) => {
      toast.success('Marking columns updated', {
        description: res
          ? `${res.attached} attached · ${res.removed} detached`
          : undefined,
      })
      queryClient.invalidateQueries({ queryKey: ['markings'] })
      queryClient.invalidateQueries({ queryKey: ['dataset', datasetId] })
      onClose()
    },
    onError: (err) => toastApiError(err, 'Could not update marking columns'),
  })

  const columns = schemaQuery.data?.current.schema ?? []

  return (
    <Dialog
      open={marking !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm text-foreground">
            <MarkingColorDot color={marking?.color} />
            Attach columns — <span className="font-mono">{marking?.name}</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Pick a dataset, then toggle its columns. Saving attaches the full checked list and
            detaches the removed ones.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Dataset</Label>
          <Select value={datasetId} onValueChange={selectDataset}>
            <SelectTrigger className="h-8 w-full text-xs">
              <SelectValue placeholder="Choose a dataset…" />
            </SelectTrigger>
            <SelectContent>
              {(datasetsQuery.data?.datasets ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id} className="text-xs">
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="max-h-64 overflow-y-auto foundry-scroll rounded-md border border-border bg-muted/40">
          {datasetId === '' ? (
            <p className="p-4 text-center text-xs text-muted-foreground/80">
              Select a dataset to list its columns.
            </p>
          ) : schemaQuery.isLoading ? (
            <div className="space-y-2 p-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          ) : schemaQuery.isError ? (
            <p className="p-4 text-center text-xs text-rose-600 dark:text-rose-400">
              Could not load the dataset schema.
            </p>
          ) : columns.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground/80">This dataset has no columns.</p>
          ) : (
            <ul className="divide-y divide-border">
              {columns.map((col) => {
                const isChecked = checked.has(col.name)
                const otherMarking =
                  col.markedWith && col.markedWith !== marking?.name ? col.markedWith : null
                return (
                  <li key={col.name}>
                    <label
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-accent',
                        isChecked && 'bg-accent/40',
                      )}
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={(v) => {
                          setChecked((prev) => {
                            const next = new Set(prev)
                            if (v === true) next.add(col.name)
                            else next.delete(col.name)
                            return next
                          })
                        }}
                        aria-label={`Mark column ${col.name}`}
                      />
                      <span className="flex-1 truncate font-mono text-xs text-foreground">
                        {col.name}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground/80">{col.type}</span>
                      {otherMarking && (
                        <span
                          className="font-mono text-[10px] text-muted-foreground"
                          title={`Also marked by ${otherMarking}`}
                        >
                          +{otherMarking}
                        </span>
                      )}
                      {originallyAttached.has(col.name) && !isChecked && (
                        <span className="font-mono text-[9px] text-rose-600/80 dark:text-rose-400/80">detach</span>
                      )}
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={datasetId === '' || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── The card ─────────────────────────────────────────────────────────

export function MarkingsCard() {
  const queryClient = useQueryClient()
  const [newOpen, setNewOpen] = useState(false)
  const [attaching, setAttaching] = useState<Marking | null>(null)
  const [deleting, setDeleting] = useState<Marking | null>(null)

  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const isAdmin = sessionQuery.data?.role === 'admin'

  const markingsQuery = useQuery<MarkingsListResponse>({
    queryKey: ['markings'],
    queryFn: () => apiJson<MarkingsListResponse>('/api/markings'),
  })
  const markings = markingsQuery.data?.markings ?? []

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiSend(`/api/markings/${id}`, 'DELETE'),
    onSuccess: () => {
      toast.success(`Marking “${deleting?.name ?? ''}” deleted`)
      queryClient.invalidateQueries({ queryKey: ['markings'] })
      setDeleting(null)
    },
    onError: (err) => toastApiError(err, 'Could not delete marking'),
  })

  return (
    <Card>
      <CardHeader className="gap-1.5 border-b border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Tag className="h-4 w-4 text-muted-foreground" aria-hidden />
            Markings
            {!markingsQuery.isLoading && (
              <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
                {markings.length}
              </span>
            )}
          </CardTitle>
          <GatedButton
            allowed={isAdmin}
            reason={ADMIN_REASON}
            size="sm"
            onClick={() => setNewOpen(true)}
            className="h-7 gap-1.5 text-xs"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New marking
          </GatedButton>
        </div>
        <CardDescription className="text-xs text-muted-foreground">
          Column-level ABAC gates. Cells of attached columns are masked for roles below the
          marking&rsquo;s minRole.
          {!isAdmin && (
            <span className="ml-1 text-muted-foreground/80">
              Read-only — modifications {ADMIN_REASON}.
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4">
        {markingsQuery.isLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : markingsQuery.isError ? (
          <p className="py-4 text-center text-xs text-rose-600 dark:text-rose-400">
            {markingsQuery.error instanceof Error
              ? markingsQuery.error.message
              : 'Failed to load markings.'}
          </p>
        ) : markings.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-8 text-center">
            <Tag className="h-6 w-6 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium text-foreground">No markings yet</p>
            <p className="max-w-sm text-xs text-muted-foreground/80">
              {isAdmin
                ? 'Create a marking and attach dataset columns to gate their values by role.'
                : 'No column is governed yet — an admin can create markings here.'}
            </p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {markings.map((m) => {
              const color = getMarkingColorClasses(m.color)
              return (
                <li
                  key={m.id}
                  className={cn('rounded-md border bg-muted/40 p-3', color.border)}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <MarkingColorDot color={m.color} />
                        <span className="text-sm font-semibold text-foreground">{m.name}</span>
                        <span
                          className={cn(
                            'rounded border px-1.5 font-mono text-[10px] leading-4',
                            color.border,
                            color.bg,
                            color.text,
                          )}
                        >
                          minRole: {m.minRole}
                        </span>
                      </div>
                      {m.description && (
                        <p className="mt-1 max-w-xl text-xs text-muted-foreground">{m.description}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <GatedButton
                        allowed={isAdmin}
                        reason={ADMIN_REASON}
                        size="sm"
                        variant="outline"
                        onClick={() => setAttaching(m)}
                        className="h-7 gap-1.5 px-2 text-xs"
                      >
                        <Unplug className="h-3 w-3" aria-hidden />
                        Attach columns
                      </GatedButton>
                      <GatedButton
                        allowed={isAdmin}
                        reason={ADMIN_REASON}
                        size="sm"
                        variant="outline"
                        onClick={() => setDeleting(m)}
                        className="h-7 w-7 p-0 text-muted-foreground hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400"
                        aria-label={`Delete marking ${m.name}`}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </GatedButton>
                    </div>
                  </div>

                  {/* Attached columns as mono chips */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    {m.columns.length === 0 ? (
                      <span className="font-mono text-[11px] text-muted-foreground/80">
                        no columns attached
                      </span>
                    ) : (
                      m.columns.map((c) => (
                        <MarkingChip
                          key={`${c.datasetId}.${c.columnName}`}
                          name={`${c.datasetName}.${c.columnName}`}
                          color={m.color}
                        />
                      ))
                    )}
                  </div>
                  <p className="mt-1.5 font-mono text-[10px] text-muted-foreground/80">
                    created {formatDistanceToNowStrict(new Date(m.createdAt), { addSuffix: true })}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>

      <NewMarkingDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <AttachColumnsDialog marking={attaching} onClose={() => setAttaching(null)} />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
      >
        <AlertDialogContent className="bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm text-foreground">
              Delete marking “{deleting?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground">
              This un-gates {deleting?.columns.length ?? 0} attached column
              {deleting?.columns.length === 1 ? '' : 's'} — masked values become readable again
              for every role. This action is audited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs text-muted-foreground hover:text-foreground">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              disabled={deleteMutation.isPending}
              className="bg-rose-600 text-white hover:bg-rose-500 dark:bg-rose-500 dark:text-zinc-950 dark:hover:bg-rose-400"
            >
              Delete marking
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
