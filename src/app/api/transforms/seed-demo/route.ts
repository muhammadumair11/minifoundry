// POST /api/transforms/seed-demo — idempotent demo seeding for M4 workbooks.
// NOTE: this is a STATIC segment next to [id]; App Router resolves static
// routes first, so /api/transforms/seed-demo is matched here, not as transform
// id "seed-demo" (same pattern as /api/schedules/due).
//
// Resolves the three demo datasets BY NAME ("Shipments", "Suppliers",
// "Active Shipments"); creates the SQL + JS demo transforms when absent.
// Requires editor+ role.

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({}).passthrough().optional()

const SQL_SOURCE = `-- Total spend per supplier from shipment line items
SELECT
  s.name  AS supplier,
  s.country,
  COUNT(*)               AS shipments,
  SUM(sh.quantity)       AS unitsShipped,
  ROUND(SUM(sh.quantity * sh.unitPrice), 2) AS totalSpend
FROM shipments sh
JOIN suppliers s ON s.id = sh.supplierId
GROUP BY s.name, s.country
ORDER BY totalSpend DESC`

const JS_SOURCE = `// Risk-flag every active shipment with simple heuristics.
const out = input.rows.map(function (r) {
  const eta = Number(r.etaDays) || 0
  const value = Math.round((Number(r.quantity) || 0) * (Number(r.unitPrice) || 0) * 100) / 100
  const risk = r.status === 'delayed' ? 'high' : eta >= 10 ? 'medium' : 'low'
  return {
    shipmentId: r.id,
    productName: r.productName,
    category: r.category,
    status: r.status,
    etaDays: eta,
    value: value,
    riskLevel: risk,
  }
})
return out`

const PYTHON_SOURCE = `# Score active shipments into a fulfillment priority list (urgency-adjusted value).
# transform(input) receives {"rows": first input, "datasets": {...}, "schemas": {...}}.
def transform(input):
    scored = []
    for r in input["rows"]:
        eta = int(r.get("etaDays") or 0)
        qty = int(r.get("quantity") or 0)
        price = float(r.get("unitPrice") or 0.0)
        value = round(qty * price, 2)
        score = value / (eta + 1)  # urgency-adjusted value
        priority = "high" if eta <= 3 else "medium" if eta <= 8 else "low"
        scored.append({
            "shipmentId": r.get("id"),
            "productName": r.get("productName"),
            "category": r.get("category"),
            "etaDays": eta,
            "value": value,
            "priorityScore": round(score, 2),
            "priority": priority,
        })
    scored.sort(key=lambda s: -s["priorityScore"])
    return scored
`

interface DemoSpec {
  name: string
  description: string
  language: 'sql' | 'javascript' | 'python'
  inputNames: string[]
  outputDatasetName: string
  sourceCode: string
}

const DEMOS: DemoSpec[] = [
  {
    name: 'Supplier Spend Summary',
    description: 'SQL workbook — aggregates shipment line items into total spend per supplier.',
    language: 'sql',
    inputNames: ['Shipments', 'Suppliers'],
    outputDatasetName: 'Supplier Spend Summary',
    sourceCode: SQL_SOURCE,
  },
  {
    name: 'Shipment Risk Flags',
    description: 'JavaScript workbook — risk-flags every active shipment with simple heuristics.',
    language: 'javascript',
    inputNames: ['Active Shipments'],
    outputDatasetName: 'Shipment Risk Flags',
    sourceCode: JS_SOURCE,
  },
  {
    name: 'Fulfillment Priority',
    description: 'Python workbook — scores active shipments by urgency-adjusted value into a priority list.',
    language: 'python',
    inputNames: ['Active Shipments'],
    outputDatasetName: 'Fulfillment Priority',
    sourceCode: PYTHON_SOURCE,
  },
]

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    // Body is optional; validate when present.
    try {
      const text = await req.text()
      if (text.trim() !== '') {
        const parsed = bodySchema.safeParse(JSON.parse(text))
        if (!parsed.success) return badRequest(zodErrorMessage(parsed))
      }
    } catch {
      return badRequest('Request body must be valid JSON')
    }

    // Resolve demo inputs BY NAME (they are re-resolved on every run, so
    // re-ingested datasets with the same name keep working).
    const names = [...new Set(DEMOS.flatMap((d) => d.inputNames))]
    const datasets = await db.dataset.findMany({ where: { name: { in: names } }, select: { id: true, name: true } })
    const byName = new Map(datasets.map((d) => [d.name, d.id]))
    const missing = names.filter((n) => !byName.has(n))
    if (missing.length > 0) {
      return badRequest(`Cannot seed demo transforms — missing datasets: ${missing.join(', ')}`)
    }

    const created: string[] = []
    const skipped: string[] = []
    for (const demo of DEMOS) {
      const existing = await db.transform.findUnique({ where: { name: demo.name }, select: { id: true } })
      if (existing) {
        skipped.push(demo.name)
        continue
      }
      const inputIds = demo.inputNames.map((n) => byName.get(n) as string)
      const transform = await db.transform.create({
        data: {
          name: demo.name,
          description: demo.description,
          language: demo.language,
          sourceCode: demo.sourceCode,
          inputsJson: JSON.stringify(inputIds),
          outputDatasetName: demo.outputDatasetName,
        },
        select: { id: true, name: true },
      })
      audit({
        req,
        action: 'transform.create',
        resourceType: 'transform',
        resourceId: transform.id,
        resourceName: transform.name,
        detail: 'seed-demo',
      })
      created.push(demo.name)
    }

    return jsonOk({ seeded: created.length > 0, created, skipped })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to seed demo transforms')
  }
}
