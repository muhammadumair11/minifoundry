'use client'

// Applications catalog — Workshop-style operational apps over the Ontology.
// Cards link into the app canvas (/applications/[id]); creation offers a blank
// app or the ready-made "Supply chain operations" template (map + shipments
// table + status action + global filters) resolved server-side by apiName.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Boxes, LayoutDashboard, LayoutTemplate, Loader2, Map as MapIcon, Plus, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { GatedButton } from '@/components/foundry/governance/gated-button'
import { apiJson, apiSend, toastApiError } from '@/lib/foundry-api'
import { formatRelative } from '@/lib/foundry-types'
import type {
  ApplicationInfo,
  ApplicationsListResponse,
  ApplicationTemplate,
  DashboardListResponse,
  SessionResponse,
} from '@/lib/foundry-types'

const canEditRole = (role: SessionResponse['role'] | undefined) => role === 'editor' || role === 'admin'

export default function ApplicationsPage() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const sessionQuery = useQuery<SessionResponse>({
    queryKey: ['session'],
    queryFn: () => apiJson<SessionResponse>('/api/session'),
    staleTime: 30_000,
  })
  const canEdit = canEditRole(sessionQuery.data?.role)

  const { data, isLoading, isError } = useQuery<ApplicationsListResponse>({
    queryKey: ['applications'],
    queryFn: () => apiJson<ApplicationsListResponse>('/api/applications'),
  })
  const applications = data?.applications ?? []
  const legacyQuery = useQuery<DashboardListResponse>({
    queryKey: ['dashboards'],
    queryFn: () => apiJson<DashboardListResponse>('/api/dashboards'),
  })
  const legacyDashboards = legacyQuery.data?.dashboards ?? []

  const makeCreate = (template: ApplicationTemplate) => async () => {
    const res = await apiSend<{ application: ApplicationInfo }>('/api/applications', 'POST', { template })
    return res.application
  }
  const onCreateSuccess = (application: ApplicationInfo) => {
    toast.success('Application created', { description: application.name })
    queryClient.invalidateQueries({ queryKey: ['applications'] })
    router.push(`/applications/${application.id}`)
  }
  const blankMutation = useMutation({
    mutationFn: makeCreate('blank'),
    onSuccess: onCreateSuccess,
    onError: (err: Error) => toastApiError(err, 'Could not create application'),
  })
  const sampleMutation = useMutation({
    mutationFn: makeCreate('supply-chain'),
    onSuccess: onCreateSuccess,
    onError: (err: Error) => toastApiError(err, 'Could not create sample application'),
  })
  const busy = blankMutation.isPending || sampleMutation.isPending

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* Header */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <LayoutTemplate className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className="truncate text-sm font-medium tracking-tight text-foreground">Applications</h1>
          {data && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {applications.length} {applications.length === 1 ? 'app' : 'apps'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <GatedButton allowed={canEdit} reason="requires editor role (current: viewer)" size="sm"
            variant="outline" onClick={() => sampleMutation.mutate()} disabled={busy}>
            {sampleMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
            Create sample
          </GatedButton>
          <GatedButton allowed={canEdit} reason="requires editor role (current: viewer)" size="sm"
            onClick={() => blankMutation.mutate()} disabled={busy}>
            {blankMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
            New application
          </GatedButton>
        </div>
      </div>

      <p className="mb-5 max-w-3xl text-xs leading-5 text-muted-foreground">
        Build a workspace for a task: organize pages and sections, add live Ontology maps, charts, tables and actions,
        then use filters or select an object to investigate and update it. Open an app and press Edit to change its layout.
      </p>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : isError ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
            <p className="text-sm font-medium text-foreground">Failed to load applications</p>
            <p className="text-xs text-muted-foreground">Try refreshing the page.</p>
          </CardContent>
        </Card>
      ) : applications.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <LayoutTemplate className="h-8 w-8 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium text-foreground">No applications yet</p>
              <p className="mx-auto mt-1 max-w-lg text-xs text-muted-foreground">
                Applications are operational tools built on the Ontology: live maps of your objects, tables,
                stats and write-back actions — wired together with global filters, no code required. Start from
                the supply-chain sample or a blank canvas.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                className="gap-1.5"
                onClick={() => sampleMutation.mutate()}
                disabled={busy}
              >
                {sampleMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="h-4 w-4" aria-hidden />
                )}
                Create sample app
              </Button>
              <GatedButton
                allowed={canEdit}
                reason="requires editor role (current: viewer)"
                size="sm"
                onClick={() => blankMutation.mutate()}
                disabled={busy}
              >
                <Plus className="h-4 w-4" aria-hidden />
                New application
              </GatedButton>
            </div>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
              <MapIcon className="h-3 w-3" aria-hidden />
              The sample needs the demo Ontology (Ontology → Seed demo) to show warehouses, suppliers and
              shipments on the map.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {applications.map((app) => (
            <Link
              key={app.id}
              href={`/applications/${app.id}`}
              className="group rounded-lg border border-border bg-card transition-colors hover:border-foreground/25"
              aria-label={`Open application ${app.name}`}
            >
              <CardContent className="flex h-full flex-col gap-3 p-4">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50">
                    <LayoutTemplate className="h-4 w-4 text-muted-foreground" aria-hidden />
                  </span>
                  <h2 className="truncate text-sm font-medium text-foreground">{app.name}</h2>
                </div>
                {app.description && (
                  <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{app.description}</p>
                )}
                {app.objectTypeApiNames.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <Boxes className="h-3 w-3 text-muted-foreground/70" aria-hidden />
                    {app.objectTypeApiNames.map((name) => (
                      <span
                        key={name}
                        className="rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
                  <span>
                    {app.widgetCount} {app.widgetCount === 1 ? 'widget' : 'widgets'}
                  </span>
                  <span>updated {formatRelative(app.updatedAt)}</span>
                </div>
              </CardContent>
            </Link>
          ))}
        </div>
      )}
      {legacyDashboards.length > 0 && (
        <section className="mt-8 border-t border-border pt-5" aria-label="Earlier dashboards">
          <div className="mb-3 flex items-center gap-2">
            <LayoutDashboard className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h2 className="text-xs font-medium text-foreground">Earlier dashboards</h2>
            <span className="text-[11px] text-muted-foreground">Saved before the Applications builder</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {legacyDashboards.map((dashboard) => (
              <Link key={dashboard.id} href={`/dashboards/${dashboard.id}`}
                className="rounded-md border border-border bg-card p-3 transition-colors hover:border-foreground/25">
                <span className="text-xs font-medium text-foreground">{dashboard.title}</span>
                <p className="mt-1 text-[11px] text-muted-foreground">{dashboard.widgetCount} widgets · updated {formatRelative(dashboard.updatedAt)}</p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
