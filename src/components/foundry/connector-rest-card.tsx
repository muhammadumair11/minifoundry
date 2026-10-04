'use client'

// R14 (14-b) — REAL rest_url connectors card for the connectors page.
// Create/edit dialogs (URL + format + optional dataPath), a dry-run
// "Test connection" (POST /api/connectors/[id]/test, no version created),
// and "Ingest now" (POST /api/connectors/[id]/ingest → real fetch → dataset
// version). Shows each connector's last ingestion status/rows.

import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { toast } from 'sonner'
import {
  Globe,
  Loader2,
  Pencil,
  Play,
  PlugZap,
  Plus,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StatusBadge } from '@/components/foundry/status-badge'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import type { SessionResponse } from '@/lib/foundry-types'

// Local connector DTO (additive R14 shape; kept local — shared types file is
// owned by the orchestrator).
interface ConnectorDto {
  id: string
  name: string
  type: string
  config: { url?: string; format?: string; dataPath?: string; sampleKey?: string; description?: string }
  lastIngestion: { id: string; status: string; finishedAt: string | null; rowsIngested: number } | null
}
interface ConnectorsListResponse {
  connectors: ConnectorDto[]
}
interface TestConnectionResponse {
  ok: boolean
  rowCount?: number
  sampleColumns?: string[]
  durationMs?: number
  error?: string
}

interface ConnectorFormState {
  id: string | null // null = create
  name: string
  url: string
  format: 'json' | 'csv'
  dataPath: string
}

const EMPTY_FORM: ConnectorFormState = { id: null, name: '', url: '', format: 'json', dataPath: '' }

