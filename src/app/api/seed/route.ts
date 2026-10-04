// POST /api/seed — idempotent database seeding (sample packs + demo pipeline).
// Governance: editor+ role (creates datasets/connectors/pipelines).

import { seedDatabase } from '@/lib/seed'
import { jsonOk, serverError } from '@/lib/api-utils'
import { requireRole } from '@/lib/governance'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const denied = requireRole(req, 'editor')
    if (denied) return denied

    const result = await seedDatabase()
    return jsonOk(result)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Seeding failed')
  }
}
