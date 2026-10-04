'use client'

// Phase 3 (guided curriculum) — the progress-tracked learning path.
//
// The tracker renders the 18-step curriculum with LIVE verification:
// auto-verified steps show evidence pulled from real platform state
// ("3 successful ingestions"), manual steps offer an honest self-check
// checkbox. The first incomplete step is highlighted as "Up next".
// Data: GET/POST/DELETE /api/curriculum.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowRight,
  Check,
  CircleCheck,
  GraduationCap,
  Loader2,
  MousePointerClick,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'

interface CurriculumStepStatus {
  id: string
  title: string
  description: string
  teaches: string
  href: string
  cta: string
  verify: 'auto' | 'manual'
  done: boolean
  evidence: string | null
  source: 'auto' | 'manual' | null
  completedAt: string | null
}

interface CurriculumStatus {
  steps: CurriculumStepStatus[]
  completed: number
  total: number
  percent: number
  nextStepId: string | null
}

function loadCurriculum(): Promise<CurriculumStatus> {
  return apiJson<CurriculumStatus>('/api/curriculum')
}

export default function CurriculumTracker({ highlightStep }: { highlightStep?: string | null } = {}) {
  const queryClient = useQueryClient()
  const [confirmingReset, setConfirmingReset] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['curriculum'],
    queryFn: loadCurriculum,
    staleTime: 10_000,
  })

  // Deep link (?step=<id> from the dashboard Resume button): scroll the
  // requested step into view once the list has rendered.
  useEffect(() => {
    if (!highlightStep || isLoading || !data) return
    const el = document.querySelector<HTMLElement>(`[data-step-id="${CSS.escape(highlightStep)}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlightStep, isLoading, data])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['curriculum'] })
  }

  const toggleStep = useMutation({
    mutationFn: ({ stepId, done }: { stepId: string; done: boolean }) =>
      apiSend('/api/curriculum', 'POST', { stepId, done }),
    onSuccess: (_res, vars) => {
      toast.success(vars.done ? 'Step checked off' : 'Step unchecked')
      invalidate()
    },
    onError: (err) => toastApiError(err, 'Could not update step'),
  })

  const resetProgress = useMutation({
    mutationFn: () => apiSend('/api/curriculum', 'DELETE'),
    onSuccess: () => {
      toast.success('Manual progress reset — auto steps are still verified by the platform')
      setConfirmingReset(false)
      invalidate()
    },
    onError: (err) => toastApiError(err, 'Could not reset progress'),
  })

  if (isLoading || !data) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading curriculum progress">
        <Skeleton className="h-28 w-full" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    )
  }

  const complete = data.completed === data.total

  return (
    <div className="space-y-4">
      {/* Progress header */}
      <Card className={cn('overflow-hidden', complete && 'border-emerald-500/40')}>
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
          {/* ring */}
          <div className="relative mx-auto h-20 w-20 shrink-0 sm:mx-0" role="img" aria-label={`Curriculum ${data.percent}% complete`}>
            <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
              <circle cx="40" cy="40" r="34" fill="none" strokeWidth="8" className="stroke-muted" />
              <circle
                cx="40"
                cy="40"
                r="34"
                fill="none"
                strokeWidth="8"
                strokeLinecap="round"
                className={cn('transition-[stroke-dashoffset] duration-700', complete ? 'stroke-emerald-500' : 'stroke-amber-500')}
                strokeDasharray={2 * Math.PI * 34}
                strokeDashoffset={2 * Math.PI * 34 * (1 - data.percent / 100)}
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums">
              {data.percent}%
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold">
                {complete ? 'Curriculum complete' : 'Your learning path'}
              </h3>
              {complete ? (
                <Badge className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                  <GraduationCap className="h-3 w-3" aria-hidden /> {data.total} of {data.total} verified
                </Badge>
              ) : (
                <Badge variant="outline" className="tabular-nums">
                  {data.completed} of {data.total} steps
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {complete
                ? 'Every step is verified by real platform state — you have driven the whole loop: ingest → store → transform → serve → govern.'
                : 'Auto-verified steps are checked against REAL platform state as you work — no self-grading. Manual steps are honest check-offs.'}
            </p>
            <Progress value={data.percent} className="mt-3 h-1.5" aria-label="Curriculum progress" />
          </div>
          <div className="shrink-0">
            {confirmingReset ? (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => resetProgress.mutate(undefined)}
                  disabled={resetProgress.isPending}
                >
                  {resetProgress.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />}
                  Confirm reset
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmingReset(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmingReset(true)} disabled={data.completed === 0}>
                <RotateCcw className="mr-1.5 h-3 w-3" aria-hidden />
                Reset progress
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Stepper */}
      <ol className="relative space-y-2" aria-label="Curriculum steps">
        {data.steps.map((step, idx) => {
          const isNext = step.id === data.nextStepId
          const isHighlighted = step.id === highlightStep
          return (
            <li key={step.id} className="relative pl-10" data-step-id={step.id}>
              {/* rail connector */}
              {idx < data.steps.length - 1 && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute left-[15px] top-8 h-[calc(100%-1rem)] w-px',
                    step.done ? 'bg-emerald-500/50' : 'bg-border',
                  )}
                />
              )}
              {/* node */}
              <span
                aria-hidden
                className={cn(
                  'absolute left-0 top-2.5 flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold transition-colors',
                  step.done && 'border-emerald-500 bg-emerald-500 text-white',
                  !step.done && isNext && 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400',
                  !step.done && !isNext && 'border-border bg-muted text-muted-foreground',
                )}
              >
                {step.done ? <Check className="h-4 w-4" /> : idx + 1}
              </span>

              <Card
                className={cn(
                  'transition-colors',
                  step.done && 'border-emerald-500/25 bg-emerald-500/[0.03]',
                  !step.done && isNext && 'border-amber-500/50 shadow-[0_0_0_1px_rgba(245,158,11,0.15)]',
                  // deep-linked step (dashboard Resume) gets a distinct ring
                  isHighlighted && !step.done && 'ring-2 ring-amber-500/40',
                )}
              >
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold">{step.title}</h4>
                    {isNext && !complete && (
                      <Badge className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                        <MousePointerClick className="h-3 w-3" aria-hidden /> Up next
                      </Badge>
                    )}
                    {step.verify === 'auto' ? (
                      <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
                        <ShieldCheck className="h-3 w-3" aria-hidden /> auto-verified
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
                        self-check
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{step.description}</p>
                  <p className="mt-1.5 border-l-2 border-border pl-2 text-[11px] italic text-muted-foreground/90">
                    Teaches: {step.teaches}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={step.href}
                      className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {step.cta} <ArrowRight className="h-3 w-3" aria-hidden />
                    </Link>
                    <div className="flex items-center gap-2">
                      {step.done && step.source === 'auto' && step.evidence && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                          <CircleCheck className="h-3.5 w-3.5" aria-hidden /> {step.evidence}
                        </span>
                      )}
                      {step.done && step.source === 'manual' && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                          <CircleCheck className="h-3.5 w-3.5" aria-hidden /> checked off by you
                        </span>
                      )}
                      {step.verify === 'manual' && (
                        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                          <Checkbox
                            checked={step.done}
                            disabled={toggleStep.isPending}
                            onCheckedChange={(v) =>
                              toggleStep.mutate({ stepId: step.id, done: v === true })
                            }
                            aria-label={`${step.done ? 'Uncheck' : 'Check off'} step: ${step.title}`}
                          />
                          {step.done ? 'Done' : 'Mark done'}
                        </label>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </li>
          )
        })}
      </ol>

      {complete && (
        <Card className="border-emerald-500/40 bg-gradient-to-r from-emerald-500/10 to-amber-500/5">
          <CardContent className="flex items-center gap-3 p-4">
            <Sparkles className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <p className="text-sm">
              <span className="font-semibold">You drove the full platform loop.</span>{' '}
              <span className="text-muted-foreground">
                Reset the progress to run it again as a different role — the platform verifies the same actions either way.
              </span>
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
