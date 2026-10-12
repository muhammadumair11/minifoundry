'use client'

import Link from '@/components/link'
import { Database, ShieldAlert } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatRelative, freshnessLevel } from '@/lib/foundry-types'
import type { FailingPipeline, HealthDataset } from '@/lib/foundry-types'
import { cn } from '@/lib/utils'

const FRESHNESS_STYLES: Record<string, string> = {
  fresh: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  aging: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  stale: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
}

function FreshnessBadge({ minutes }: { minutes: number }) {
  const level = freshnessLevel(minutes)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium',
        FRESHNESS_STYLES[level],
      )}
    >
      {level} · {minutes}m
    </span>
  )
}

export function FreshnessCard({
  datasets,
  failingPipelines,
  loading,
}: {
  datasets: HealthDataset[]
  failingPipelines: FailingPipeline[]
  loading: boolean
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border p-4">
        <CardTitle className="text-sm font-semibold text-foreground">Data Freshness</CardTitle>
        {!loading && (
          <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {datasets.length} datasets
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-3 p-0">
        {/* Failing pipelines alert */}
        {failingPipelines.length > 0 && (
          <div id="failing-pipelines" className="scroll-mt-20 px-4 pt-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
              Failing pipelines
            </p>
            <ul className="space-y-1.5">
              {failingPipelines.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/pipelines/${p.id}`}
                    className="flex items-center justify-between gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 transition-colors hover:bg-rose-500/15"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500 dark:bg-rose-400"
                        aria-hidden
                      />
                      <span className="truncate text-xs font-medium text-foreground">{p.name}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-rose-600 dark:text-rose-400">
                      {p.failedCount} failed · {formatRelative(p.lastFailureAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Dataset freshness table */}
        {loading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : datasets.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <Database className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">
              No datasets yet — ingest data to see freshness here.
            </p>
          </div>
        ) : (
          <div className="foundry-scroll max-h-96 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="h-9 px-4 text-xs text-muted-foreground">Dataset</TableHead>
                  <TableHead className="h-9 px-3 text-right text-xs text-muted-foreground">Rows</TableHead>
                  <TableHead className="h-9 px-3 text-xs text-muted-foreground">Updated</TableHead>
                  <TableHead className="h-9 px-3 text-right text-xs text-muted-foreground">
                    Freshness
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {datasets.map((ds) => (
                  <TableRow key={ds.id} className="border-border/70">
                    <TableCell className="max-w-[180px] px-4 py-2">
                      <Link
                        href={`/datasets/${ds.id}`}
                        className="block truncate text-sm text-foreground underline-offset-2 hover:underline"
                        title={ds.name}
                      >
                        {ds.name}
                      </Link>
                    </TableCell>
                    <TableCell className="px-3 py-2 text-right font-mono text-xs text-foreground">
                      {ds.rowCount.toLocaleString()}
                    </TableCell>
                    <TableCell
                      className="px-3 py-2 font-mono text-xs text-muted-foreground"
                      title={ds.updatedAt}
                    >
                      {formatRelative(ds.updatedAt)}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-right">
                      <FreshnessBadge minutes={ds.freshnessMinutes} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="border-t border-border px-4 py-2 font-mono text-[10px] text-muted-foreground/80">
          fresh &lt; 15m · aging &lt; 2h · stale ≥ 2h
        </div>
      </CardContent>
    </Card>
  )
}
