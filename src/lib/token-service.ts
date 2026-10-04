// MiniFoundry — M10 Platform API token service.
// Tokens are the ONLY auth for the public /api/foundry/v1/* read API.
// Secrets look like `mf_live_<48 hex>` and are shown EXACTLY ONCE at creation;
// only the sha256 hash (tokenHash) and a display prefix (first 12 chars) are
// stored. API tokens act with VIEWER role — column-marking masking applies
// to every v1 response (governance across the API surface, by design).

import crypto from 'node:crypto'
import { db } from '@/lib/db'
import type { ApiToken } from '@prisma/client'
import type { NextRequest } from 'next/server'

/** Requests per minute per token (sliding window, see rate-limit.ts). */
export const TOKEN_RATE_LIMIT = 60

/** Length of the display prefix kept in clear text (e.g. "mf_live_a1b"). */
export const TOKEN_PREFIX_LENGTH = 12

export interface GeneratedToken {
  /** Plaintext secret `mf_live_<48 hex>` — hand to the caller exactly once. */
  secret: string
  /** First 12 chars of the secret (mf_live_XXX) — safe to store/display. */
  prefix: string
  /** sha256 hex of the secret — the only persisted credential material. */
  tokenHash: string
}

/** Generate a fresh token material triple (no DB access). */
export function generateToken(): GeneratedToken {
  const secret = `mf_live_${crypto.randomBytes(24).toString('hex')}`
  return {
    secret,
    prefix: secret.slice(0, TOKEN_PREFIX_LENGTH),
    tokenHash: hashToken(secret),
  }
}

/** sha256 hex of a secret — the storage/lookup form. */
export function hashToken(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex')
}

/** Extract `Bearer <secret>` from the Authorization header (case-insensitive scheme). */
export function extractBearerToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/**
 * Resolve the caller's ApiToken from the Authorization header.
 * Returns null when the header is missing, the secret is unknown, or the
 * token has been revoked (revokedAt != null).
 */
export async function authenticateApiToken(req: NextRequest): Promise<ApiToken | null> {
  const secret = extractBearerToken(req)
  if (!secret) return null
  const token = await db.apiToken.findUnique({ where: { tokenHash: hashToken(secret) } })
  if (!token || token.revokedAt) return null
  return token
}
