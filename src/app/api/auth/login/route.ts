// POST /api/auth/login — real password login (M9).
// Sets BOTH cookies via buildSetCookies: the HttpOnly `foundry-session` token
// and the legacy JS-readable `foundry-role` cookie (= user.role) so simulator-
// era client code keeps working. Same 401 message for unknown email, inactive
// account and wrong password — no user enumeration.

import { z } from 'zod'
import { db } from '@/lib/db'
import { badRequest, jsonError, jsonOk, serverError, zodErrorMessage } from '@/lib/api-utils'
import { audit } from '@/lib/governance'
import { buildSetCookies, serializeAuthUser, verifyPassword } from '@/lib/auth-service'
import type { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
})

export async function POST(req: NextRequest) {
  try {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    const parsed = loginSchema.safeParse(body)
    if (!parsed.success) return badRequest(zodErrorMessage(parsed))

    const email = parsed.data.email.trim().toLowerCase()
    const user = await db.user.findUnique({ where: { email } })

    // Identical response for unknown / inactive / bad-password — no enumeration.
    if (!user || !user.isActive || !verifyPassword(parsed.data.password, user.passwordHash)) {
      return jsonError(401, 'invalid email or password')
    }

    const updated = await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    })

    audit({
      req,
      actorRole: updated.role,
      actorEmail: updated.email,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: updated.id,
      resourceName: updated.email,
      detail: `email=${updated.email} role=${updated.role}`,
    })

    const res = jsonOk({ user: serializeAuthUser(updated) })
    for (const c of buildSetCookies(updated)) res.cookies.set(c.name, c.value, c.options)
    return res
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Login failed')
  }
}
