// Complete, governed aggregation for Application charts. Uses the same
// published Ontology rows and masking/filtering path as the object explorer.
import { z } from 'zod'
import { badRequest, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { getRole, maskedColumnsFor } from '@/lib/governance'
import { findObjectType, getObjectRows } from '@/lib/ontology-service'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const filterSchema = z.object({
  property: z.string().min(1).max(200),
  op: z.enum(['eq', 'neq', 'contains', 'gt', 'lt', 'gte', 'lte']),
  value: z.string().max(500),
})
const schema = z.object({
  objectTypeApiName: z.string().min(1).max(200),
  filters: z.array(filterSchema).max(8).default([]),
  groupBy: z.string().min(1).max(200),
  agg: z.enum(['count', 'sum', 'avg', 'min', 'max']).default('count'),
  valueProperty: z.string().max(200).nullish(),
  topN: z.number().int().min(1).max(100).default(10),
})

export async function POST(req: NextRequest) {
  try {
    let body: unknown
    try { body = await req.json() } catch { return badRequest('Request body must be valid JSON') }
    const parsed = schema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const { objectTypeApiName, filters, groupBy, agg, valueProperty, topN } = parsed.data
    const objectType = await findObjectType(objectTypeApiName)
    if (!objectType) return badRequest(`Object type '${objectTypeApiName}' not found`)
    const properties = new Set(objectType.properties.map((p) => p.apiName))
    if (!properties.has(groupBy)) return badRequest(`Property '${groupBy}' not found`)
    if (agg !== 'count' && (!valueProperty || !properties.has(valueProperty))) {
      return badRequest('Select a numeric value property for this aggregation')
    }
    if (filters.some((filter) => !properties.has(filter.property))) return badRequest('Filter property not found')

    const masked = objectType.sourceDatasetId
      ? await maskedColumnsFor(objectType.sourceDatasetId, getRole(req))
      : []
    if (masked.includes(groupBy) || (valueProperty && masked.includes(valueProperty)) ||
      filters.some((filter) => masked.includes(filter.property))) {
      return badRequest('This chart uses a property hidden for your role')
    }
    const result = await getObjectRows(objectType, { filters, maskColumns: masked, all: true })
    const groups = new Map<string, { count: number; values: number[] }>()
    for (const row of result.rows) {
      const raw = row.values[groupBy]
      const key = raw == null || raw === '' ? '(empty)' : String(raw)
      const group = groups.get(key) ?? { count: 0, values: [] }
      group.count++
      if (agg !== 'count' && valueProperty) {
        const value = row.values[valueProperty]
        if (typeof value === 'number' && Number.isFinite(value)) group.values.push(value)
        else if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) group.values.push(Number(value))
      }
      groups.set(key, group)
    }
    const rows = [...groups].map(([name, group]) => {
      const values = group.values
      const sum = values.reduce((total, value) => total + value, 0)
      const value = agg === 'count' ? group.count
        : agg === 'sum' ? sum
        : agg === 'avg' ? (values.length ? sum / values.length : 0)
        : agg === 'min' ? (values.length ? Math.min(...values) : 0)
        : (values.length ? Math.max(...values) : 0)
      return { name, value }
    }).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)).slice(0, topN)
    return jsonOk({ rows, total: result.total })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to aggregate chart')
  }
}