export function RestConnectorsCard() {
  const queryClient = useQueryClient()
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<ConnectorFormState>(EMPTY_FORM)
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null)
  const [testingForm, setTestingForm] = useState(false)
  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const canEdit = sessionQuery.data?.role === 'editor' || sessionQuery.data?.role === 'admin'

  const connectorsQuery = useQuery<ConnectorsListResponse>({
    queryKey: ['connectors'],
    queryFn: () => apiJson<ConnectorsListResponse>('/api/connectors'),
  })
  const restConnectors = (connectorsQuery.data?.connectors ?? []).filter(
    (c) => c.type === 'rest_url',
  )

  // Re-seed the form + clear the inline test result when the dialog OPENS
  // (openCreate/openEdit are event handlers — no setState-in-effect).

  const openCreate = () => {
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }
  const openEdit = (connector: ConnectorDto) => {
    setForm({
      id: connector.id,
      name: connector.name,
      url: connector.config.url ?? '',
      format: connector.config.format === 'csv' ? 'csv' : 'json',
      dataPath: connector.config.dataPath ?? '',
    })
    setFormOpen(true)
  }

  // Dry-run: fetch the payload without creating a version.
  const testConnection = async (connectorId?: string) => {
    setTestingForm(true)
    setTestResult(null)
    try {
      const res = connectorId
        ? await apiSend<TestConnectionResponse>(`/api/connectors/${connectorId}/test`, 'POST')
        : await apiSend<TestConnectionResponse>('/api/connectors/test-config', 'POST', {
            url: form.url.trim(),
            format: form.format,
            dataPath: form.dataPath.trim() || undefined,
          })
      setTestResult(res)
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Test failed' })
    } finally {
      setTestingForm(false)
    }
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name.trim(),
        config: {
          url: form.url.trim(),
          format: form.format,
          ...(form.dataPath.trim() ? { dataPath: form.dataPath.trim() } : {}),
        },
      }
      return form.id
        ? apiSend<{ connector: ConnectorDto }>(`/api/connectors/${form.id}`, 'PATCH', payload)
        : apiSend<{ connector: ConnectorDto }>('/api/connectors', 'POST', {
            ...payload,
            type: 'rest_url',
          })
    },
    onSuccess: (res) => {
      toast.success(form.id ? 'Connector updated' : 'Connector created', {
        description: res.connector?.name,
      })
      void queryClient.invalidateQueries({ queryKey: ['connectors'] })
      setFormOpen(false)
    },
    onError: (err) => toastApiError(err, form.id ? 'Update failed' : 'Create failed'),
  })

  const ingestMutation = useMutation({
    mutationFn: (connector: ConnectorDto) =>
      apiSend<{ dataset: { id: string; name: string; version: { versionNumber: number } } }>(
        `/api/connectors/${connector.id}/ingest`,
        'POST',
        {},
      ),
    onSuccess: (res) => {
      toast.success(`Ingested into “${res.dataset.name}”`, {
        description: `Dataset version v${res.dataset.version?.versionNumber ?? 1} created.`,
      })
      void queryClient.invalidateQueries({ queryKey: ['connectors'] })
      void queryClient.invalidateQueries({ queryKey: ['ingestions'] })
      void queryClient.invalidateQueries({ queryKey: ['datasets'] })
    },
    onError: (err) => toastApiError(err, 'Ingestion failed'),
  })

  const formValid = form.name.trim() !== '' && form.url.trim() !== ''

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 border-b border-border p-4">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-muted/50">
              <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            </span>
            REST Connectors
          </CardTitle>
          <CardDescription className="mt-1 text-xs text-muted-foreground">
            Real HTTP fetch (10s timeout, 2 MB cap) — JSON arrays or CSV text, ingested as versioned datasets.
          </CardDescription>
        </div>
        {canEdit && (
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New connector
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {connectorsQuery.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : restConnectors.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-6 text-center">
            <PlugZap className="h-6 w-6 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">
              {canEdit
                ? 'No REST connectors yet — create one to fetch from a live HTTP endpoint.'
                : 'No REST connectors yet.'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {restConnectors.map((connector) => (
              <li key={connector.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{connector.name}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground" title={connector.config.url}>
                    {connector.config.format === 'csv' ? 'csv' : 'json'}
                    {connector.config.dataPath ? ` · ${connector.config.dataPath}` : ''} · {connector.config.url ?? 'no url'}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {connector.lastIngestion ? (
                      <>
                        <StatusBadge status={connector.lastIngestion.status} />
                        <span className="font-mono">
                          {connector.lastIngestion.rowsIngested.toLocaleString()} rows
                        </span>
                        {connector.lastIngestion.finishedAt && (
                          <span>
                            · {formatDistanceToNow(parseISO(connector.lastIngestion.finishedAt), { addSuffix: true })}
                          </span>
                        )}
                      </>
                    ) : (
                      <span>never ingested</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {canEdit && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-xs"
                        disabled={testingForm}
                        onClick={() => void testConnection(connector.id)}
                        aria-label={`Test connection for ${connector.name}`}
                      >
                        {testingForm ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <PlugZap className="h-3.5 w-3.5" aria-hidden />
                        )}
                        Test
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-xs"
                        disabled={ingestMutation.isPending && ingestMutation.variables?.id === connector.id}
                        onClick={() => ingestMutation.mutate(connector)}
                        aria-label={`Ingest now from ${connector.name}`}
                      >
                        {ingestMutation.isPending && ingestMutation.variables?.id === connector.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <Play className="h-3.5 w-3.5" aria-hidden />
                        )}
                        Ingest now
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => openEdit(connector)}
                        aria-label={`Edit ${connector.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </>
                  )}
                  <Button asChild variant="ghost" size="sm" className="h-8 text-xs">
                    <Link href={`/datasets?search=${encodeURIComponent(connector.name)}`}>Datasets</Link>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Create/Edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base text-foreground">
              {form.id ? 'Edit REST connector' : 'New REST connector'}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              The endpoint must be reachable from the server. Test before ingesting — no dataset
              version is created by a test.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            <div className="grid gap-1.5">
              <Label htmlFor="rest-connector-name" className="text-xs text-muted-foreground">
                Connector / dataset name
              </Label>
              <Input
                id="rest-connector-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Live Users API"
                className="text-sm"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rest-connector-url" className="text-xs text-muted-foreground">
                URL
              </Label>
              <Input
                id="rest-connector-url"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                placeholder="https://api.example.com/users"
                className="font-mono text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="rest-connector-format" className="text-xs text-muted-foreground">
                  Format
                </Label>
                <Select
                  value={form.format}
                  onValueChange={(v) => setForm((f) => ({ ...f, format: v as 'json' | 'csv' }))}
                >
                  <SelectTrigger id="rest-connector-format" className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="json">JSON</SelectItem>
                    <SelectItem value="csv">CSV</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rest-connector-datapath" className="text-xs text-muted-foreground">
                  Data path (optional)
                </Label>
                <Input
                  id="rest-connector-datapath"
                  value={form.dataPath}
                  onChange={(e) => setForm((f) => ({ ...f, dataPath: e.target.value }))}
                  placeholder="data.items"
                  className="font-mono text-sm"
                />
              </div>
            </div>

            {/* Inline test result */}
            {testResult && (
              <div
                role="status"
                className={`rounded-md border p-2.5 text-xs ${
                  testResult.ok
                    ? 'border-emerald-600/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'border-rose-600/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
                }`}
              >
                {testResult.ok ? (
                  <>
                    <span className="font-medium">
                      ✓ {testResult.rowCount?.toLocaleString()} rows
                    </span>{' '}
                    <span className="font-mono text-[11px]">
                      ({(testResult.sampleColumns ?? []).slice(0, 6).join(', ')}
                      {(testResult.sampleColumns?.length ?? 0) > 6 ? ', …' : ''})
                    </span>{' '}
                    <span className="text-[11px] opacity-80">{testResult.durationMs}ms</span>
                  </>
                ) : (
                  <span className="font-medium">✗ {testResult.error ?? 'Connection failed'}</span>
                )}
              </div>
            )}
          </div>
          <DialogFooter className="flex-row flex-wrap items-center gap-2 sm:justify-between">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={!form.url.trim() || testingForm}
              onClick={() => void testConnection(undefined)}
            >
              {testingForm ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <PlugZap className="h-3.5 w-3.5" aria-hidden />
              )}
              Test connection
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="gap-1.5 text-xs"
                disabled={!formValid || saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                )}
                {form.id ? 'Save changes' : 'Create connector'}
              </Button>
            </div>
          </DialogFooter>
          {form.id && (
            <p className="text-[11px] text-muted-foreground">
              Saved changes apply to the next ingestion — use “Ingest now” on the connector row to
              create a new dataset version.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
