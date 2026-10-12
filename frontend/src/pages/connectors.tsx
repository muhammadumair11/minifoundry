'use client'

import { useRef, useState } from 'react'
import Link from '@/components/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, formatDistanceToNow, parseISO } from 'date-fns'
import { toast } from 'sonner'
import {
  Boxes,
  FileJson,
  FileSpreadsheet,
  Globe,
  Info,
  Loader2,
  PackageOpen,
  Upload,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EditorButton } from '@/components/foundry/editor-button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StatusBadge } from '@/components/foundry/status-badge'
import { RestConnectorsCard } from '@/components/foundry/connector-rest-card'
import type {
  IngestionsListResponse,
  IngestResponse,
  IngestionSummary,
} from '@/lib/foundry-types'

const SAMPLE_PACKS = [
  { key: 'suppliers', name: 'Suppliers', description: '12 rows · ratings & lead times' },
  { key: 'warehouses', name: 'Warehouses', description: '6 rows · locations & capacity' },
  { key: 'shipments', name: 'Shipments', description: '60 rows · statuses & ETAs' },
  { key: 'inventory', name: 'Inventory', description: '40 rows · stock & reorder points' },
] as const

type IngestRequest =
  | { type: 'raw'; datasetName: string; raw: string }
  | { type: 'sample'; datasetName: string; sampleKey: string }

function nameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '')
  return base.length > 0 ? base : 'Uploaded dataset'
}

