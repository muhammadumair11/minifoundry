'use client'

// Phase 4 (collaboration) — "watch dataset" toggle. Watchers get a
// notification whenever this dataset receives a new version (targeted for
// session users, broadcast for the demo simulator).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { cn } from '@/lib/utils'

interface WatchState {
  watching: boolean
  watchers: number
}

export default function DatasetWatchButton({ datasetId }: { datasetId: string }) {
  const queryClient = useQueryClient()

  const watchQuery = useQuery({
    queryKey: ['dataset-watch', datasetId],
    queryFn: () => apiJson<WatchState>(`/api/datasets/${datasetId}/watch`),
    staleTime: 15_000,
  })

  const toggle = useMutation({
    mutationFn: (watch: boolean) =>
      apiSend<WatchState>(`/api/datasets/${datasetId}/watch`, 'POST', { watch }),
    onSuccess: (data) => {
      toast.success(
        data.watching
          ? `Watching — you'll be notified on new versions (${data.watchers} watcher${data.watchers === 1 ? '' : 's'})`
          : 'Unwatched — no more version notifications',
      )
      void queryClient.invalidateQueries({ queryKey: ['dataset-watch', datasetId] })
    },
    onError: (err) => toastApiError(err, 'Could not update watch'),
  })

  const state = watchQuery.data
  const watching = state?.watching ?? false

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('h-9 text-xs', watching && 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400')}
      disabled={watchQuery.isLoading || toggle.isPending}
      onClick={() => toggle.mutate(!watching)}
      aria-pressed={watching}
      aria-label={watching ? 'Stop watching this dataset' : 'Watch this dataset for new versions'}
      title={
        watching
          ? 'You are notified when a new version is written'
          : 'Get notified when a new version is written'
      }
    >
      {toggle.isPending ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : watching ? (
        <Eye className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      ) : (
        <EyeOff className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      )}
      {watching ? 'Watching' : 'Watch'}
      {state && state.watchers > 0 && (
        <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
          {state.watchers}
        </span>
      )}
    </Button>
  )
}
