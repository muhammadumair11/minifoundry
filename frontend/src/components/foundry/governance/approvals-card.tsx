'use client'

// Governance console — section (c): approvals queue + decisions (Task 4-c).
// Pending queue first (amber left border), decision history below, plus a
// "Request approval" dialog for editors. Decisions are admin-only; 403s
// surface the server message via toast.

import { useMemo, useState } from 'react'
import Link from '@/components/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, Check, CircleSlash, ClipboardCheck, Plus, ShieldAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { formatDistanceToNowStrict } from 'date-fns'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import type {
  ApprovalKind,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalsListResponse,
  DatasetsListResponse,
  PipelinesListResponse,
  PublishGatePreview,
  SessionResponse,
} from '@/lib/foundry-types'
import { RoleBadge } from '@/components/foundry/governance/role-badge'
import { GatedButton } from '@/components/foundry/governance/gated-button'

const EDITOR_REASON = 'requires editor role'
const ADMIN_REASON = 'requires admin role'

function kindTargetHref(kind: ApprovalKind, targetId: string): string {
  return kind === 'publish_dataset' ? `/datasets/${targetId}` : `/pipelines/${targetId}`
}

// ─── Publication-gate preview line (P2 carryover) ─────────────────

/** Live "what happens if this is approved" line for pending publish_dataset
 *  requests — blocked shows the failing rule names; ready shows a green go. */
