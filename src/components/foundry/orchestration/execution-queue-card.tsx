'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apiJson } from '@/lib/foundry-api'

interface QueueJob {
  id: string
  pipelineId: string
  pipelineName: string
  versionNumber: number
  trigger: string
  status: string
  leaseExpired: boolean
  attempt: number
  maxAttempts: number
  error: string | null
  lastRunId: string | null
}

export function ExecutionQueueCard() {
  const query = useQuery<{ jobs: QueueJob[] }>({
    queryKey: ['execution-jobs'],
    queryFn: () => apiJson('/api/execution-jobs'),
    refetchInterval: 5_000,
  })
  const jobs = query.data?.jobs ?? []
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Execution queue</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-xs">
        {query.isLoading && <p className="text-muted-foreground">Loading queued work…</p>}
        {query.isError && <p role="alert">Could not load queued work.</p>}
        {!query.isLoading && jobs.length === 0 && <p className="text-muted-foreground">No queued work yet.</p>}
        {jobs.map((job) => (
          <div key={job.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2">
            <span>
              <Link className="font-medium underline-offset-2 hover:underline" href={`/pipelines/${job.pipelineId}`}>
                {job.pipelineName}
              </Link>{' '}
              <span className="text-muted-foreground">v{job.versionNumber} · {job.trigger}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="font-medium">{job.leaseExpired ? 'lease expired' : job.status}</span>
              <span className="text-muted-foreground">attempt {job.attempt}/{job.maxAttempts}</span>
              {job.lastRunId && <span className="font-mono text-muted-foreground" title={job.lastRunId}>run {job.lastRunId.slice(0, 8)}</span>}
            </span>
            {job.error && <p className="w-full text-destructive" role="alert">{job.error}</p>}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
