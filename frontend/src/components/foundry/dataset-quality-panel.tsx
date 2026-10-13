'use client'

// R14 data quality panel: rules table + "Add rule" dialog + "Evaluate now".
// Shown in the dataset detail page's Quality tab (editor actions are gated).

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Play, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { GatedButton } from '@/components/foundry/governance/gated-button'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { qualityFeedback } from '@/lib/quality-feedback'
import type {
  DatasetQualityResponse,
  EvaluateQualityResponse,
  QualityRuleInfo,
  QualityRuleKind,
} from '@/lib/foundry-types'
import { cn } from '@/lib/utils'
import { formatDistanceToNow, parseISO } from 'date-fns'

const KIND_LABELS: Record<QualityRuleKind, string> = {
  not_null: 'Not null',
  unique: 'Unique',
  range: 'Range',
  allowed_values: 'Allowed values',
  regex: 'Regex',
  freshness: 'Freshness',
  row_count_min: 'Row count min',
}

/** Kinds that need a column (freshness/row_count_min are dataset-level). */
const COLUMN_LESS = new Set<QualityRuleKind>(['freshness', 'row_count_min'])

export default function DatasetQualityPanel({
  datasetId,
  canEdit,
  columns,
  qualityGate,
  publishedVersion,
}: {
  datasetId: string
  canEdit: boolean
  columns: { name: string }[]
  /** P2: publication gate state from the dataset detail payload. */
  qualityGate: boolean
  publishedVersion: number | null
}) {
  const queryClient = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)

  // Add-rule form state
  const [name, setName] = useState('')
  const [kind, setKind] = useState<QualityRuleKind>('not_null')
  const [column, setColumn] = useState<string>('')
  const [severity, setSeverity] = useState<'warn' | 'error'>('warn')
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [values, setValues] = useState('')
  const [pattern, setPattern] = useState('')
  const [maxAgeMinutes, setMaxAgeMinutes] = useState('60')
  const [minRows, setMinRows] = useState('1')

  const qualityQuery = useQuery<DatasetQualityResponse>({
    queryKey: ['dataset-quality', datasetId],
    queryFn: () => apiJson<DatasetQualityResponse>(`/api/datasets/${datasetId}/quality`),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['dataset-quality', datasetId] })
  }

  const evaluateMutation = useMutation({
    mutationFn: () =>
      apiSend<EvaluateQualityResponse>(`/api/datasets/${datasetId}/quality/evaluate`, 'POST'),
    onSuccess: (res) => {
      const feedback = qualityFeedback(res)
      toast[feedback.level](feedback.message, { description: feedback.description })
      invalidate()
      void queryClient.invalidateQueries({ queryKey: ['dataset', datasetId] })
      void queryClient.invalidateQueries({ queryKey: ['approvals'] })
    },
    onError: (err) => toastApiError(err, 'Evaluation failed'),
  })

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiSend<QualityRuleInfo>(`/api/datasets/${datasetId}/quality`, 'POST', body),
    onSuccess: (rule) => {
      toast.success(`Rule '${rule.name}' added`)
      setAddOpen(false)
      setName('')
      invalidate()
    },
    onError: (err) => toastApiError(err, 'Could not create rule'),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ ruleId, enabled }: { ruleId: string; enabled: boolean }) =>
      apiSend(`/api/datasets/${datasetId}/quality/${ruleId}`, 'PATCH', { enabled }),
    onSuccess: () => invalidate(),
    onError: (err) => toastApiError(err, 'Could not update rule'),
  })

  const deleteMutation = useMutation({
    mutationFn: (ruleId: string) => apiSend(`/api/datasets/${datasetId}/quality/${ruleId}`, 'DELETE'),
    onSuccess: (_res, ruleId) => {
      const rule = qualityQuery.data?.rules.find((r) => r.id === ruleId)
      toast.success(`Rule '${rule?.name ?? 'rule'}' deleted`)
      invalidate()
    },
    onError: (err) => toastApiError(err, 'Could not delete rule'),
  })

  // P2: publication gate toggle (PATCH /api/datasets/[id] { qualityGate }).
  const gateMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiSend(`/api/datasets/${datasetId}`, 'PATCH', { qualityGate: enabled }),
    onSuccess: (_res, enabled) => {
      toast.success(
        enabled
          ? 'Quality gate enabled — new versions land as drafts'
          : 'Quality gate disabled — drafts published immediately',
      )
      void queryClient.invalidateQueries({ queryKey: ['dataset', datasetId] })
      invalidate()
    },
    onError: (err) => toastApiError(err, 'Could not update the quality gate'),
  })

  const resetForm = () => {
    setKind('not_null')
    setColumn('')
    setSeverity('warn')
    setMin('')
    setMax('')
    setValues('')
    setPattern('')
    setMaxAgeMinutes('60')
    setMinRows('1')
  }

  const buildConfig = (): Record<string, unknown> => {
    switch (kind) {
      case 'range': {
        const config: Record<string, unknown> = {}
        if (min !== '') config.min = Number(min)
        if (max !== '') config.max = Number(max)
        return config
      }
      case 'allowed_values':
        return { values: values.split(',').map((v) => v.trim()).filter(Boolean) }
      case 'regex':
        return { pattern }
      case 'freshness':
        return { maxAgeMinutes: Number(maxAgeMinutes) || 0 }
      case 'row_count_min':
        return { minRows: Number(minRows) || 0 }
      default:
        return {}
    }
  }

  const submitRule = () => {
    createMutation.mutate({
      name: name.trim(),
      kind,
      ...(COLUMN_LESS.has(kind) ? {} : { column }),
      config: buildConfig(),
      severity,
    })
  }

  const rules = qualityQuery.data?.rules ?? []

  return (
    <div className="space-y-4">
      {/* P2: publication gate control — the trust workflow entry point. */}
      <div
        className={cn(
          'flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between',
          qualityGate ? 'border-amber-500/30 bg-amber-500/[0.04]' : 'border-border bg-muted/30',
        )}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <ShieldCheck
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0',
              qualityGate ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
            )}
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">
              Publication gate{' '}
              <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                {qualityGate ? `consumers read v${publishedVersion ?? '—'}` : 'off — every version publishes immediately'}
              </span>
            </p>
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              When on, new versions land as <span className="font-mono">drafts</span> and pipelines,
              dashboards and objects keep reading the last published version until an editor
              publishes. Error-severity rule failures block publication.
            </p>
          </div>
        </div>
        <div className="shrink-0">
          <Switch
            checked={qualityGate}
            disabled={!canEdit || gateMutation.isPending}
            onCheckedChange={(enabled) => gateMutation.mutate(enabled)}
            aria-label="Toggle publication gate"
          />
        </div>
      </div>

      <Card>
      <div className="flex flex-col gap-3 border-b border-border p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-xs font-medium text-foreground">Quality rules</p>
            <p className="font-mono text-[11px] text-muted-foreground">
              {qualityQuery.data?.lastEvaluatedAt
                ? `last evaluated ${formatDistanceToNow(parseISO(qualityQuery.data.lastEvaluatedAt), { addSuffix: true })}`
                : 'never evaluated'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <GatedButton
            allowed={canEdit}
            reason="requires editor role"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={evaluateMutation.isPending}
            onClick={() => evaluateMutation.mutate()}
          >
            {evaluateMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden />
            )}
            Evaluate now
          </GatedButton>
          <Dialog open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (open) resetForm() }}>
            <GatedButton
              allowed={canEdit}
              reason="requires editor role"
              size="sm"
              className="h-8 text-xs"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add rule
            </GatedButton>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle className="text-sm">Add quality rule</DialogTitle>
                <DialogDescription className="text-xs">
                  Rules run against a version&apos;s rows on every evaluation.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="rule-name" className="text-xs">Name</Label>
                  <Input
                    id="rule-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="id not null"
                    className="h-8 text-xs"
                    autoFocus
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Kind</Label>
                    <Select value={kind} onValueChange={(v) => setKind(v as QualityRuleKind)}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(Object.keys(KIND_LABELS) as QualityRuleKind[]).map((k) => (
                          <SelectItem key={k} value={k} className="text-xs">
                            {KIND_LABELS[k]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Severity</Label>
                    <Select value={severity} onValueChange={(v) => setSeverity(v as 'warn' | 'error')}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="warn" className="text-xs">Warn</SelectItem>
                        <SelectItem value="error" className="text-xs">Error</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {!COLUMN_LESS.has(kind) && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Column</Label>
                    <Select value={column} onValueChange={setColumn}>
                      <SelectTrigger className="h-8 font-mono text-xs">
                        <SelectValue placeholder="Pick a column" />
                      </SelectTrigger>
                      <SelectContent>
                        {columns.map((col) => (
                          <SelectItem key={col.name} value={col.name} className="font-mono text-xs">
                            {col.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {kind === 'range' && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="rule-min" className="text-xs">Min</Label>
                      <Input id="rule-min" type="number" value={min} onChange={(e) => setMin(e.target.value)} className="h-8 font-mono text-xs" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="rule-max" className="text-xs">Max</Label>
                      <Input id="rule-max" type="number" value={max} onChange={(e) => setMax(e.target.value)} className="h-8 font-mono text-xs" />
                    </div>
                  </div>
                )}
                {kind === 'allowed_values' && (
                  <div className="space-y-1.5">
                    <Label htmlFor="rule-values" className="text-xs">Allowed values (comma-separated)</Label>
                    <Input id="rule-values" value={values} onChange={(e) => setValues(e.target.value)} placeholder="pending, shipped, delivered" className="h-8 font-mono text-xs" />
                  </div>
                )}
                {kind === 'regex' && (
                  <div className="space-y-1.5">
                    <Label htmlFor="rule-pattern" className="text-xs">Pattern</Label>
                    <Input id="rule-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="^[A-Z]{2}-\d+$" className="h-8 font-mono text-xs" />
                  </div>
                )}
                {kind === 'freshness' && (
                  <div className="space-y-1.5">
                    <Label htmlFor="rule-age" className="text-xs">Max age (minutes)</Label>
                    <Input id="rule-age" type="number" value={maxAgeMinutes} onChange={(e) => setMaxAgeMinutes(e.target.value)} className="h-8 font-mono text-xs" />
                  </div>
                )}
                {kind === 'row_count_min' && (
                  <div className="space-y-1.5">
                    <Label htmlFor="rule-minrows" className="text-xs">Minimum rows</Label>
                    <Input id="rule-minrows" type="number" value={minRows} onChange={(e) => setMinRows(e.target.value)} className="h-8 font-mono text-xs" />
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button
                  data-dialog-submit
                  size="sm"
                  className="h-8 text-xs"
                  disabled={!name.trim() || createMutation.isPending || (!COLUMN_LESS.has(kind) && !column)}
                  onClick={submitRule}
                >
                  {createMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                  Add rule
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {qualityQuery.isLoading ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : rules.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          No quality rules yet — add one to catch bad data on every evaluation.
        </div>
      ) : (
        <CardContent className="p-0">
          <div className="foundry-scroll max-h-96 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="h-8 px-3 text-[11px] uppercase tracking-wide text-muted-foreground">Rule</TableHead>
                  <TableHead className="h-8 px-3 text-[11px] uppercase tracking-wide text-muted-foreground">Kind</TableHead>
                  <TableHead className="h-8 px-3 text-[11px] uppercase tracking-wide text-muted-foreground">Column</TableHead>
                  <TableHead className="h-8 px-3 text-[11px] uppercase tracking-wide text-muted-foreground">Severity</TableHead>
                  <TableHead className="h-8 px-3 text-[11px] uppercase tracking-wide text-muted-foreground">Enabled</TableHead>
                  <TableHead className="h-8 px-3 text-[11px] uppercase tracking-wide text-muted-foreground">Last result</TableHead>
                  <TableHead className="h-8 w-10 px-3" aria-label="Delete" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.id} className="border-border hover:bg-accent/40">
                    <TableCell className="px-3 py-1.5 text-xs font-medium text-foreground">{rule.name}</TableCell>
                    <TableCell className="px-3 py-1.5">
                      <Badge variant="outline" className="border-border bg-muted px-1.5 py-0 font-mono text-[10px] font-normal text-muted-foreground">
                        {rule.kind}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                      {rule.column ?? <span className="text-muted-foreground/60">—</span>}
                    </TableCell>
                    <TableCell className="px-3 py-1.5">
                      <span
                        className={cn(
                          'rounded border px-1 text-[10px]',
                          rule.severity === 'error'
                            ? 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400'
                            : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
                        )}
                      >
                        {rule.severity}
                      </span>
                    </TableCell>
                    <TableCell className="px-3 py-1.5">
                      <Switch
                        checked={rule.enabled}
                        disabled={!canEdit || toggleMutation.isPending}
                        onCheckedChange={(enabled) => toggleMutation.mutate({ ruleId: rule.id, enabled })}
                        aria-label={`Toggle rule ${rule.name}`}
                        className="scale-90"
                      />
                    </TableCell>
                    <TableCell className="px-3 py-1.5">
                      {rule.lastResult ? (
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              'rounded border px-1 text-[10px]',
                              rule.lastResult.passed
                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                : 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
                            )}
                          >
                            {rule.lastResult.passed ? 'pass' : 'fail'}
                          </span>
                          <span className="max-w-56 truncate font-mono text-[11px] text-muted-foreground" title={rule.lastResult.message ?? undefined}>
                            {rule.lastResult.actual ?? '—'} · v{rule.lastResult.versionNumber}
                          </span>
                        </div>
                      ) : (
                        <span className="font-mono text-[11px] text-muted-foreground/60">not run</span>
                      )}
                    </TableCell>
                    <TableCell className="px-3 py-1.5 text-right">
                      <GatedButton
                        allowed={canEdit}
                        reason="requires editor role"
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete rule ${rule.name}`}
                        className="h-6 px-1.5 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                        disabled={deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate(rule.id)}
                      >
                        <Trash2 className="h-3 w-3" aria-hidden />
                      </GatedButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      )}
    </Card>
    </div>
  )
}
