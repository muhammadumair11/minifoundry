// /api/datasets/[id]/watch — Phase 4 (collaboration): watch a dataset.
//
// GET  → { watching, watchers } for the caller (watcher key = session email,
//        or 'sim:<role>' in demo mode).
// POST → { watch: boolean } toggles the caller's subscription. Watchers are
//        notified (targeted in shared mode, broadcast in demo) whenever the
//        dataset gets a NEW version — see lib/version-events.ts.

import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, getActor } from '@/lib/governance'

export const dynamic = 'force-dynamic'

function watcherKeyOf(req: NextRequest): string {
  const actor = getActor(req)
  return actor.email ?? `sim:${actor.role}`
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true } })
    if (!dataset) return notFound('dataset not found')

    const [mine, total] = await Promise.all([
      db.datasetWatcher.findFirst({
        where: { datasetId: id, userEmail: watcherKeyOf(req) },
        select: { id: true },
      }),
      db.datasetWatcher.count({ where: { datasetId: id } }),
    ])

    return jsonOk({ watching: Boolean(mine), watchers: total })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load watch state')
  }
}

const bodySchema = z.object({ watch: z.boolean() })

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!dataset) return notFound('dataset not found')

    const parsed = bodySchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const key = watcherKeyOf(req)
    if (parsed.data.watch) {
      await db.datasetWatcher.upsert({
        where: { datasetId_userEmail: { datasetId: id, userEmail: key } },
        create: { datasetId: id, userEmail: key },
        update: {},
      })
    } else {
      await db.datasetWatcher.deleteMany({ where: { datasetId: id, userEmail: key } })
    }

    const watchers = await db.datasetWatcher.count({ where: { datasetId: id } })
    audit({
      req,
      action: parsed.data.watch ? 'dataset.watch' : 'dataset.unwatch',
      resourceType: 'dataset',
      resourceId: id,
      resourceName: dataset.name,
      detail: `${key} ${parsed.data.watch ? 'now watches' : 'stopped watching'} (${watchers} watcher${watchers === 1 ? '' : 's'})`,
    })

    return jsonOk({ watching: parsed.data.watch, watchers })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update watch state')
  }
}
