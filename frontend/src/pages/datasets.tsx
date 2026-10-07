'use client'

// Data catalog (Task 5-b round) — now project-aware: `?project=<id>` URL
// param + filter Select (from the ['projects'] cache) and a Project column.

import { Suspense, useMemo, useState } from 'react'
import Link from '@/components/link'
import { useRouter, useSearchParams } from '@/lib/next-navigation'
import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { Boxes, FolderKanban, Plug, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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
import { apiJson } from '@/lib/foundry-api'
import type {
  DatasetsListResponse,
  ProjectsListResponse,
} from '@/lib/foundry-types'

function DatasetsCatalog() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const projectParam = searchParams.get('project')
  const [search, setSearch] = useState('')

  const { data, isLoading, isError, error } = useQuery<DatasetsListResponse>({
    queryKey: ['datasets'],
    queryFn: async () => {
      const res = await fetch('/api/datasets')
      if (!res.ok) throw new Error('Failed to load datasets')
      return res.json()
    },
  })

  const projectsQuery = useQuery<ProjectsListResponse>({
    queryKey: ['projects'],
    queryFn: () => apiJson<ProjectsListResponse>('/api/projects'),
  })
  const projectNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of projectsQuery.data?.projects ?? []) m.set(p.id, p.name)
    return m
  }, [projectsQuery.data])

  const setProjectFilter = (value: string) => {
    router.replace(value === 'all' ? '/datasets' : `/datasets?project=${value}`, {
      scroll: false,
    })
  }

  const datasets = useMemo(() => {
    const all = data?.datasets ?? []
    const q = search.trim().toLowerCase()
    return all.filter((d) => {
      if (projectParam && d.projectId !== projectParam) return false
      if (!q) return true
      return (
        d.name.toLowerCase().includes(q) ||
        (d.description ?? '').toLowerCase().includes(q) ||
        d.tags.some((t) => t.toLowerCase().includes(q))
      )
    })
  }, [data, search, projectParam])

  const activeProject = projectParam ? projectNameById.get(projectParam) : undefined

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* Header (compact Foundry pattern) */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className="text-sm font-medium tracking-tight text-foreground">Data Catalog</h1>
          {data && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {datasets.length} of {data.datasets.length} datasets
            </span>
          )}
          {activeProject && (
            <>
              <span className="font-mono text-[11px] text-foreground">project: {activeProject}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setProjectFilter('all')}
                className="ml-1 h-5 px-1.5 font-mono text-[10px] text-muted-foreground hover:text-foreground"
              >
                clear filter
              </Button>
            </>
          )}
        </div>
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center lg:w-auto">
          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search datasets…"
              aria-label="Search datasets"
              className="pl-8 text-sm"
            />
          </div>
          <Select
            value={projectParam ?? 'all'}
            onValueChange={setProjectFilter}
          >
            <SelectTrigger
              aria-label="Filter by project"
              className="w-full text-sm sm:w-48"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderKanban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <SelectValue placeholder="All projects" />
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                All projects
              </SelectItem>
              {(projectsQuery.data?.projects ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-xs">
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        {isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="p-6 text-center text-sm text-rose-600 dark:text-rose-400">
            Could not load datasets: {error instanceof Error ? error.message : 'unknown error'}
          </div>
        ) : datasets.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <Boxes className="h-8 w-8 text-muted-foreground" aria-hidden />
            {search.trim() || projectParam ? (
              <p className="text-sm text-muted-foreground">
                No datasets match the current filters.
              </p>
            ) : (
              <>
                <div>
                  <p className="text-sm font-medium text-foreground">The catalog is empty</p>
                  <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                    Datasets appear here after you ingest data through a connector or run a
                    pipeline.
                  </p>
                </div>
                <Button asChild size="sm">
                  <Link href="/connectors">
                    <Plug className="h-4 w-4" aria-hidden />
                    Go to connectors
                  </Link>
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="foundry-scroll overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border bg-muted/40 hover:bg-transparent">
                  <TableHead className="h-10 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Name</TableHead>
                  <TableHead className="h-10 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Project</TableHead>
                  <TableHead className="h-10 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Tags</TableHead>
                  <TableHead className="h-10 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Version</TableHead>
                  <TableHead className="h-10 px-4 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Rows</TableHead>
                  <TableHead className="h-10 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {datasets.map((ds) => {
                  const projectName = ds.projectId ? projectNameById.get(ds.projectId) : undefined
                  return (
                    <TableRow key={ds.id} className="border-border hover:bg-accent/50">
                      <TableCell className="max-w-[260px] px-4 py-2.5">
                        <Link
                          href={`/datasets/${ds.id}`}
                          className="block truncate text-[13px] font-medium text-foreground hover:underline underline-offset-2"
                        >
                          {ds.name}
                        </Link>
                        {ds.description && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {ds.description}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[160px] px-4 py-2.5">
                        {projectName ? (
                          <Link
                            href={`/datasets?project=${ds.projectId}`}
                            className="flex max-w-[160px] items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground"
                            title={`Filter by ${projectName}`}
                          >
                            <FolderKanban className="h-3 w-3 shrink-0" aria-hidden />
                            <span className="truncate">{projectName}</span>
                          </Link>
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground/80">—</span>
                        )}
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {ds.tags.length === 0 ? (
                            <span className="text-xs text-muted-foreground/80">—</span>
                          ) : (
                            ds.tags.map((tag) => (
                              <Badge
                                key={tag}
                                variant="outline"
                                className="bg-muted px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
                              >
                                {tag}
                              </Badge>
                            ))
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                        v{ds.currentVersion?.versionNumber ?? '—'}
                        <span className="text-muted-foreground/80"> / {ds.versionsCount}</span>
                      </TableCell>
                      <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-foreground">
                        {(ds.currentVersion?.rowCount ?? 0).toLocaleString()}
                      </TableCell>
                      <TableCell
                        className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted-foreground"
                        title={formatDistanceToNow(parseISO(ds.updatedAt), {
                          addSuffix: true,
                        })}
                      >
                        {formatDistanceToNow(parseISO(ds.updatedAt), { addSuffix: true })}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  )
}

export default function DatasetsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-8">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-[320px] w-full" />
        </div>
      }
    >
      <DatasetsCatalog />
    </Suspense>
  )
}
