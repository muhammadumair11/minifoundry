'use client'

// R14 version compare panel: pick two versions → schema diff chips + row
// diff tables (added / removed / changed). Shown in the dataset History tab.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ChevronDown, GitCompareArrows, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { apiJson } from '@/lib/foundry-api'
import type { VersionDiffResponse } from '@/lib/foundry-types'
import { cn } from '@/lib/utils'

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '∅'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function DiffTable({
  rows,
  emptyText,
}: {
  rows: Record<string, unknown>[]
  emptyText: string
}) {
  const cols = useMemo(() => Object.keys(rows[0] ?? {}), [rows])
  if (rows.length === 0) {
    return <p className="px-4 py-3 text-[11px] text-muted-foreground">{emptyText}</p>
  }
  return (
    <div className="foundry-scroll max-h-72 overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="border-border hover:bg-transparent">
            {cols.map((col) => (
              <TableHead key={col} className="h-7 whitespace-nowrap px-3 font-mono text-[11px] text-muted-foreground">
                {col}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i} className="border-border hover:bg-accent/40">
              {cols.map((col) => (
                <TableCell key={col} className="max-w-64 truncate whitespace-nowrap px-3 py-1 font-mono text-[13px] text-foreground">
                  {renderCell(row[col])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export default function DatasetDiffPanel({
  datasetId,
  versions,
}: {
  datasetId: string
  versions: { versionNumber: number; rowCount: number }[]
}) {
  const [from, setFrom] = useState<number | null>(versions[1]?.versionNumber ?? null)
  const [to, setTo] = useState<number | null>(versions[0]?.versionNumber ?? null)

  const diffQuery = useQuery<VersionDiffResponse>({
    queryKey: ['dataset-diff', datasetId, from, to],
    queryFn: () => apiJson<VersionDiffResponse>(`/api/datasets/${datasetId}/diff?from=${from}&to=${to}`),
    enabled: from !== null && to !== null && from !== to,
    placeholderData: (prev) => prev,
  })

  if (versions.length < 2) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-xs text-muted-foreground">
          <GitCompareArrows className="mx-auto mb-2 h-4 w-4" aria-hidden />
          Compare needs at least two versions — this dataset only has {versions.length}.
        </CardContent>
      </Card>
    )
  }

  const diff = diffQuery.data
  const diffError =
    diffQuery.isError && diffQuery.error instanceof Error ? diffQuery.error.message : null

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-border p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <GitCompareArrows className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-xs font-medium text-foreground">Compare versions</p>
            <p className="font-mono text-[11px] text-muted-foreground">schema + row diff, keyed by first column</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Select
            value={from !== null ? String(from) : undefined}
            onValueChange={(v) => setFrom(Number(v))}
          >
            <SelectTrigger aria-label="From version" className="h-8 w-[120px] font-mono text-xs">
              <SelectValue placeholder="From" />
            </SelectTrigger>
            <SelectContent>
              {versions.map((v) => (
                <SelectItem key={v.versionNumber} value={String(v.versionNumber)} className="font-mono text-xs">
                  v{v.versionNumber} · {v.rowCount.toLocaleString()} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <Select
            value={to !== null ? String(to) : undefined}
            onValueChange={(v) => setTo(Number(v))}
          >
            <SelectTrigger aria-label="To version" className="h-8 w-[120px] font-mono text-xs">
              <SelectValue placeholder="To" />
            </SelectTrigger>
            <SelectContent>
              {versions.map((v) => (
                <SelectItem key={v.versionNumber} value={String(v.versionNumber)} className="font-mono text-xs">
                  v{v.versionNumber} · {v.rowCount.toLocaleString()} rows
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {from === to ? (
        <CardContent className="p-6 text-center text-xs text-muted-foreground">
          Pick two different versions to compare.
        </CardContent>
      ) : diffError ? (
        <CardContent className="p-6 text-center text-sm text-rose-600 dark:text-rose-400">{diffError}</CardContent>
      ) : diffQuery.isLoading || !diff ? (
        <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Computing diff…
        </div>
      ) : (
        <CardContent className="space-y-3 p-4">
          {/* Summary counts */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[11px]">
            <span className="text-foreground">
              v{diff.fromVersion} <ArrowRight className="inline h-3 w-3" aria-hidden /> v{diff.toVersion}
            </span>
            <span className="text-muted-foreground">
              rows {diff.rowCount.from.toLocaleString()} → {diff.rowCount.to.toLocaleString()}
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">+{diff.schema.added.length + diff.addedRows.length} added</span>
            <span className="text-rose-600 dark:text-rose-400">-{diff.schema.removed.length + diff.removedRows.length} removed</span>
            <span className="text-amber-600 dark:text-amber-400">~{diff.schema.changed.length + diff.changedRows.length} changed</span>
            {diff.truncated && (
              <Badge variant="outline" className="border-border bg-muted px-1 text-[10px] text-muted-foreground">
                first 100 per list
              </Badge>
            )}
          </div>

          {/* Schema chips */}
          {(diff.schema.added.length > 0 || diff.schema.removed.length > 0 || diff.schema.changed.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {diff.schema.added.map((c) => (
                <span key={`a-${c.name}`} className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
                  + {c.name}:{c.type}
                </span>
              ))}
              {diff.schema.removed.map((c) => (
                <span key={`r-${c.name}`} className="rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[11px] text-rose-600 dark:text-rose-400">
                  − {c.name}:{c.type}
                </span>
              ))}
              {diff.schema.changed.map((c) => (
                <span key={`c-${c.name}`} className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] text-amber-600 dark:text-amber-400">
                  ~ {c.name}:{c.fromType}→{c.toType}
                </span>
              ))}
            </div>
          )}

          {/* Row diff collapsibles */}
          <div className="space-y-2">
            <RowDiffSection
              title={`Added rows (+${diff.addedRows.length})`}
              tone="emerald"
              defaultOpen={diff.addedRows.length > 0 && diff.addedRows.length <= 25}
            >
              <DiffTable rows={diff.addedRows} emptyText="No rows added." />
            </RowDiffSection>
            <RowDiffSection
              title={`Removed rows (−${diff.removedRows.length})`}
              tone="rose"
              defaultOpen={false}
            >
              <DiffTable rows={diff.removedRows} emptyText="No rows removed." />
            </RowDiffSection>
            <RowDiffSection
              title={`Changed rows (~${diff.changedRows.length})`}
              tone="amber"
              defaultOpen={false}
            >
              {diff.changedRows.length === 0 ? (
                <p className="px-4 py-3 text-[11px] text-muted-foreground">No rows changed.</p>
              ) : (
                <div className="foundry-scroll max-h-72 overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-card">
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="h-7 px-3 font-mono text-[11px] text-muted-foreground">key</TableHead>
                        <TableHead className="h-7 px-3 font-mono text-[11px] text-muted-foreground">before</TableHead>
                        <TableHead className="h-7 px-3 font-mono text-[11px] text-muted-foreground">after</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {diff.changedRows.map((row, i) => (
                        <TableRow key={i} className="border-border align-top hover:bg-accent/40">
                          <TableCell className="max-w-32 truncate px-3 py-1 font-mono text-[13px] text-foreground">{row.key}</TableCell>
                          <TableCell className="max-w-72 truncate px-3 py-1 font-mono text-[13px] text-rose-600 dark:text-rose-400" title={JSON.stringify(row.before)}>
                            {JSON.stringify(row.before)}
                          </TableCell>
                          <TableCell className="max-w-72 truncate px-3 py-1 font-mono text-[13px] text-emerald-600 dark:text-emerald-400" title={JSON.stringify(row.after)}>
                            {JSON.stringify(row.after)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </RowDiffSection>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

function RowDiffSection({
  title,
  tone,
  defaultOpen,
  children,
}: {
  title: string
  tone: 'emerald' | 'rose' | 'amber'
  defaultOpen: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-left text-xs font-medium transition-colors hover:bg-accent/40',
          tone === 'emerald' && 'text-emerald-700 dark:text-emerald-400',
          tone === 'rose' && 'text-rose-700 dark:text-rose-400',
          tone === 'amber' && 'text-amber-700 dark:text-amber-400',
        )}
      >
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 rounded-md border border-border">{children}</CollapsibleContent>
    </Collapsible>
  )
}
