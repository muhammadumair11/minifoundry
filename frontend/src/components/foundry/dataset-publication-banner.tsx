'use client'

// P2 trust workflow — publication banner for gated datasets.
// Shown on the dataset detail page when the quality gate is ON and at least
// one draft version is waiting. Surfaces the trust story explicitly:
//   preview (draft lands) → validate (auto quality) → publish (consumers move).
// Publish is blocked by the API when error-severity rules failed; the
// response's reasons are rendered inline so the block is self-explanatory.

import { useState } from 'react'
import Link from '@/components/link'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowRight, Loader2, PlayCircle, ShieldAlert, ShieldCheck, UploadCloud } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { GatedButton } from '@/components/foundry/governance/gated-button'
import { apiSend, toastApiError } from '@/lib/foundry-api'
import type { DatasetDetailResponse, EvaluateQualityResponse } from '@/lib/foundry-types'
import { cn } from '@/lib/utils'

const QUALITY_CHIP: Record<string, { label: string; className: string }> = {
  passed: { label: 'quality passed', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  warned: { label: 'quality warned', className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  failed: { label: 'quality failed', className: 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400' },
  not_evaluated: { label: 'not evaluated', className: 'border-border bg-muted text-muted-foreground' },
}

export default function DatasetPublicationBanner({
  datasetId,
  detail,
  canEdit,
}: {
  datasetId: string
  detail: DatasetDetailResponse
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const [blockedReasons, setBlockedReasons] = useState<string[] | null>(null)

  const head = detail.versions.find((v) => v.branch === 'main')
  const drafts = detail.versions.filter((v) => v.branch === 'main' && v.lifecycle === 'draft')
  const latestDraft = drafts[0] // versions are ordered desc
  const publishedVersion = detail.dataset.publishedVersion ?? null

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['dataset', datasetId] })
    void queryClient.invalidateQueries({ queryKey: ['dataset-rows', datasetId] })
    void queryClient.invalidateQueries({ queryKey: ['dataset-quality', datasetId] })
  }

  const publishMutation = useMutation({
    mutationFn: () =>
      apiSend(`/api/approvals`, 'POST', { kind: 'publish_dataset', targetId: datasetId }),
    onSuccess: () => {
      setBlockedReasons(null)
      toast.success(`Approval requested for v${latestDraft.versionNumber}`)
      invalidateAll()
    },
    onError: (err) => {
      // Surface the gate's reasons inline (publish blocked by quality).
      const parsed = (err as { payload?: { error?: string; detail?: { reasons?: string[] } } }).payload
      const reasons = parsed?.detail?.reasons
      if (reasons && reasons.length > 0) {
        setBlockedReasons(reasons)
      } else {
        setBlockedReasons(null)
      }
      toastApiError(err, 'Could not request publication')
    },
  })

  const validateMutation = useMutation({
    mutationFn: () =>
      apiSend<EvaluateQualityResponse>(`/api/datasets/${datasetId}/quality/evaluate`, 'POST'),
    onSuccess: (res) => {
      const failures = res.results.filter((r) => !r.passed)
      if (failures.length === 0) {
        toast.success(`Quality passed on v${res.versionNumber} — ${res.passed} rule${res.passed === 1 ? '' : 's'} ok`)
      } else {
        toast.warning(`Quality: ${res.failed} of ${res.results.length} rules failed on v${res.versionNumber}`)
      }
      invalidateAll()
    },
    onError: (err) => toastApiError(err, 'Evaluation failed'),
  })

  const chip = QUALITY_CHIP[latestDraft?.qualityState ?? 'not_evaluated'] ?? QUALITY_CHIP.not_evaluated
  const blocked = latestDraft?.qualityState !== 'passed' && latestDraft?.qualityState !== 'warned'
  const consumersLag = publishedVersion != null && head != null && publishedVersion < head.versionNumber

  // Hooks are done — the banner only renders for gated datasets with drafts.
  if (!detail.dataset.qualityGate || !latestDraft || !head) return null

  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        blocked
          ? 'border-rose-500/30 bg-rose-500/[0.04]'
          : 'border-amber-500/30 bg-amber-500/[0.04]',
      )}
      role="status"
      aria-label="Publication status"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          {blocked ? (
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />
          ) : (
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          )}
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-foreground">
              Quality gate on
              <Badge variant="outline" className={cn('px-1.5 py-0 font-mono text-[10px] font-normal', chip.className)}>
                v{latestDraft.versionNumber} {chip.label}
              </Badge>
              <span className="font-mono text-[11px] font-normal text-muted-foreground">
                {drafts.length} draft{drafts.length === 1 ? '' : 's'} waiting
              </span>
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Consumers see{' '}
              <span className="font-mono">
                {consumersLag || publishedVersion == null ? `v${publishedVersion ?? '—'}` : `v${publishedVersion}`}
              </span>
              {publishedVersion != null && (
                <Link
                  href="/lineage"
                  className="ml-1.5 inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
                >
                  impact view <ArrowRight className="h-3 w-3" aria-hidden />
                </Link>
              )}
              {blocked && ' — fix the failing error rules, re-validate, then publish'}
            </p>
            {blockedReasons && blockedReasons.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 rounded-md border border-rose-500/30 bg-background/60 p-2">
                {blockedReasons.map((r) => (
                  <li key={r} className="font-mono text-[10.5px] text-rose-700 dark:text-rose-400">
                    · {r}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <GatedButton
            allowed={canEdit}
            reason="requires editor role"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={validateMutation.isPending}
            onClick={() => validateMutation.mutate()}
          >
            {validateMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <PlayCircle className="h-3.5 w-3.5" aria-hidden />
            )}
            Validate
          </GatedButton>
          <GatedButton
            allowed={canEdit}
            reason="requires editor role"
            size="sm"
            className="h-8 text-xs"
            disabled={publishMutation.isPending || blocked}
            title={blocked ? 'Complete a passing quality evaluation first' : undefined}
            onClick={() => publishMutation.mutate()}
          >
            {publishMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <UploadCloud className="h-3.5 w-3.5" aria-hidden />
            )}
            Request approval for v{latestDraft.versionNumber}
          </GatedButton>
        </div>
      </div>
    </div>
  )
}