function GatePreviewLine({ preview }: { preview: PublishGatePreview | null | undefined }) {
  if (!preview) return null
  if (preview.status === 'blocked') {
    return (
      <div
        className="mt-1.5 rounded-md border border-rose-500/30 bg-rose-500/5 px-2 py-1.5"
        data-testid="gate-preview-blocked"
      >
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-rose-600 dark:text-rose-400">
          <ShieldAlert className="h-3 w-3 shrink-0" aria-hidden />
          <span className="font-medium">
            Quality gate will BLOCK publishing v{preview.draftVersion} —
          </span>
          <span>
            {preview.qualityState === 'not_evaluated' || !preview.qualityState
              ? 'quality has not been evaluated; add an enabled rule and evaluate the draft'
              : `${preview.failing.length} error rule${preview.failing.length === 1 ? '' : 's'} failing`}
          </span>
        </p>
        <ul className="mt-1 space-y-0.5 pl-4">
          {preview.failing.map((f) => (
            <li key={f.name} className="text-[11px] leading-4 text-rose-600/90 dark:text-rose-400/90">
              <span className="font-mono font-medium text-foreground/80">{f.name}</span>
              {f.message ? ` — ${f.message}` : ''}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Approval cannot complete until the draft passes quality. The request stays pending.
        </p>
      </div>
    )
  }
  if (preview.status === 'ready') {
    return (
      <p
        className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5 text-[11px] text-emerald-600 dark:text-emerald-400"
        data-testid="gate-preview-ready"
      >
        <Check className="h-3 w-3 shrink-0" aria-hidden />
        <span>
          Draft v{preview.draftVersion} passed quality — approving publishes it immediately.
        </span>
      </p>
    )
  }
  if (preview.status === 'no_draft') {
    return (
      <p
        className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground"
        data-testid="gate-preview-nodraft"
      >
        <CircleSlash className="h-3 w-3 shrink-0" aria-hidden />
        <span>
          No draft version is available. Create a draft before requesting publication.
        </span>
      </p>
    )
  }
  // ungated
  return (
    <p
      className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground"
      data-testid="gate-preview-ungated"
    >
      <Ban className="h-3 w-3 shrink-0" aria-hidden />
      <span>Quality gate is off — new versions publish without review.</span>
    </p>
  )
}

// ─── Decision dialog (approve / reject with optional note) ────────────

function DecideDialog({
  approval,
  onClose,
}: {
  approval: { request: ApprovalRequest; decision: 'approved' | 'rejected' } | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')

  const decideMutation = useMutation({
    mutationFn: (body: { id: string; decision: 'approved' | 'rejected'; note?: string }) =>
      apiSend<ApprovalResponse>(`/api/approvals/${body.id}/decide`, 'POST', {
        decision: body.decision,
        note: body.note || undefined,
      }),
    onSuccess: (res) => {
      toast.success(
        res.approval.status === 'approved'
          ? `Approved — ${res.approval.targetName} is now production`
          : `Rejected — ${res.approval.targetName} stays unpublished`,
      )
      queryClient.invalidateQueries({ queryKey: ['approvals'] })
      queryClient.invalidateQueries({ queryKey: ['datasets'] })
      onClose()
    },
    onError: (err) => toastApiError(err, 'Could not record decision'),
  })

  const approving = approval?.decision === 'approved'

  return (
    <Dialog
      open={approval !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="bg-card sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm text-foreground">
            {approving ? (
              <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ) : (
              <X className="h-4 w-4 text-rose-600 dark:text-rose-400" aria-hidden />
            )}
            {approving ? 'Approve' : 'Reject'} {approval?.request.kind}?
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {approving ? 'Approving a dataset request tags it ' : 'The requester is notified via the audit trail.'}
            {approving && (
              <span className="font-mono text-foreground">production</span>
            )}
            {approving ? ' and publishes it.' : ''}
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-md border border-border bg-muted/50 p-2.5 text-xs text-muted-foreground">
          <span className="font-mono text-foreground">{approval?.request.targetName}</span>
          {approval?.request.note ? ` — “${approval.request.note}”` : ''}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="decision-note" className="text-xs text-muted-foreground">
            Decision note <span className="text-muted-foreground/80">(optional)</span>
          </Label>
          <Textarea
            id="decision-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Context for the audit trail…"
            rows={2}
            className="text-xs"
          />
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
            disabled={decideMutation.isPending}
            onClick={() =>
              approval &&
              decideMutation.mutate({ id: approval.request.id, decision: approval.decision, note })
            }
            className={cn(
              approving
                ? ''
                : 'bg-rose-600 text-white hover:bg-rose-500 dark:bg-rose-500 dark:text-zinc-950 dark:hover:bg-rose-400',
            )}
          >
            {approving ? 'Confirm approve' : 'Confirm reject'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Request approval dialog (editor+) ────────────────────────────────

function RequestApprovalDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<ApprovalKind>('publish_dataset')
  const [targetId, setTargetId] = useState('')
  const [note, setNote] = useState('')

  const datasetsQuery = useQuery<DatasetsListResponse>({
    queryKey: ['datasets'],
    queryFn: () => apiJson<DatasetsListResponse>('/api/datasets'),
    enabled: open && kind === 'publish_dataset',
  })
  const pipelinesQuery = useQuery<PipelinesListResponse>({
    queryKey: ['pipelines'],
    queryFn: () => apiJson<PipelinesListResponse>('/api/pipelines'),
    enabled: open && kind === 'publish_pipeline',
  })

  const targets = useMemo(() => {
    if (kind === 'publish_dataset') return (datasetsQuery.data?.datasets ?? []).filter((dataset) => dataset.latestDraftVersion != null)
    return pipelinesQuery.data?.pipelines ?? []
  }, [kind, datasetsQuery.data, pipelinesQuery.data])

  const requestMutation = useMutation({
    mutationFn: (body: { kind: ApprovalKind; targetId: string; note?: string }) =>
      apiSend<ApprovalResponse>('/api/approvals', 'POST', body),
    onSuccess: (res) => {
      toast.success('Approval requested', {
        description: `${res.approval.kind}: ${res.approval.targetName}`,
      })
      queryClient.invalidateQueries({ queryKey: ['approvals'] })
      setTargetId('')
      setNote('')
      onClose()
    },
    onError: (err) => toastApiError(err, 'Could not request approval'),
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
          <DialogTitle className="text-sm text-foreground">Request approval</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Editors can queue publish requests; an admin decides. Duplicate pending requests for
            the same target are rejected by the API.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Kind</Label>
            <Select
              value={kind}
              onValueChange={(v) => {
                setKind(v as ApprovalKind)
                setTargetId('')
              }}
            >
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="publish_dataset" className="font-mono text-xs">
                  publish_dataset
                </SelectItem>
                <SelectItem value="publish_pipeline" className="font-mono text-xs">
                  publish_pipeline
                </SelectItem>
              </SelectContent>
            </Select>
            {kind === 'publish_dataset' && !datasetsQuery.isLoading && targets.length === 0 && <p className="text-xs text-muted-foreground">No draft datasets are available. Enable a dataset's publication gate and create a new version first.</p>}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Target {kind === 'publish_dataset' ? 'dataset' : 'pipeline'}
            </Label>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue
                  placeholder={kind === 'publish_dataset' ? 'Choose a dataset…' : 'Choose a pipeline…'}
                />
              </SelectTrigger>
              <SelectContent>
                {targets.map((t) => (
                  <SelectItem key={t.id} value={t.id} className="text-xs">
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="request-note" className="text-xs text-muted-foreground">
              Note <span className="text-muted-foreground/80">(optional)</span>
            </Label>
            <Textarea
              id="request-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why should this be published?"
              rows={2}
              className="text-xs"
            />
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
            size="sm"
            disabled={targetId === '' || requestMutation.isPending}
            onClick={() => requestMutation.mutate({ kind, targetId, note: note || undefined })}
          >
            Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── The card ─────────────────────────────────────────────────────────

export function ApprovalsCard() {
  const [requestOpen, setRequestOpen] = useState(false)
  const [decideTarget, setDecideTarget] = useState<{
    request: ApprovalRequest
    decision: 'approved' | 'rejected'
  } | null>(null)

  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const role = sessionQuery.data?.role ?? null
  const isAdmin = role === 'admin'
  const canRequest = role === 'editor' || role === 'admin'

  const approvalsQuery = useQuery<ApprovalsListResponse>({
    queryKey: ['approvals', 'all'],
    queryFn: () => apiJson<ApprovalsListResponse>('/api/approvals'),
  })

  const { pending, decided } = useMemo(() => {
    const all = approvalsQuery.data?.approvals ?? []
    return {
      pending: all.filter((a) => a.status === 'pending'),
      decided: all.filter((a) => a.status !== 'pending'),
    }
  }, [approvalsQuery.data])

  return (
    <Card>
      <CardHeader className="gap-1.5 border-b border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ClipboardCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
            Approvals
            {pending.length > 0 && (
              <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-600 dark:text-amber-400">
                {pending.length} pending
              </span>
            )}
          </CardTitle>
          <GatedButton
            allowed={canRequest}
            reason={EDITOR_REASON}
            size="sm"
            onClick={() => setRequestOpen(true)}
            className="h-7 gap-1.5 text-xs"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Request approval
          </GatedButton>
        </div>
        <CardDescription className="text-xs text-muted-foreground">
          Publish requests flow editor → admin. Approving a dataset adds the{' '}
          <span className="font-mono text-foreground">production</span> tag.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4">
        {approvalsQuery.isLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : approvalsQuery.isError ? (
          <p className="py-4 text-center text-xs text-rose-600 dark:text-rose-400">
            {approvalsQuery.error instanceof Error
              ? approvalsQuery.error.message
              : 'Failed to load approvals.'}
          </p>
        ) : (
          <div className="space-y-4">
            {/* Pending queue */}
            <section aria-label="Pending approvals">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                Pending queue
              </p>
              {pending.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground/80">
                  Nothing awaiting review.
                </p>
              ) : (
                <ul className="space-y-2">
                  {pending.map((a) => (
                    <li
                      key={a.id}
                      className="rounded-md border border-l-2 border-border border-l-amber-400 bg-muted/40 p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded border border-border bg-muted px-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                              {a.kind}
                            </span>
                            <Link
                              href={kindTargetHref(a.kind, a.targetId)}
                              className="truncate text-sm font-medium text-foreground underline-offset-2 hover:underline"
                            >
                              {a.targetName}
                            </Link>
                          </div>
                          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                            <span>
                              by <RoleBadge role={a.requestedBy} className="align-middle" />
                            </span>
                            <span aria-hidden>·</span>
                            <span className="font-mono">
                              {formatDistanceToNowStrict(new Date(a.createdAt), { addSuffix: true })}
                            </span>
                          </p>
                          {a.note && (
                            <p className="mt-1 max-w-xl text-xs italic text-muted-foreground">“{a.note}”</p>
                          )}
                          {a.kind === 'publish_dataset' && (
                            <GatePreviewLine preview={a.publishPreview} />
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <GatedButton
                            allowed={isAdmin}
                            reason={ADMIN_REASON}
                            size="sm"
                            onClick={() => setDecideTarget({ request: a, decision: 'approved' })}
                            className="h-7 gap-1 px-2.5 text-xs"
                          >
                            <Check className="h-3.5 w-3.5" aria-hidden />
                            Approve
                          </GatedButton>
                          <GatedButton
                            allowed={isAdmin}
                            reason={ADMIN_REASON}
                            size="sm"
                            variant="outline"
                            onClick={() => setDecideTarget({ request: a, decision: 'rejected' })}
                            className="h-7 gap-1 border-rose-500/40 bg-transparent px-2.5 text-xs text-rose-600 hover:bg-rose-500/10 hover:text-rose-500 dark:text-rose-400 dark:hover:text-rose-300"
                          >
                            <X className="h-3.5 w-3.5" aria-hidden />
                            Reject
                          </GatedButton>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Decision history */}
            <section aria-label="Decision history">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                Decision history
              </p>
              {decided.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground/80">
                  No decisions recorded yet.
                </p>
              ) : (
                <ul className="max-h-96 space-y-1.5 overflow-y-auto foundry-scroll pr-1">
                  {decided.map((a) => (
                    <li
                      key={a.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/40 px-3 py-2"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            'rounded border px-1.5 font-mono text-[10px] leading-4',
                            a.status === 'approved'
                              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
                          )}
                        >
                          {a.status}
                        </span>
                        <Link
                          href={kindTargetHref(a.kind, a.targetId)}
                          className="truncate text-xs font-medium text-foreground underline-offset-2 hover:underline"
                        >
                          {a.targetName}
                        </Link>
                        <span className="font-mono text-[10px] text-muted-foreground/80">{a.kind}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                        {a.decisionNote && (
                          <span className="max-w-[220px] truncate italic" title={a.decisionNote}>
                            “{a.decisionNote}”
                          </span>
                        )}
                        <span>
                          by <RoleBadge role={a.decidedBy} className="align-middle" />
                        </span>
                        <span className="font-mono">
                          {a.decidedAt
                            ? formatDistanceToNowStrict(new Date(a.decidedAt), { addSuffix: true })
                            : '—'}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </CardContent>

      <RequestApprovalDialog open={requestOpen} onClose={() => setRequestOpen(false)} />
      <DecideDialog approval={decideTarget} onClose={() => setDecideTarget(null)} />
    </Card>
  )
}
