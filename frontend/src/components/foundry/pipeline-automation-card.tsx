'use client'

// R14 (14-b) — pipeline trigger automation (upstream triggers + retries).
// Editor-gated dialog rendered from the pipeline builder toolbar: trigger mode
// (manual / on-upstream-update), watched upstream datasets (checkbox popover),
// and the max automatic retry policy (0-5). Saves via the pipeline PATCH route.
// Viewers get a read-only chip summary instead of the form.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, ChevronDown, Loader2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import AclDialog from '@/components/foundry/acl-dialog'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import type { DatasetSummary, SessionResponse } from '@/lib/foundry-types'

export interface PipelineAutomationConfig {
  triggerMode: string
  upstreamDatasetIds: string[]
  maxRetries: number
}

interface PipelineAutomationProps {
  pipelineId: string
  config: PipelineAutomationConfig
  datasets: DatasetSummary[]
}

/** Uppercase trigger-mode chip colors (manual=zinc, upstream=teal). */
export function TriggerModeChip({ mode }: { mode: string }) {
  const isUpstream = mode === 'upstream'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
        isUpstream
          ? 'border-teal-600/30 bg-teal-500/10 text-teal-600 dark:border-teal-400/30 dark:text-teal-400'
          : 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400'
      }`}
      title={isUpstream ? 'Runs automatically when an upstream dataset gets a new version' : 'Manual runs only'}
    >
      <Zap className="h-3 w-3" aria-hidden />
      {mode}
    </span>
  )
}

export function PipelineAutomation({ pipelineId, config, datasets }: PipelineAutomationProps) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [datasetsOpen, setDatasetsOpen] = useState(false)
  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const canEdit = sessionQuery.data?.role === 'editor' || sessionQuery.data?.role === 'admin'

  // Draft state — seeded from the saved config when the dialog OPENS (event
  // handler, not an effect, so refetches never clobber in-flight edits).
  const [triggerMode, setTriggerMode] = useState(config.triggerMode)
  const [selectedIds, setSelectedIds] = useState<string[]>(config.upstreamDatasetIds)
  const [retries, setRetries] = useState(String(config.maxRetries))
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setTriggerMode(config.triggerMode)
      setSelectedIds(config.upstreamDatasetIds)
      setRetries(String(config.maxRetries))
    }
    setOpen(next)
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      apiSend(`/api/pipelines/${pipelineId}`, 'PATCH', {
        triggerMode,
        upstreamDatasetIds: selectedIds,
        maxRetries: Math.max(0, Math.min(5, Number(retries) || 0)),
      }),
    onSuccess: () => {
      toast.success('Automation saved', {
        description:
          triggerMode === 'upstream'
            ? `Runs automatically when any of ${selectedIds.length} watched dataset${selectedIds.length === 1 ? '' : 's'} gets a new version.`
            : 'Manual runs only.',
      })
      void queryClient.invalidateQueries({ queryKey: ['pipeline', pipelineId] })
      void queryClient.invalidateQueries({ queryKey: ['pipelines'] })
      setOpen(false)
    },
    onError: (err) => toastApiError(err, 'Save failed'),
  })

  const datasetsById = new Map(datasets.map((d) => [d.id, d]))
  const watchedNames = config.upstreamDatasetIds
    .map((id) => datasetsById.get(id)?.name ?? id.slice(0, 8))
  const retriesNum = Math.max(0, Math.min(5, Number(retries) || 0))

  const toggleDataset = (id: string) =>
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <div className="flex items-center gap-1.5">
        {/* Always-visible current mode chip (viewer-friendly summary). */}
        <TriggerModeChip mode={config.triggerMode} />
        {config.triggerMode === 'upstream' && config.upstreamDatasetIds.length > 0 && (
          <span className="hidden whitespace-nowrap text-[11px] text-muted-foreground md:inline" title={watchedNames.join(', ')}>
            watches {config.upstreamDatasetIds.length} dataset{config.upstreamDatasetIds.length === 1 ? '' : 's'}
          </span>
        )}
        {config.maxRetries > 0 && (
          <span className="hidden whitespace-nowrap text-[11px] text-muted-foreground md:inline">
            retries ≤{config.maxRetries}
          </span>
        )}
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            aria-label="Edit trigger automation"
          >
            <Zap className="h-3.5 w-3.5" aria-hidden />
            Automation
          </Button>
        </DialogTrigger>
      </div>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base text-foreground">Trigger automation</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {canEdit
              ? 'Run this pipeline automatically when a watched upstream dataset gets a new version, with an automatic retry policy for failed runs.'
              : 'Current automation configuration (editor access required to change it).'}
          </DialogDescription>
        </DialogHeader>

        {canEdit ? (
          <div className="grid gap-4 py-1">
            <div className="grid gap-1.5">
              <Label htmlFor="trigger-mode" className="text-xs text-muted-foreground">
                Trigger mode
              </Label>
              <Select value={triggerMode} onValueChange={setTriggerMode}>
                <SelectTrigger id="trigger-mode" className="h-9 text-sm">
                  <SelectValue placeholder="Select trigger mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual — run from the Run button only</SelectItem>
                  <SelectItem value="upstream">On upstream update — watched datasets</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {triggerMode === 'upstream' && (
              <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">
                  Upstream datasets ({selectedIds.length} watched)
                </Label>
                <Popover open={datasetsOpen} onOpenChange={setDatasetsOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={datasetsOpen}
                      aria-label="Choose upstream datasets to watch"
                      className="h-9 justify-between text-sm font-normal"
                    >
                      <span className="truncate text-left">
                        {selectedIds.length === 0
                          ? 'Choose datasets…'
                          : selectedIds
                              .map((id) => datasetsById.get(id)?.name ?? id.slice(0, 8))
                              .join(', ')}
                      </span>
                      <ChevronDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80 p-0" align="start">
                    <div className="foundry-scroll max-h-64 overflow-y-auto p-1">
                      {datasets.length === 0 ? (
                        <p className="p-3 text-xs text-muted-foreground">No datasets yet.</p>
                      ) : (
                        datasets.map((dataset) => {
                          const checked = selectedIds.includes(dataset.id)
                          return (
                            <label
                              key={dataset.id}
                              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => toggleDataset(dataset.id)}
                                aria-label={`Watch dataset ${dataset.name}`}
                              />
                              <span className="min-w-0 flex-1 truncate">{dataset.name}</span>
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {dataset.currentVersion?.rowCount?.toLocaleString() ?? '0'} rows
                              </span>
                            </label>
                          )
                        })
                      )}
                    </div>
                    {selectedIds.length > 0 && (
                      <div className="border-t border-border p-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-full text-xs"
                          onClick={() => setSelectedIds([])}
                        >
                          Clear selection
                        </Button>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
                <p className="text-[11px] leading-4 text-muted-foreground">
                  A new version of any watched dataset (ingestion, transform or pipeline output)
                  starts a run with trigger <span className="font-mono">upstream</span>.
                </p>
              </div>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor="max-retries" className="text-xs text-muted-foreground">
                Max retries for failed runs (0-5)
              </Label>
              <Input
                id="max-retries"
                type="number"
                min={0}
                max={5}
                value={retries}
                onChange={(e) => setRetries(e.target.value)}
                className="h-9 w-24 font-mono text-sm"
              />
              <p className="text-[11px] leading-4 text-muted-foreground">
                Failed automatic runs retry after 2s with trigger{' '}
                <span className="font-mono">retry</span>; final failures notify the team.
              </p>
            </div>
          </div>
        ) : (
          /* Viewer read-only summary */
          <div className="space-y-2 py-2 text-[11px] text-muted-foreground">
            <p>
              Trigger mode:{' '}
              <span className="font-medium text-foreground">
                {config.triggerMode === 'upstream' ? 'On upstream update' : 'Manual'}
              </span>
            </p>
            {config.triggerMode === 'upstream' && (
              <p>
                Watched datasets:{' '}
                {watchedNames.length > 0 ? (
                  <span className="text-foreground">{watchedNames.join(', ')}</span>
                ) : (
                  'none selected'
                )}
              </p>
            )}
            <p>
              Max retries: <span className="font-medium text-foreground">{config.maxRetries}</span>
            </p>
          </div>
        )}

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          {sessionQuery.data?.role === 'admin' ? (
            <AclDialog resourceType="pipeline" resourceId={pipelineId} canManage />
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {canEdit ? 'Cancel' : 'Close'}
            </Button>
            {canEdit && (
              <Button
                data-dialog-submit
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                className="gap-1.5"
              >
                {saveMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Check className="h-4 w-4" aria-hidden />
                )}
                Save automation
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
