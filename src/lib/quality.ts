// MiniFoundry — R14 data quality (expectations) engine.
//
// evaluateRules(datasetId, versionNumber, trigger) loads every ENABLED
// QualityRule of the dataset, evaluates it against the given version's rows
// and stores one QualityResult per rule. Rule severity 'error' failures
// additionally raise a platform notification (type 'quality_failed').
//
// Kinds & config shapes:
//   not_null        { }                      — col not null/''
//   unique          { }                      — no duplicate values in col
//   range           { min?, max? }           — numeric within [min,max]
//   allowed_values  { values: unknown[] }    — value must be in list
//   regex           { pattern: string }      — value must match pattern
//   freshness       { maxAgeMinutes }        — dataset.updatedAt age
//   row_count_min   { minRows }              — rows.length >= minRows

import { db } from '@/lib/db'
import { createNotification } from '@/lib/notify'
import type { EvaluateQualityResponse, QualityRuleKind } from '@/lib/foundry-types'
import { toNumber, type Row, type SchemaColumn } from '@/lib/dataset-service'
import { parseJsonSafe } from '@/lib/api-utils'
import type { QualityRule } from '@prisma/client'

interface RuleOutcome {
  passed: boolean
  actual: string | null
  message: string | null
}

const EMPTY = (v: unknown) => v === null || v === undefined || v === ''

