// Shared helpers for the /api/applications routes — serializer + AppConfig
// zod schema. Plain module (Next.js route files may only export HTTP methods).

import { z } from 'zod'
import { parseJsonSafe } from '@/lib/api-utils'
import type { Application } from '@prisma/client'
import type { AppConfig, ApplicationInfo } from '@/lib/foundry-types'

const spanSchema = z.union([z.literal(1), z.literal(2), z.literal(3)])

const mapLayerSchema = z.object({
  id: z.string().min(1),
  objectTypeApiName: z.string().min(1).max(200),
  visible: z.boolean().default(true),
  latProperty: z.string().max(200).nullish(),
  lngProperty: z.string().max(200).nullish(),
  fallbackProperty: z.string().max(200).nullish(),
  colorBy: z.string().max(200).nullish(),
  sizeBy: z.string().max(200).nullish(),
})

const mapWidgetSchema = z.object({
  id: z.string().min(1),
  type: z.literal('map'),
  title: z.string().min(1).max(200),
  layers: z.array(mapLayerSchema).max(8),
  mapMode: z.enum(['markers', 'cluster', 'heatmap']).default('markers'),
  span: spanSchema.default(2),
})

const tableWidgetSchema = z.object({
  id: z.string().min(1),
  type: z.literal('objectTable'),
  title: z.string().min(1).max(200),
  objectTypeApiName: z.string().min(1).max(200),
  columns: z.array(z.string().max(200)).max(30).nullish(),
  span: spanSchema.default(2),
})

const statWidgetSchema = z.object({
  id: z.string().min(1),
  type: z.literal('stat'),
  title: z.string().min(1).max(200),
  objectTypeApiName: z.string().min(1).max(200),
  agg: z.enum(['count', 'sum', 'avg', 'min', 'max']).default('count'),
  valueProperty: z.string().max(200).nullish(),
  span: spanSchema.default(1),
})

const actionWidgetSchema = z.object({
  id: z.string().min(1),
  type: z.literal('actionButton'),
  title: z.string().min(1).max(200),
  actionApiName: z.string().min(1).max(200),
  useSelection: z.boolean().default(false),
  span: spanSchema.default(1),
})

export const appWidgetSchema = z.discriminatedUnion('type', [
  mapWidgetSchema,
  tableWidgetSchema,
  statWidgetSchema,
  actionWidgetSchema,
])

export const appFilterSchema = z.object({
  id: z.string().min(1),
  objectTypeApiName: z.string().min(1).max(200),
  property: z.string().min(1).max(200),
  op: z.enum(['eq', 'neq', 'contains', 'gt', 'lt', 'gte', 'lte']),
  kind: z.enum(['text', 'number', 'select']).default('text'),
  options: z.array(z.string().max(200)).max(50).default([]),
  label: z
    .string()
    .max(200)
    .nullish()
    .transform((v) => v ?? null),
})

export const appConfigSchema = z.object({
  widgets: z.array(appWidgetSchema).max(24).default([]),
  filters: z.array(appFilterSchema).max(8).default([]),
})

/** Application row → ApplicationInfo (configJson string → AppConfig). */
export function serializeApplication(a: Application): ApplicationInfo {
  const config = parseJsonSafe<AppConfig>(a.configJson, { widgets: [], filters: [] })
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    config: {
      widgets: config.widgets ?? [],
      filters: config.filters ?? [],
    },
    createdBy: a.createdBy,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }
}

/** Distinct object type apiNames an app references (summary cards / search). */
export function referencedObjectTypes(config: AppConfig): string[] {
  const names = new Set<string>()
  for (const w of config.widgets) {
    if (w.type === 'map') for (const l of w.layers) names.add(l.objectTypeApiName)
    else if (w.type !== 'actionButton') names.add(w.objectTypeApiName)
  }
  for (const f of config.filters) {
    if (f.objectTypeApiName !== '*') names.add(f.objectTypeApiName)
  }
  return [...names].sort()
}
