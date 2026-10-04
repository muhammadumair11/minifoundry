// GET/POST /api/datasets/[id]/quality — R14 data quality rules.
// GET: rules + latest result per rule + lastEvaluatedAt (any role).
// POST: create a rule (editor+; column required except freshness/row_count_min).

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonError, jsonOk, parseJsonSafe, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import { QUALITY_KINDS, kindRequiresColumn } from '@/lib/quality'
import type { DatasetQualityResponse, QualityResultInfo, QualityRuleInfo } from '@/lib/foundry-types'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  kind: z.enum(['not_null', 'unique', 'range', 'allowed_values', 'regex', 'freshness', 'row_count_min']),
  column: z.string().trim().min(1).nullish(),
  config: z.record(z.string(), z.unknown()).default({}),
  severity: z.enum(['warn', 'error']).default('warn'),
  enabled: z.boolean().default(true),
})

function serializeRule(r: {
  id: string
  datasetId: string
  name: string
  kind: string
  column: string | null
  configJson: string
  severity: string
  enabled: boolean
  createdAt: Date
}): QualityRuleInfo {
  return {
    id: r.id,
    datasetId: r.datasetId,
    name: r.name,
    kind: r.kind as QualityRuleInfo['kind'],
    column: r.column,
    config: parseJsonSafe<Record<string, unknown>>(r.configJson, {}),
    severity: r.severity as QualityRuleInfo['severity'],
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
  }
}

function serializeResult(
  res: {
    id: string
    ruleId: string
    datasetId: string
    versionNumber: number
    passed: boolean
    actual: string | null
    message: string | null
    trigger: string
    createdAt: Date
  } | null,
): QualityResultInfo | null {
  if (!res) return null
  return {
    id: res.id,
    ruleId: res.ruleId,
    datasetId: res.datasetId,
    versionNumber: res.versionNumber,
    passed: res.passed,
    actual: res.actual,
    message: res.message,
    trigger: res.trigger,
    createdAt: res.createdAt.toISOString(),
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true } })
    if (!dataset) return jsonError(404, `Dataset '${id}' not found`)

    const [rules, latest] = await Promise.all([
      db.qualityRule.findMany({ where: { datasetId: id }, orderBy: { createdAt: 'asc' } }),
      db.qualityResult.findFirst({
        where: { datasetId: id },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    const withResults = await Promise.all(
      rules.map(async (rule) => {
        const lastResult = await db.qualityResult.findFirst({
          where: { ruleId: rule.id },
          orderBy: { createdAt: 'desc' },
        })
        return { ...serializeRule(rule), lastResult: serializeResult(lastResult) }
      }),
    )

    const response: DatasetQualityResponse = {
      rules: withResults,
      lastEvaluatedAt: latest ? latest.createdAt.toISOString() : null,
    }
    return jsonOk(response)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load quality rules')
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const { id } = await params
    const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!dataset) return jsonError(404, `Dataset '${id}' not found`)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))
    const data = parsed.data

    if (kindRequiresColumn(data.kind) && !data.column) {
      return badRequest(`kind '${data.kind}' requires a column`)
    }

    const rule = await db.qualityRule.create({
      data: {
        datasetId: id,
        name: data.name,
        kind: data.kind,
        column: data.column ?? null,
        configJson: JSON.stringify(data.config ?? {}),
        severity: data.severity,
        enabled: data.enabled,
      },
    })

    audit({
      req,
      action: 'dataset.quality.rule_create',
      resourceType: 'dataset',
      resourceId: id,
      resourceName: dataset.name,
      detail: `rule='${rule.name}' kind=${rule.kind} column=${rule.column ?? '-'} severity=${rule.severity}`,
    })

    return jsonOk(serializeRule(rule), 201)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create quality rule')
  }
}