function evaluateOne(
  rule: QualityRule,
  rows: Row[],
  columns: SchemaColumn[],
  datasetUpdatedAt: Date,
): RuleOutcome {
  const config = parseJsonSafe<Record<string, unknown>>(rule.configJson, {})
  const kind = rule.kind as QualityRuleKind
  const total = rows.length
  const n = (x: unknown, fallback: number | null = null): number | null => {
    const num = toNumber(x)
    return Number.isNaN(num) ? fallback : num
  }

  switch (kind) {
    case 'not_null': {
      const col = rule.column ?? ''
      const violations = rows.filter((r) => EMPTY(r[col])).length
      return {
        passed: violations === 0,
        actual: `${violations} violating row${violations === 1 ? '' : 's'}`,
        message:
          violations === 0
            ? `not_null ok on '${col}' across ${total} rows`
            : `${violations} of ${total} rows have null/empty '${col}'`,
      }
    }
    case 'unique': {
      const col = rule.column ?? ''
      const counts = new Map<string, number>()
      for (const r of rows) {
        const v = r[col]
        const key = v === null || v === undefined ? '∅null' : String(v)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      let violations = 0
      const dups: string[] = []
      for (const [key, count] of counts) {
        if (count > 1) {
          violations += count - 1
          if (dups.length < 3) dups.push(`'${key}'×${count}`)
        }
      }
      return {
        passed: violations === 0,
        actual: `${violations} duplicate value${violations === 1 ? '' : 's'}`,
        message:
          violations === 0
            ? `unique ok on '${col}' across ${total} rows`
            : `${violations} duplicate values in '${col}' (${dups.join(', ')}${dups.length === 3 ? '…' : ''})`,
      }
    }
    case 'range': {
      const col = rule.column ?? ''
      const min = n(config.min)
      const max = n(config.max)
      const violations = rows.filter((r) => {
        const v = toNumber(r[col])
        if (Number.isNaN(v)) return true
        if (min !== null && v < min) return true
        if (max !== null && v > max) return true
        return false
      }).length
      const bounds = min !== null && max !== null ? `[${min}, ${max}]` : min !== null ? `>= ${min}` : max !== null ? `<= ${max}` : '(unbounded)'
      return {
        passed: violations === 0,
        actual: `${violations} violating row${violations === 1 ? '' : 's'}`,
        message:
          violations === 0
            ? `range ok on '${col}' ${bounds} across ${total} rows`
            : `${violations} of ${total} rows outside range ${bounds} for '${col}'`,
      }
    }
    case 'allowed_values': {
      const col = rule.column ?? ''
      const allowed = new Set(
        Array.isArray(config.values) ? config.values.map((v) => String(v)) : [],
      )
      const violations = rows.filter((r) => {
        const v = r[col]
        if (v === null || v === undefined) return true
        return !allowed.has(String(v))
      }).length
      return {
        passed: violations === 0,
        actual: `${violations} violating row${violations === 1 ? '' : 's'}`,
        message:
          violations === 0
            ? `allowed_values ok on '${col}' (${allowed.size} values) across ${total} rows`
            : `${violations} of ${total} rows have values outside the allowed list for '${col}'`,
      }
    }
    case 'regex': {
      const col = rule.column ?? ''
      const pattern = typeof config.pattern === 'string' ? config.pattern : ''
      let re: RegExp
      try {
        re = new RegExp(pattern)
      } catch {
        return { passed: false, actual: 'invalid pattern', message: `Invalid regex pattern '${pattern}'` }
      }
      const violations = rows.filter((r) => {
        const v = r[col]
        return !re.test(v === null || v === undefined ? '' : String(v))
      }).length
      return {
        passed: violations === 0,
        actual: `${violations} violating row${violations === 1 ? '' : 's'}`,
        message:
          violations === 0
            ? `regex ok on '${col}' across ${total} rows`
            : `${violations} of ${total} rows don't match /${pattern}/ on '${col}'`,
      }
    }
    case 'freshness': {
      const maxAgeMinutes = n(config.maxAgeMinutes, 60) ?? 60
      const ageMinutes = (Date.now() - datasetUpdatedAt.getTime()) / 60_000
      const passed = ageMinutes <= maxAgeMinutes
      const actual = `${Math.round(ageMinutes)} min old`
      return {
        passed,
        actual,
        message: passed
          ? `dataset updated ${actual} (limit ${maxAgeMinutes} min)`
          : `dataset is ${actual}, older than the ${maxAgeMinutes} min limit`,
      }
    }
    case 'row_count_min': {
      const minRows = n(config.minRows, 1) ?? 1
      const passed = total >= minRows
      return {
        passed,
        actual: `${total} rows`,
        message: passed
          ? `${total} rows >= ${minRows} required`
          : `only ${total} rows, needs at least ${minRows}`,
      }
    }
    default:
      return { passed: false, actual: null, message: `Unknown rule kind '${rule.kind}'` }
  }
}

/**
 * Evaluate all enabled rules of a dataset against one version and persist a
 * QualityResult per rule. Never throws for rule-level issues — unknown kinds
 * produce failing results. Missing version/dataset throws (caller maps to 400).
 */
export async function evaluateRules(
  datasetId: string,
  versionNumber: number,
  trigger: 'manual' | 'post_run' | 'auto',
): Promise<EvaluateQualityResponse> {
  const [dataset, version, rules] = await Promise.all([
    db.dataset.findUnique({ where: { id: datasetId }, select: { id: true, name: true, updatedAt: true } }),
    db.datasetVersion.findUnique({
      where: { datasetId_versionNumber: { datasetId, versionNumber } },
      select: { versionNumber: true, schemaJson: true, dataJson: true, rowCount: true },
    }),
    db.qualityRule.findMany({ where: { datasetId, enabled: true }, orderBy: { createdAt: 'asc' } }),
  ])
  if (!dataset) throw new QualityError(`Dataset '${datasetId}' not found`, 404)
  if (!version) throw new QualityError(`Version ${versionNumber} not found`, 400)

  const rows = parseJsonSafe<Row[]>(version.dataJson, [])
  const columns = parseJsonSafe<SchemaColumn[]>(version.schemaJson, [])

  const outcomes = rules.map((rule) => ({ rule, outcome: evaluateOne(rule, rows, columns, dataset.updatedAt) }))

  const now = new Date()
  if (outcomes.length > 0) {
    await db.qualityResult.createMany({
      data: outcomes.map(({ rule, outcome }) => ({
        ruleId: rule.id,
        datasetId,
        versionNumber,
        passed: outcome.passed,
        actual: outcome.actual,
        message: outcome.message,
        trigger,
        createdAt: now,
      })),
    })
  }

  // severity 'error' failures raise platform notifications (never-throw).
  for (const { rule, outcome } of outcomes) {
    if (!outcome.passed && rule.severity === 'error') {
      await createNotification({
        type: 'quality_failed',
        title: `Quality failed: ${dataset.name} · ${rule.name}`,
        body: outcome.message ?? outcome.actual ?? 'Quality rule failed',
        resourceType: 'dataset',
        resourceId: datasetId,
        href: `/datasets/${datasetId}`,
      })
    }
  }

  const passed = outcomes.filter((o) => o.outcome.passed).length
  const failed = outcomes.length - passed

  // P2 trust workflow: persist the aggregate state on the version itself so
  // the publication gate and the studio UI can read it without re-querying
  // results. error-severity failures → 'failed'; warn-only → 'warned';
  // no rules → 'not_evaluated'.
  const errorFailures = outcomes.filter((o) => !o.outcome.passed && o.rule.severity === 'error').length
  const warnFailures = failed - errorFailures
  const qualityState =
    outcomes.length === 0 ? 'not_evaluated' : errorFailures > 0 ? 'failed' : warnFailures > 0 ? 'warned' : 'passed'
  await db.datasetVersion
    .update({
      where: { datasetId_versionNumber: { datasetId, versionNumber } },
      data: {
        qualityState,
        qualitySummaryJson: JSON.stringify({
          passed,
          failed,
          errorFailures,
          warnFailures,
          evaluatedAt: now.toISOString(),
        }),
      },
    })
    .catch(() => undefined) // version may have been pruned mid-evaluation — never throw

  return {
    versionNumber,
    results: outcomes.map(({ rule, outcome }) => ({
      ruleName: rule.name,
      kind: rule.kind,
      passed: outcome.passed,
      actual: outcome.actual,
      message: outcome.message,
      severity: rule.severity,
    })),
    passed,
    failed,
  }
}

export class QualityError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export const QUALITY_KINDS: QualityRuleKind[] = [
  'not_null',
  'unique',
  'range',
  'allowed_values',
  'regex',
  'freshness',
  'row_count_min',
]

/** Column is required for every kind except dataset-level ones. */
export function kindRequiresColumn(kind: string): boolean {
  return kind !== 'freshness' && kind !== 'row_count_min'
}
