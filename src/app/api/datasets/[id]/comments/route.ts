// /api/datasets/[id]/comments — Phase 4 (collaboration): dataset discussion.
//
// GET    → latest 200 comments, oldest-first for a chat-like thread read.
// POST   → { body, versionNumber? } — ANY role may discuss (collaboration is
//          the point of the tab); body 1..2000 chars, audited.
// DELETE → ?commentId= — the author or an admin may remove a comment.

import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonOk, notFound, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit, getActor, roleAtLeast } from '@/lib/governance'
import type { Role } from '@/lib/governance'

export const dynamic = 'force-dynamic'

/** Display identity for the actor: email, or a readable demo simulator label. */
function identityOf(req: NextRequest): { key: string; label: string; role: string } {
  const actor = getActor(req)
  if (actor.email) return { key: actor.email, label: actor.email, role: actor.role }
  return { key: `sim:${actor.role}`, label: `${actor.role} (demo)`, role: actor.role }
}

async function requireDataset(id: string) {
  const dataset = await db.dataset.findUnique({ where: { id }, select: { id: true, name: true } })
  return dataset
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const dataset = await requireDataset(id)
    if (!dataset) return notFound('dataset not found')

    const comments = await db.datasetComment.findMany({
      where: { datasetId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    // oldest-first so the thread reads top-down like a conversation
    comments.reverse()

    return jsonOk({
      comments: comments.map((c) => ({
        id: c.id,
        datasetId: c.datasetId,
        versionNumber: c.versionNumber,
        authorKey: c.authorKey,
        authorLabel: c.authorLabel,
        authorRole: c.authorRole,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to load comments')
  }
}

const bodySchema = z.object({
  body: z.string().trim().min(1, 'comment is empty').max(2000, 'comment too long (2000 chars max)'),
  versionNumber: z.number().int().positive().optional().nullable(),
})

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const dataset = await requireDataset(id)
    if (!dataset) return notFound('dataset not found')

    const parsed = bodySchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const who = identityOf(req)
    const comment = await db.datasetComment.create({
      data: {
        datasetId: id,
        versionNumber: parsed.data.versionNumber ?? null,
        authorKey: who.key,
        authorLabel: who.label,
        authorRole: who.role,
        body: parsed.data.body,
      },
    })

    audit({
      req,
      action: 'dataset.comment',
      resourceType: 'dataset',
      resourceId: id,
      resourceName: dataset.name,
      detail: `comment on ${parsed.data.versionNumber ? `v${parsed.data.versionNumber}` : 'dataset'}: ${parsed.data.body.slice(0, 80)}${parsed.data.body.length > 80 ? '…' : ''}`,
    })

    return jsonOk({
      comment: {
        id: comment.id,
        datasetId: comment.datasetId,
        versionNumber: comment.versionNumber,
        authorKey: comment.authorKey,
        authorLabel: comment.authorLabel,
        authorRole: comment.authorRole,
        body: comment.body,
        createdAt: comment.createdAt.toISOString(),
      },
    }, 201)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to post comment')
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    const commentId = new URL(req.url).searchParams.get('commentId')
    if (!commentId) return badRequest('commentId query parameter is required')

    const comment = await db.datasetComment.findUnique({ where: { id: commentId } })
    if (!comment || comment.datasetId !== id) return notFound('comment not found')

    const actor = getActor(req)
    const isAuthor = actor.email ? comment.authorKey === actor.email : comment.authorKey === `sim:${actor.role}`
    const isAdmin = roleAtLeast(actor.role as Role, 'admin')
    if (!isAuthor && !isAdmin) {
      return badRequest('only the comment author or an admin can delete a comment')
    }

    await db.datasetComment.delete({ where: { id: commentId } })
    audit({
      req,
      action: 'dataset.comment_delete',
      resourceType: 'dataset',
      resourceId: id,
      detail: `deleted comment ${comment.id}`,
    })
    return jsonOk({ deleted: true })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Failed to delete comment')
  }
}
