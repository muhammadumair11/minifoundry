// Shared helpers for the /api/applications routes — serializer + AppConfig
// zod schema. Plain module (Next.js route files may only export HTTP methods).

import { z } from 'zod'
import { parseJsonSafe } from '@/lib/api-utils'
import type { Application } from '@prisma/client'
import type { AppConfig, AppPage, ApplicationInfo } from '@/lib/foundry-types'

export const DEFAULT_APP_PAGES: AppPage[] = [
  { id: 'overview', title: 'Overview', sections: [{ id: 'main', title: 'Main' }] },
]

const spanSchema = z.union([z.literal(1), z.literal(2), z.literal(3)])
const placementSchema = {
  pageId: z.string().min(1).max(100).optional(),
  sectionId: z.string().min(1).max(100).optional(),
}
const pageSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(100),
  sections: z.array(z.object({ id: z.string().min(1).max(100), title: z.string().min(1).max(100) })).min(1).max(20),
})

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
  ...placementSchema,
  id: z.string().min(1),
  type: z.literal('map'),
  title: z.string().min(1).max(200),
  layers: z.array(mapLayerSchema).max(8),
  mapMode: z.enum(['markers', 'cluster', 'heatmap']).default('markers'),
  span: spanSchema.default(2),
})

const tableWidgetSchema = z.object({
  ...placementSchema,
  id: z.string().min(1),
  type: z.literal('objectTable'),
  title: z.string().min(1).max(200),
  objectTypeApiName: z.string().min(1).max(200),
  columns: z.array(z.string().max(200)).max(30).nullish(),
  span: spanSchema.default(2),
})

const statWidgetSchema = z.object({
  ...placementSchema,
  id: z.string().min(1),
  type: z.literal('stat'),
  title: z.string().min(1).max(200),
  objectTypeApiName: z.string().min(1).max(200),
  agg: z.enum(['count', 'sum', 'avg', 'min', 'max']).default('count'),
  valueProperty: z.string().max(200).nullish(),
  span: spanSchema.default(1),
})

const actionWidgetSchema = z.object({
  ...placementSchema,
  id: z.string().min(1),
  type: z.literal('actionButton'),
  title: z.string().min(1).max(200),
  actionApiName: z.string().min(1).max(200),
  useSelection: z.boolean().default(false),
  span: spanSchema.default(1),
})

const chartWidgetSchema = z.object({
  ...placementSchema,
  id: z.string().min(1),
  type: z.literal('chart'),
  title: z.string().min(1).max(200),
  objectTypeApiName: z.string().min(1).max(200),
  chartType: z.enum(['bar', 'line', 'area', 'pie']),
  groupBy: z.string().min(1).max(200),
  agg: z.enum(['count', 'sum', 'avg', 'min', 'max']).default('count'),
  valueProperty: z.string().max(200).nullish(),
  topN: z.number().int().min(1).max(100).default(10),
  span: spanSchema.default(2),
})

export const appWidgetSchema = z.discriminatedUnion('type', [
  mapWidgetSchema,
  tableWidgetSchema,
  statWidgetSchema,
  actionWidgetSchema,
  chartWidgetSchema,
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
  pages: z.array(pageSchema).min(1).max(12).default(DEFAULT_APP_PAGES),
  widgets: z.array(appWidgetSchema).max(24).default([]),
  filters: z.array(appFilterSchema).max(8).default([]),
}).superRefine((config, ctx) => {
  const pageIds = new Set<string>()
  for (const page of config.pages) {
    if (pageIds.has(page.id)) ctx.addIssue({ code: 'custom', path: ['pages'], message: `Duplicate page id '${page.id}'` })
    pageIds.add(page.id)
    const sectionIds = new Set<string>()
    for (const section of page.sections) {
      if (sectionIds.has(section.id)) ctx.addIssue({ code: 'custom', path: ['pages'], message: `Duplicate section id '${section.id}'` })
      sectionIds.add(section.id)
    }
  }
  for (const [index, widget] of config.widgets.entries()) {
    if (!widget.pageId) continue // pre-pages widgets belong to the first page
    const page = config.pages.find((p) => p.id === widget.pageId)
    if (!page || (widget.sectionId && !page.sections.some((s) => s.id === widget.sectionId))) {
      ctx.addIssue({ code: 'custom', path: ['widgets', index], message: 'Widget placement refers to a missing page or section' })
    }
  }
})

/** Application row → ApplicationInfo (configJson string → AppConfig). */
export function serializeApplication(a: Application): ApplicationInfo {
  const config = parseJsonSafe<AppConfig>(a.configJson, { pages: DEFAULT_APP_PAGES, widgets: [], filters: [] })
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    config: {
      pages: config.pages?.length ? config.pages : DEFAULT_APP_PAGES,
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
    if (w.type === 'map') {
      for (const l of w.layers) names.add(l.objectTypeApiName)
    } else if (w.type !== 'actionButton') {
      names.add(w.objectTypeApiName)
    }
  }
  for (const f of config.filters) {
    if (f.objectTypeApiName !== '*') names.add(f.objectTypeApiName)
  }
  return [...names].sort()
}
