'use client'

// Shared data plumbing for Application widgets: global-filter resolution and
// an object-list query keyed compatibly with the platform's invalidation
// conventions (['objects', …] / ['object', …]), so applying an Ontology
// action anywhere refreshes every app widget automatically.

import { useQuery } from '@tanstack/react-query'
import { apiJson } from '@/lib/foundry-api'
import type {
  AppFilterDef,
  AppFilterOp,
  ObjectsListResponse,
} from '@/lib/foundry-types'

/** One active filter as accepted by GET /api/objects?filters=[…]. */
export interface ActiveFilter {
  property: string
  op: AppFilterOp
  value: string
}

/**
 * Resolve the app's filter definitions + runtime values into the concrete
 * filter list for one object type. Definitions scoped to '*' apply to any
 * type that actually has the property (checked against the type's schema).
 */
export function filtersForType(
  defs: AppFilterDef[],
  values: Record<string, string>,
  typeApiName: string,
  properties: { apiName: string }[] | undefined,
): ActiveFilter[] {
  const out: ActiveFilter[] = []
  for (const def of defs) {
    const value = (values[def.id] ?? '').trim()
    if (value === '') continue
    const applies =
      def.objectTypeApiName === typeApiName ||
      (def.objectTypeApiName === '*' && (properties ?? []).some((p) => p.apiName === def.property))
    if (applies) out.push({ property: def.property, op: def.op, value })
  }
  return out
}

/**
 * Object rows for an app widget. Query keys start with 'objects' so the
 * ActionDialog's invalidateQueries({ queryKey: ['objects'] }) covers apps.
 */
export function useAppObjects(
  typeApiName: string | null,
  filters: ActiveFilter[],
  page = 1,
  pageSize = 200,
) {
  const filtersJson = JSON.stringify(filters)
  return useQuery<ObjectsListResponse>({
    queryKey: ['objects', 'app', typeApiName, filtersJson, page, pageSize],
    queryFn: () =>
      apiJson<ObjectsListResponse>(
        `/api/objects?type=${encodeURIComponent(typeApiName ?? '')}&page=${page}&pageSize=${pageSize}&filters=${encodeURIComponent(filtersJson)}`,
      ),
    enabled: !!typeApiName,
    staleTime: 15_000,
  })
}

/** Format one object cell the way the object explorer does. */
export function formatObjectValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'number') return value.toLocaleString('en-US')
  if (typeof value === 'boolean') return String(value)
  return String(value)
}