export default function ConnectorsPage() {
  const queryClient = useQueryClient()
  const csvInputRef = useRef<HTMLInputElement>(null)
  const jsonInputRef = useRef<HTMLInputElement>(null)
  const [pendingFile, setPendingFile] = useState<string | null>(null)

  const ingestMutation = useMutation({
    mutationFn: async (body: IngestRequest): Promise<IngestResponse> => {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(errBody?.error ?? 'Ingestion failed')
      }
      return res.json()
    },
    onSuccess: (res) => {
      const rows = res.ingestion.rowsIngested ?? res.dataset.version.rowCount
      toast.success(`Ingested ${rows} rows into “${res.dataset.name}”`, {
        description: `New dataset version v${res.dataset.version.versionNumber} created.`,
      })
      queryClient.invalidateQueries()
    },
    onError: (err: Error) => toast.error('Ingestion failed', { description: err.message }),
  })

  const ingestionsQuery = useQuery<IngestionsListResponse>({
    queryKey: ['ingestions'],
    queryFn: async () => {
      const res = await fetch('/api/ingestions')
      if (!res.ok) throw new Error('Failed to load ingestions')
      return res.json()
    },
  })

  const handleFile = async (file: File, type: 'csv_upload' | 'json_upload') => {
    setPendingFile(type)
    let raw: string
    try {
      raw = await file.text()
    } catch {
      toast.error('Could not read the selected file')
      setPendingFile(null)
      return
    }
    try {
      await ingestMutation.mutateAsync({ type: 'raw', datasetName: nameFromFileName(file.name), raw })
    } catch {
      // The mutation's onError handler displays the ingestion error.
    } finally {
      setPendingFile(null)
    }
  }

  const ingestions: IngestionSummary[] = ingestionsQuery.data?.ingestions ?? []

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* Header (compact Foundry pattern) */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Globe className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-sm font-medium tracking-tight text-foreground">Data Connectors</h1>
        <span className="text-xs text-muted-foreground">
          every ingestion lands as a versioned dataset in the catalog
        </span>
        <Button asChild variant="outline" size="sm" className="ml-auto h-8 text-xs">
          <Link href="/data-sources">Find data sources</Link>
        </Button>
      </div>

      {/* Connector cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-foreground">
              <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted/50">
                <FileSpreadsheet className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              </span>
              CSV File
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              Upload a comma-separated file. The first row is treated as the header; column types
              are inferred automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              aria-label="Choose a CSV file to ingest"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleFile(file, 'csv_upload')
                e.target.value = ''
              }}
            />
            <EditorButton
              onClick={() => csvInputRef.current?.click()}
              disabled={ingestMutation.isPending || pendingFile !== null}
              variant="outline"
              className="w-full"
            >
              {pendingFile === 'csv_upload' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Upload className="h-4 w-4" aria-hidden />
              )}
              Choose CSV file…
            </EditorButton>
          </CardContent>
        </Card>

        {/* JSON upload */}
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-foreground">
              <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted/50">
                <FileJson className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              </span>
              JSON File
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              Upload a JSON document containing an array of objects (top-level or under a common
              key like <span className="font-mono">rows</span>).
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <input
              ref={jsonInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-label="Choose a JSON file to ingest"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleFile(file, 'json_upload')
                e.target.value = ''
              }}
            />
            <EditorButton
              onClick={() => jsonInputRef.current?.click()}
              disabled={ingestMutation.isPending || pendingFile !== null}
              variant="outline"
              className="w-full"
            >
              {pendingFile === 'json_upload' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Upload className="h-4 w-4" aria-hidden />
              )}
              Choose JSON file…
            </EditorButton>
          </CardContent>
        </Card>

        {/* REST URL */}
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-foreground">
              <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted/50">
                <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              </span>
              REST URL
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              Real HTTP fetch (10s timeout, 2 MB cap) — managed connectors live in the
              REST Connectors card below.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <Button
              variant="outline"
              className="w-full"
              onClick={() =>
                document.getElementById('rest-connectors')?.scrollIntoView({ behavior: 'smooth' })
              }
            >
              <Globe className="h-4 w-4" aria-hidden />
              Manage REST connectors
            </Button>
          </CardContent>
        </Card>

        {/* Sample packs */}
        <Card>
          <CardHeader className="p-4 pb-2">
            <span id="sample-packs" className="sr-only">
              Sample packs
            </span>
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-foreground">
              <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted/50">
                <PackageOpen className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              </span>
              Sample Packs
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              One-click supply-chain datasets for exploring the platform.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-2 p-4 pt-2 sm:grid-cols-2">
            {SAMPLE_PACKS.map((pack) => (
              <EditorButton
                key={pack.key}
                variant="outline"
                size="sm"
                disabled={ingestMutation.isPending}
                onClick={() =>
                  ingestMutation.mutate({
                    type: 'sample',
                    datasetName: pack.name,
                    sampleKey: pack.key,
                  })
                }
                className="h-auto min-h-[44px] flex-col items-start gap-0.5 px-3 py-2"
              >
                <span className="text-sm font-medium">{pack.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{pack.description}</span>
              </EditorButton>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* REST connectors (R14 14-b): real HTTP/CSV ingestion with test-connection dry-run */}
      <div id="rest-connectors" className="mt-4">
        <RestConnectorsCard />
      </div>

      {/* Info callout */}
      <div className="mt-4 flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-xs leading-5 text-muted-foreground">
          <span className="font-semibold text-foreground">M1 · M2 concept:</span> each ingestion
          creates a <span className="font-semibold text-foreground">new immutable dataset version</span>. Re-ingest
          the same dataset name and MiniFoundry appends v2, v3, … — history is preserved and
          pipeline runs always read a pinned version.
        </p>
      </div>

      {/* Ingestion history */}
      <Card className="mt-4">
        <CardHeader className="flex-row items-center justify-between border-b border-border p-4">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Boxes className="h-4 w-4 text-muted-foreground" aria-hidden />
            Ingestion History
          </CardTitle>
          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
            last 50
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          {ingestionsQuery.isLoading ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : ingestions.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No ingestions yet. Load a sample pack or upload a file above.
            </div>
          ) : (
            <div className="foundry-scroll max-h-96 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border bg-muted/40 hover:bg-transparent">
                    <TableHead className="h-9 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Connector</TableHead>
                    <TableHead className="h-9 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Dataset</TableHead>
                    <TableHead className="h-9 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Status</TableHead>
                    <TableHead className="h-9 px-4 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Rows</TableHead>
                    <TableHead className="h-9 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Finished</TableHead>
                    <TableHead className="h-9 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ingestions.map((ing) => (
                    <TableRow key={ing.id} className="border-border">
                      <TableCell className="px-4 py-2 text-[13px] text-foreground">
                        {ing.connectorName ?? '—'}
                      </TableCell>
                      <TableCell className="px-4 py-2 font-mono text-xs text-muted-foreground">
                        {ing.datasetName ?? '—'}
                      </TableCell>
                      <TableCell className="px-4 py-2">
                        <StatusBadge status={ing.status} />
                      </TableCell>
                      <TableCell className="px-4 py-2 text-right font-mono text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
                        {ing.rowsIngested.toLocaleString()}
                      </TableCell>
                      <TableCell
                        className="whitespace-nowrap px-4 py-2 font-mono text-xs text-muted-foreground"
                        title={ing.finishedAt ? format(parseISO(ing.finishedAt), 'MMM d, HH:mm:ss') : undefined}
                      >
                        {ing.finishedAt
                          ? formatDistanceToNow(parseISO(ing.finishedAt), { addSuffix: true })
                          : '—'}
                      </TableCell>
                      <TableCell
                        className="max-w-[220px] truncate px-4 py-2 text-xs text-muted-foreground"
                        title={ing.message ?? undefined}
                      >
                        {ing.message ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
