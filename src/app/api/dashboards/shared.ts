// Shared helpers for the /api/dashboards routes — serializer + widget zod schema.
// Kept in a plain module (not route.ts) because Next.js only permits HTTP-method
// exports in route files.

import { z } from 'zod'
import { parseJsonSafe } from '@/lib/api-utils'
import type { DashboardWidget } from '@/lib/foundry-types'
import type { Dashboard } from '@prisma/client'

export const widgetSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['bar', 'line', 'pie', 'area', 'stat', 'table']),
  title: z.string().min(1).max(200),
  datasetId: z.string().min(1),
  datasetName: z.string().max(200).optional(),
  config: z
    .object({
      groupBy: z.string().max(200).optional(),
      valueColumn: z.string().max(200).optional(),
      agg: z.enum(['count', 'sum', 'avg', 'min', 'max']).optional(),
      topN: z.number().int().min(1).max(100).optional(),
      sortDir: z.enum(['asc', 'desc']).optional(),
    })
    .default({}),
  span: z.union([z.literal(1), z.literal(2)]).optional(),
})

/** Dashboard row → DashboardInfo shape (layoutJson string → widgets array). */
export function serializeDashboard(d: Dashboard): {
  id: string
  title: string
  description: string | null
  widgets: DashboardWidget[]
  createdBy: string | null
  createdAt: string
  updatedAt: string
} {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    widgets: parseJsonSafe<DashboardWidget[]>(d.layoutJson, []),
    createdBy: d.createdBy,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  }
}
