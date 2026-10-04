'use client'

import { Suspense, useEffect } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Boxes, Compass, Network, Zap } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { apiJson } from '@/lib/foundry-api'
import type { OntologyObjectType, OntologyListResponse } from '@/lib/foundry-types'
import { getObjectColorClasses, OntologyIcon } from '@/components/foundry/ontology/icon-map'

function ObjectsLanding() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const typeParam = searchParams.get('type')

  const ontologyQuery = useQuery<OntologyListResponse>({
    queryKey: ['ontology'],
    queryFn: () => apiJson<OntologyListResponse>('/api/ontology'),
  })
  const types = ontologyQuery.data?.objectTypes ?? []

  // ?type={apiName} → canonical /objects/{type} (action + pk pass through).
  useEffect(() => {
    if (!typeParam) return
    const qs = new URLSearchParams()
    const action = searchParams.get('action')
    const pk = searchParams.get('pk')
    if (action) qs.set('action', action)
    if (pk) qs.set('pk', pk)
    const suffix = qs.toString()
    router.replace(`/objects/${encodeURIComponent(typeParam)}${suffix ? `?${suffix}` : ''}`)
  }, [typeParam, router, searchParams])

  if (typeParam) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="flex items-center gap-2 font-mono text-sm text-muted-foreground">
          <Compass className="h-4 w-4 animate-pulse text-muted-foreground" aria-hidden />
          redirecting to /objects/{typeParam}…
        </div>
      </div>
    )
  }

  const loading = ontologyQuery.isLoading

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      {/* Header (compact Foundry pattern) */}
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <Compass className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-sm font-medium tracking-tight text-foreground">Objects</h1>
        <span className="text-xs text-muted-foreground">
          browse live objects · follow links · run write-back actions
        </span>
      </header>

      {/* Type picker */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      ) : ontologyQuery.isError ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-rose-600 dark:text-rose-400">
            {ontologyQuery.error instanceof Error
              ? ontologyQuery.error.message
              : 'Failed to load the ontology.'}
          </CardContent>
        </Card>
      ) : types.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <Boxes className="h-8 w-8 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-base font-medium text-foreground">No object types to explore</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                The ontology is empty. Create object types from your datasets first — then their
                objects show up here.
              </p>
            </div>
            <Link
              href="/ontology"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Network className="h-4 w-4" aria-hidden />
              Go to Ontology
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {types.map((t) => (
            <TypePickerCard key={t.id} type={t} />
          ))}
        </div>
      )}
    </div>
  )
}

function TypePickerCard({ type }: { type: OntologyObjectType }) {
  const color = getObjectColorClasses(type.color)
  const titleProp = type.properties.find((p) => p.isTitle)
  const previewProps = [titleProp, ...type.properties.filter((p) => !p.isTitle)]
    .filter((p): p is NonNullable<typeof p> => !!p)
    .slice(0, 3)

  return (
    <Link
      href={`/objects/${encodeURIComponent(type.apiName)}`}
      className="group flex flex-col rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent/50"
      aria-label={`Explore ${type.displayName} objects`}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border',
            color.border,
            color.bg,
          )}
        >
          <OntologyIcon name={type.icon} className={cn('h-5 w-5', color.text)} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{type.displayName}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{type.apiName}</p>
        </div>
        <ArrowRight
          className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
          aria-hidden
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {type.objectCount ?? '—'} objects
        </span>
        <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {type.linksOut.length + type.linksIn.length} links
        </span>
        {type.actions.filter((a) => a.enabled).length > 0 && (
          <span className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-600 dark:text-emerald-400">
            <Zap className="h-2.5 w-2.5" aria-hidden />
            {type.actions.filter((a) => a.enabled).length} actions
          </span>
        )}
      </div>

      <ul className="mt-3 space-y-1 border-t border-border pt-2.5">
        {previewProps.map((p) => (
          <li key={p.apiName} className="truncate font-mono text-[11px]">
            <span className={cn(p.isTitle ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
              {p.displayName}
            </span>
            <span className="ml-1.5 text-muted-foreground/70">{p.dataType}</span>
          </li>
        ))}
      </ul>
    </Link>
  )
}

export default function ObjectsPage() {
  return (
    <Suspense fallback={null}>
      <ObjectsLanding />
    </Suspense>
  )
}
