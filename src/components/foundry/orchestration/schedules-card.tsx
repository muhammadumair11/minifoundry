'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CalendarClock, Plus, Trash2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { apiJson } from '@/lib/foundry-api'
import { formatInterval, formatRelative } from '@/lib/foundry-types'
import type {
  PipelinesListResponse,
  Schedule,
  ScheduleListResponse,
  ScheduleResponse,
} from '@/lib/foundry-types'

const INTERVAL_PRESETS = [
  { minutes: 5, label: '5m' },
  { minutes: 10, label: '10m' },
  { minutes: 15, label: '15m' },
  { minutes: 30, label: '30m' },
  { minutes: 60, label: '1h' },
  { minutes: 180, label: '3h' },
  { minutes: 360, label: '6h' },
  { minutes: 1440, label: '24h' },
] as const

const CUSTOM_INTERVAL = 'custom'

function SchedulesTableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  )
}

export function SchedulesCard() {
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pipelineId, setPipelineId] = useState('')
  const [name, setName] = useState('')
  const [intervalChoice, setIntervalChoice] = useState<string>('10')
  const [customInterval, setCustomInterval] = useState('')

  const schedulesQuery = useQuery<ScheduleListResponse>({
    queryKey: ['schedules'],
    queryFn: () => apiJson<ScheduleListResponse>('/api/schedules'),
  })
  const schedules: Schedule[] = schedulesQuery.data?.schedules ?? []

  const pipelinesQuery = useQuery<PipelinesListResponse>({
    queryKey: ['pipelines'],
    queryFn: () => apiJson<PipelinesListResponse>('/api/pipelines'),
  })
  const pipelines = pipelinesQuery.data?.pipelines ?? []

  const resolvedIntervalMinutes =
    intervalChoice === CUSTOM_INTERVAL
      ? Number.parseInt(customInterval, 10)
      : Number.parseInt(intervalChoice, 10)
  const canSubmit = pipelineId !== '' && Number.isFinite(resolvedIntervalMinutes) && resolvedIntervalMinutes >= 1

  const resetForm = () => {
    setPipelineId('')
    setName('')
    setIntervalChoice('10')
    setCustomInterval('')
  }

  const invalidateSchedules = () => {
    void queryClient.invalidateQueries({ queryKey: ['schedules'] })
  }

  const createMutation = useMutation({
    mutationFn: (body: { pipelineId: string; name?: string; intervalMinutes: number }) =>
      apiJson<ScheduleResponse>('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (res) => {
      toast.success('Schedule created', {
        description: `${res.schedule.name} — runs ${formatInterval(res.schedule.intervalMinutes)} on ${res.schedule.pipelineName}.`,
      })
      invalidateSchedules()
      resetForm()
      setDialogOpen(false)
    },
    onError: (err: Error) =>
      toast.error('Could not create schedule', { description: err.message }),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ schedule, enabled }: { schedule: Schedule; enabled: boolean }) =>
      apiJson<ScheduleResponse>(`/api/schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (res) => {
      toast.success(res.schedule.enabled ? 'Schedule enabled' : 'Schedule paused', {
        description: res.schedule.enabled
          ? `Runs ${formatInterval(res.schedule.intervalMinutes)} — next ${formatRelative(res.schedule.nextRunAt)}.`
          : 'Next run cleared until re-enabled.',
      })
      invalidateSchedules()
    },
    onError: (err: Error) =>
      toast.error('Could not update schedule', { description: err.message }),
  })

  const deleteMutation = useMutation({
    mutationFn: (schedule: Schedule) =>
      apiJson<void>(`/api/schedules/${schedule.id}`, { method: 'DELETE' }),
    onSuccess: (_res, schedule) => {
      toast.success('Schedule deleted', { description: schedule.name })
      invalidateSchedules()
    },
    onError: (err: Error) =>
      toast.error('Could not delete schedule', { description: err.message }),
  })

  const handleSubmit = () => {
    if (!canSubmit) return
    createMutation.mutate({
      pipelineId,
      name: name.trim() || undefined,
      intervalMinutes: resolvedIntervalMinutes,
    })
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border p-4">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm font-semibold text-foreground">Schedules</CardTitle>
          {!schedulesQuery.isLoading && (
            <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {schedules.length}
            </span>
          )}
        </div>
        <Dialog
          open={dialogOpen}
          onOpenChange={(next) => {
            setDialogOpen(next)
            if (!next) resetForm()
          }}
        >
          <DialogTrigger asChild>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              aria-label="New schedule"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              New schedule
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-card sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-foreground">New schedule</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Trigger a pipeline automatically on a fixed interval.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="schedule-pipeline" className="text-xs font-medium text-muted-foreground">
                  Pipeline
                </label>
                <Select value={pipelineId} onValueChange={setPipelineId}>
                  <SelectTrigger
                    id="schedule-pipeline"
                    className="w-full text-sm"
                  >
                    <SelectValue placeholder="Select a pipeline" />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    {pipelines.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="text-sm">
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {pipelines.length === 0 && !pipelinesQuery.isLoading && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    No pipelines yet — create one first.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <label htmlFor="schedule-name" className="text-xs font-medium text-muted-foreground">
                  Name <span className="text-muted-foreground/80">(optional)</span>
                </label>
                <Input
                  id="schedule-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Hourly refresh"
                  className="text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="schedule-interval" className="text-xs font-medium text-muted-foreground">
                  Interval
                </label>
                <Select value={intervalChoice} onValueChange={setIntervalChoice}>
                  <SelectTrigger
                    id="schedule-interval"
                    className="w-full text-sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERVAL_PRESETS.map((preset) => (
                      <SelectItem key={preset.minutes} value={String(preset.minutes)}>
                        <span className="font-mono text-xs">{preset.label}</span>
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM_INTERVAL}>
                      <span className="text-xs">Custom…</span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                {intervalChoice === CUSTOM_INTERVAL && (
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={customInterval}
                    onChange={(e) => setCustomInterval(e.target.value)}
                    placeholder="Interval in minutes"
                    aria-label="Custom interval in minutes"
                    className="font-mono text-sm"
                  />
                )}
                {canSubmit && (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    runs {formatInterval(resolvedIntervalMinutes)}
                  </p>
                )}
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                data-dialog-submit
                size="sm"
                onClick={handleSubmit}
                disabled={!canSubmit || createMutation.isPending}
              >
                {createMutation.isPending ? 'Creating…' : 'Create schedule'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="p-0">
        {schedulesQuery.isLoading ? (
          <SchedulesTableSkeleton />
        ) : schedulesQuery.isError ? (
          <p className="p-6 text-center text-sm text-rose-600 dark:text-rose-400">
            {schedulesQuery.error instanceof Error
              ? schedulesQuery.error.message
              : 'Failed to load schedules.'}
          </p>
        ) : schedules.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <CalendarClock className="h-8 w-8 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium text-foreground">No schedules — automate a pipeline</p>
              <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
                Schedules run pipelines on a fixed interval without manual clicks.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => setDialogOpen(true)}
              disabled={pipelines.length === 0}
              className="h-8 text-xs"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              New schedule
            </Button>
          </div>
        ) : (
          <div className="foundry-scroll max-h-96 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="h-9 px-4 text-xs text-muted-foreground">Schedule</TableHead>
                  <TableHead className="h-9 px-3 text-xs text-muted-foreground">Interval</TableHead>
                  <TableHead className="h-9 px-3 text-xs text-muted-foreground">Enabled</TableHead>
                  <TableHead className="h-9 px-3 text-xs text-muted-foreground">Last run</TableHead>
                  <TableHead className="h-9 px-3 text-xs text-muted-foreground">Next run</TableHead>
                  <TableHead className="h-9 w-10 px-2">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((s) => (
                  <TableRow key={s.id} className="border-border/70">
                    <TableCell className="max-w-[200px] px-4 py-2">
                      <p className="truncate text-sm font-medium text-foreground">{s.name}</p>
                      <Link
                        href={`/pipelines/${s.pipelineId}`}
                        className="block truncate font-mono text-[11px] text-muted-foreground hover:text-foreground"
                        title={`Open builder — ${s.pipelineName}`}
                      >
                        {s.pipelineName}
                      </Link>
                    </TableCell>
                    <TableCell className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {formatInterval(s.intervalMinutes)}
                    </TableCell>
                    <TableCell className="px-3 py-2">
                      <Switch
                        checked={s.enabled}
                        disabled={
                          toggleMutation.isPending &&
                          toggleMutation.variables?.schedule.id === s.id
                        }
                        onCheckedChange={(enabled) => toggleMutation.mutate({ schedule: s, enabled })}
                        aria-label={`${s.enabled ? 'Disable' : 'Enable'} schedule ${s.name}`}
                      />
                    </TableCell>
                    <TableCell
                      className="px-3 py-2 font-mono text-xs text-muted-foreground"
                      title={s.lastRunAt ?? undefined}
                    >
                      {formatRelative(s.lastRunAt)}
                    </TableCell>
                    <TableCell
                      className={`px-3 py-2 font-mono text-xs ${
                        s.enabled ? 'text-muted-foreground' : 'text-muted-foreground/80'
                      }`}
                      title={s.nextRunAt ?? undefined}
                    >
                      {s.enabled ? formatRelative(s.nextRunAt) : '—'}
                    </TableCell>
                    <TableCell className="px-2 py-2 text-right">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400"
                            aria-label={`Delete schedule ${s.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent className="bg-card sm:max-w-sm">
                          <AlertDialogHeader>
                            <AlertDialogTitle className="text-foreground">
                              Delete schedule?
                            </AlertDialogTitle>
                            <AlertDialogDescription className="text-muted-foreground">
                              <span className="font-medium text-foreground">{s.name}</span> will stop
                              running {formatInterval(s.intervalMinutes)} on{' '}
                              <span className="font-medium text-foreground">{s.pipelineName}</span>.
                              This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel className="text-muted-foreground hover:text-foreground">
                              Cancel
                            </AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteMutation.mutate(s)}
                              disabled={deleteMutation.isPending}
                              className="bg-rose-600 text-white hover:bg-rose-500 dark:bg-rose-500 dark:text-zinc-950 dark:hover:bg-rose-400"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
