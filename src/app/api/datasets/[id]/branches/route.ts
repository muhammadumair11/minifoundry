// GET/POST /api/datasets/[id]/branches — R14 dataset branches.
// GET lists branches + main head (any role). POST creates a branch from a
// main version (default: main head); duplicate names → 409. Editor+ required.

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonError, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, getActor, requireRole } from '@/lib/governance'
import { BranchError, createBranch, listBranches } from '@/lib/branching'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(64),
  description: z.string().max(500).optional(),
  baseVersion: z.number().int().min(1).optional(),
})

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true } })
    if (!dataset) return jsonError(404, `Dataset '${id}' not found`)
    return jsonOk(await listBranches(id))
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load branches')
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

    const actor = getActor(req)
    try {
      const branch = await createBranch(
        id,
        {
          name: parsed.data.name,
          description: parsed.data.description,
          baseVersion: parsed.data.baseVersion,
        },
        actor.email ?? actor.role,
      )
      audit({
        req,
        action: 'dataset.branch.create',
        resourceType: 'dataset',
        resourceId: id,
        resourceName: dataset.name,
        detail: `branch='${branch.name}' base=v${branch.baseVersion}`,
      })
      return jsonOk(branch, 201)
    } catch (err) {
      if (err instanceof BranchError) return jsonError(err.status, err.message)
      throw err
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to create branch')
  }
}
