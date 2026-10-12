'use client'

// Governance console — section (d): global audit trail (Task 4-c).
// Filters (resourceType select, exact-action text with datalist, fixed limit
// 100), dense mono table, 20s auto-refetch, max-h-96 scroll.

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import {
  Boxes,
  CalendarClock,
  ClipboardCheck,
  FolderKanban,
  GitBranch,
  KeyRound,
  ListChecks,
  Network,
  Plug,
  Search,
  SquareCode,
  Tag,
  UserRound,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { apiJson } from '@/lib/foundry-api'
import { formatRelative, type AuditListResponse, type AuditResourceType } from '@/lib/foundry-types'
import { RoleBadge } from '@/components/foundry/governance/role-badge'

const RESOURCE_TYPE_ICON: Record<string, LucideIcon> = {
  dataset: Boxes,
  pipeline: GitBranch,
  connector: Plug,
  marking: Tag,
  approval: ClipboardCheck,
  ontology: Network,
  schedule: CalendarClock,
  transform: SquareCode,
  project: FolderKanban,
  apiToken: KeyRound,
  user: UserRound,
}

const RESOURCE_TYPES: (AuditResourceType | 'all')[] = [
  'all',
  'dataset',
  'pipeline',
  'transform',
  'connector',
  'marking',
  'approval',
  'ontology',
  'schedule',
  'project',
  'apiToken',
  'user',
]

// Known action strings from the M9 backend — offered as datalist completions
// (the API's action filter is exact-match).
const KNOWN_ACTIONS = [
  'ingest.complete',
  'ingest.failed',
  'pipeline.create',
  'pipeline.update',
  'pipeline.delete',
  'pipeline.run',
  'action.apply',
  'dataset.delete',
  'dataset.tag',
  'dataset.prune',
  'dataset.update',
  'transform.create',
  'transform.update',
  'transform.delete',
  'transform.run',
  'project.create',
  'project.update',
  'project.delete',
  'marking.create',
  'marking.delete',
  'marking.attach',
  'marking.detach',
  'approval.request',
  'approval.decide',
  'schedule.create',
  'schedule.update',
  'schedule.delete',
  'ontology.create',
  'ontology.delete',
  'apiToken.create',
  'apiToken.revoke',
  // M9 real auth (7-b)
  'auth.login',
  'auth.logout',
  'user.update',
  'session.role_switch',
]

const LIMIT = 100
const REFETCH_MS = 20_000

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

export function AuditLogCard() {
  const [resourceType, setResourceType] = useState<AuditResourceType | 'all'>('all')
  const [actionInput, setActionInput] = useState('')
  const action = useDebouncedValue(actionInput.trim(), 350)

  const auditQuery = useQuery<AuditListResponse>({
    queryKey: ['audit', resourceType, action],
    queryFn: () => {
      const q = new URLSearchParams({ limit: String(LIMIT) })
      if (resourceType !== 'all') q.set('resourceType', resourceType)
      if (action) q.set('action', action)
      return apiJson<AuditListResponse>(`/api/audit?${q.toString()}`)
    },
    refetchInterval: REFETCH_MS,
    placeholderData: (prev) => prev,
  })

  const entries = auditQuery.data?.entries ?? []
  const hasFilter = resourceType !== 'all' || action !== ''

  return (
    <Card>
      <CardHeader className="gap-2 border-b border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ListChecks className="h-4 w-4 text-muted-foreground" aria-hidden />
            Audit Log
            {!auditQuery.isLoading && (
              <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
                {entries.length} / {LIMIT}
              </span>
            )}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={resourceType}
              onValueChange={(v) => setResourceType(v as AuditResourceType | 'all')}
            >
              <SelectTrigger
                aria-label="Filter by resource type"
                className="h-8 w-[140px] text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RESOURCE_TYPES.map((t) => (
                  <SelectItem key={t} value={t} className="font-mono text-xs">
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative w-full sm:w-56">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={actionInput}
                onChange={(e) => setActionInput(e.target.value)}
                placeholder="action, e.g. pipeline.run"
                aria-label="Filter by exact action"
                list="known-audit-actions"
                className="h-8 pl-8 pr-8 font-mono text-xs"
              />
              <datalist id="known-audit-actions">
                {KNOWN_ACTIONS.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
              {actionInput && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Clear action filter"
                  onClick={() => setActionInput('')}
                  className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="h-3 w-3" aria-hidden />
                </Button>
              )}
            </div>
          </div>
        </div>
        <CardDescription className="text-xs text-muted-foreground">
          Every mutation lands here with the acting role (scheduled runs act as{' '}
          <span className="font-mono text-foreground">system</span>). Auto-refreshes every 20s.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {auditQuery.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : auditQuery.isError ? (
          <p className="p-6 text-center text-sm text-rose-600 dark:text-rose-400">
            {auditQuery.error instanceof Error
              ? auditQuery.error.message
              : 'Failed to load audit entries.'}
          </p>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 p-8 text-center">
            <ListChecks className="h-6 w-6 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium text-foreground">
              {hasFilter ? 'No entries match the filters.' : 'No audit entries yet.'}
            </p>
            <p className="text-xs text-muted-foreground/80">
              {hasFilter
                ? 'Clear the filters to see the full trail.'
                : 'Actions like ingests, runs and decisions will appear here.'}
            </p>
          </div>
        ) : (
          <div className="foundry-scroll max-h-96 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="h-8 px-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    Time
                  </TableHead>
                  <TableHead className="h-8 px-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    Actor
                  </TableHead>
                  <TableHead className="h-8 px-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    Action
                  </TableHead>
                  <TableHead className="h-8 px-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    Resource
                  </TableHead>
                  <TableHead className="h-8 px-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    Detail
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => {
                  const ResourceIcon = RESOURCE_TYPE_ICON[e.resourceType] ?? ListChecks
                  return (
                    <TableRow key={e.id} className="border-border/70">
                      <TableCell className="whitespace-nowrap px-3 py-1.5">
                        <span
                          className="font-mono text-xs text-foreground"
                          title={format(parseISO(e.createdAt), 'MMM d, yyyy HH:mm:ss')}
                        >
                          {format(parseISO(e.createdAt), 'HH:mm:ss')}
                        </span>
                        <span className="ml-1.5 hidden font-mono text-[10px] text-muted-foreground/80 xl:inline">
                          {formatRelative(e.createdAt)}
                        </span>
                      </TableCell>
                      <TableCell className="px-3 py-1.5">
                        <span className="flex items-center gap-1.5">
                          <RoleBadge role={e.actorRole} />
                          {/* M9: real-session actors carry their email — mono
                              muted badge, e.g. admin · demo-admin@example.invalid */}
                          {e.actorEmail && (
                            <span
                              className="hidden max-w-52 items-center truncate rounded border border-border bg-muted px-1.5 py-0 font-mono text-[10px] leading-4 text-muted-foreground lg:inline-flex"
                              title={e.actorEmail}
                            >
                              {e.actorEmail}
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-foreground">
                        {e.action}
                      </TableCell>
                      <TableCell className="max-w-[220px] px-3 py-1.5">
                        <span className="flex items-center gap-1.5">
                          <ResourceIcon
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="truncate text-xs text-foreground">
                            {e.resourceName ?? e.resourceId ?? '—'}
                          </span>
                          <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground/80 lg:inline">
                            {e.resourceType}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[260px] px-3 py-1.5">
                        <span
                          className="block truncate font-mono text-[11px] text-muted-foreground"
                          title={e.detail ?? undefined}
                        >
                          {e.detail ?? '—'}
                        </span>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
