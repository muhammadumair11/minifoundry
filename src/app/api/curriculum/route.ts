// /api/curriculum — Phase 3 (guided curriculum).
//
// GET  → full step list with live completion status for the caller
//        (auto-verified steps detected from real platform state, manual
//        check-offs persisted per actorKey).
// POST → toggle a MANUAL step's check-off { stepId, done }. Auto steps are
//        rejected: their completion is owned by platform state, not by a
//        flag (that's the whole teaching point).
// DELETE → reset the caller's manual progress.

import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, getActor } from '@/lib/governance'
import { CURRICULUM_STEPS, getCurriculumStatus } from '@/lib/curriculum'

export const dynamic = 'force-dynamic'

/** Identity key for persisted progress: session email or demo simulator role. */
function actorKeyOf(req: NextRequest): string {
  const actor = getActor(req)
  return actor.email ?? `sim:${actor.role}`
}

export async function GET(req: NextRequest) {
  try {
    const status = await getCurriculumStatus(actorKeyOf(req))
    return jsonOk(status)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load curriculum')
  }
}

const bodySchema = z.object({
  stepId: z.string().min(1),
  done: z.boolean(),
})

export async function POST(req: NextRequest) {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const step = CURRICULUM_STEPS.find((s) => s.id === parsed.data.stepId)
    if (!step) return badRequest(`unknown step '${parsed.data.stepId}'`)
    if (step.verify !== 'manual') {
      return badRequest(
        `'${step.id}' is auto-verified from real platform state — do the action on ${step.href} to complete it`,
      )
    }

    const actorKey = actorKeyOf(req)
    if (parsed.data.done) {
      await db.curriculumProgress.upsert({
        where: { actorKey_stepId: { actorKey, stepId: step.id } },
        create: { actorKey, stepId: step.id, source: 'manual' },
        update: {},
      })
    } else {
      await db.curriculumProgress.deleteMany({ where: { actorKey, stepId: step.id } })
    }

    audit({
      req,
      action: parsed.data.done ? 'curriculum.step_complete' : 'curriculum.step_uncheck',
      resourceType: 'curriculum',
      resourceId: step.id,
      resourceName: step.title,
      detail: `manual check-off ${parsed.data.done ? 'set' : 'cleared'} for ${actorKey}`,
    })

    return jsonOk(await getCurriculumStatus(actorKey))
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to update curriculum')
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const actorKey = actorKeyOf(req)
    const removed = await db.curriculumProgress.deleteMany({ where: { actorKey } })
    audit({
      req,
      action: 'curriculum.reset',
      resourceType: 'curriculum',
      detail: `${removed.count} manual check-off(s) cleared for ${actorKey}`,
    })
    return jsonOk(await getCurriculumStatus(actorKey))
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to reset curriculum')
  }
}
