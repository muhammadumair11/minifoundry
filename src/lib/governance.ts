// MiniFoundry — M9 Governance & Audit shared service.
// Role model (learning-scale RBAC): viewer < editor < admin.
// Role resolution precedence (Phase 0 mode-aware, additive over the simulator):
//   1. valid `foundry-session` cookie (HMAC-verified) -> session role;
//   2. demo mode only: the `foundry-role` simulator cookie (set via POST
//      /api/session/role) — in shared mode the simulator is IGNORED (a client
//      could otherwise self-escalate by setting the cookie);
//   3. else no cookies:
//      • demo mode (default)  -> 'admin' — the machine-to-machine callers
//        (scheduler, curl, QA) the sandbox was built around;
//      • shared mode          -> 'anonymous' (level -1, below viewer) so every
//        role-guarded API 403s; machine callers must present x-service-token.
// Column markings: a Marking carries a minRole; dataset columns are marked via
// ColumnMarking rows. Readers whose role level is BELOW the marking's minRole
// see the MASK_LITERAL ("------") instead of the real cell value.

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getSession } from '@/lib/auth-service'
import { isDemoMode } from '@/lib/runtime-mode'
import type { Row, SchemaColumn } from '@/lib/dataset-service'

// ─── Roles ───────────────────────────────────────────────────────────

export type Role = 'viewer' | 'editor' | 'admin'

export const ROLE_ORDER: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 }

export const ROLE_COOKIE = 'foundry-role'

/**
 * Resolve the actor: a valid session cookie wins (role + email); in demo mode
 * the `foundry-role` simulator cookie is honored next, then no-cookie callers
 * fall back per mode ('admin' in demo, locked-out 'anonymous' in shared mode).
 */
export function getActor(req: NextRequest): { role: string; email: string | null } {
  const session = getSession(req)
  if (session && session.role in ROLE_ORDER) {
    return { role: session.role as Role, email: session.email }
  }
  if (!isDemoMode()) {
    // Shared mode: the simulator cookie is ignored and there is no anonymous
    // fallback — everything below viewer, so role-guarded routes 403.
    return { role: 'anonymous', email: null }
  }
  const raw = req.cookies.get(ROLE_COOKIE)?.value
  const role: Role = raw && raw in ROLE_ORDER ? (raw as Role) : 'admin'
  const learnerId = req.cookies.get('foundry-learner-id')?.value
  return { role, email: learnerId && /^[a-f0-9-]{36}$/.test(learnerId) ? `learner:${learnerId}` : null }
}

/**
 * Read the caller's role: valid session cookie -> session role; demo mode only:
 * the `foundry-role` cookie when valid, else 'admin' (no cookie = machine
 * caller); shared mode: 'anonymous' for no-session callers. Stays SYNC (HMAC
 * verify is synchronous).
 */
export function getRole(req: NextRequest): Role {
  return getActor(req).role as Role
}

/** Numeric level of a role string; unknown roles rank below viewer (defensive). */
export function roleLevel(role: string): number {
  return role in ROLE_ORDER ? ROLE_ORDER[role as Role] : -1
}

/** True when `role`'s level is >= `min`'s level. */
export function roleAtLeast(role: string, min: Role): boolean {
  return roleLevel(role) >= ROLE_ORDER[min]
}

/**
 * Guard helper: returns null when the caller's role satisfies `min`,
 * otherwise a ready-to-return 403 NextResponse with the EXACT contract body
 * { error: "requires <min> role (current: <role>)" }.
 */
export function requireRole(req: NextRequest, min: Role): NextResponse | null {
  const role = getRole(req)
  if (roleAtLeast(role, min)) return null
  return NextResponse.json({ error: `requires ${min} role (current: ${role})` }, { status: 403 })
}

// ─── Audit trail ─────────────────────────────────────────────────────

export interface AuditOptions {
  req?: NextRequest
  /** Explicit actor role (e.g. 'system' for scheduled runs); wins over req cookie/session. */
  actorRole?: string
  /** Explicit actor email (e.g. the user being logged in); when omitted, derived from the session (null for simulator/machine actors). Pass null to force-null. */
  actorEmail?: string | null
  action: string
  resourceType: string
  resourceId?: string | null
  resourceName?: string | null
  detail?: string | null
}

/**
 * Fire-and-forget AuditEntry write. actorRole = explicit ?? getRole(req) ?? 'admin';
 * actorEmail = explicit ?? session email (null for simulator/machine actors).
 * Never throws — audit failures are swallowed so they can't break the request.
 */
export function audit(opts: AuditOptions): void {
  const actor = opts.req ? getActor(opts.req) : { role: 'admin', email: null }
  const actorRole = opts.actorRole ?? actor.role
  const actorEmail = opts.actorEmail === undefined ? actor.email : opts.actorEmail
  void db.auditEntry
    .create({
      data: {
        actorRole,
        actorEmail: actorEmail ?? null,
        action: opts.action,
        resourceType: opts.resourceType,
        resourceId: opts.resourceId ?? null,
        resourceName: opts.resourceName ?? null,
        detail: opts.detail ?? null,
      },
    })
    .catch(() => {
      // audit must never mask the original response
    })
}

// ─── Column markings & masking ───────────────────────────────────────

/** 6 dashes — mono-friendly masked cell literal. */
export const MASK_LITERAL = '------'

export interface ColumnMarkingInfo {
  columnName: string
  markingName: string
  minRole: string
  color: string
}

/** Markings attached to a dataset's columns, joined with the marking record. */
export async function getColumnMarkings(datasetId: string): Promise<ColumnMarkingInfo[]> {
  const cms = await db.columnMarking.findMany({
    where: { datasetId },
    include: { marking: { select: { name: true, minRole: true, color: true } } },
    orderBy: { columnName: 'asc' },
  })
  return cms.map((cm) => ({
    columnName: cm.columnName,
    markingName: cm.marking.name,
    minRole: cm.marking.minRole,
    color: cm.marking.color,
  }))
}

/** Column names whose marking minRole is above the given role's level. */
export async function maskedColumnsFor(datasetId: string, role: string): Promise<string[]> {
  const roleLvl = roleLevel(role)
  const cms = await getColumnMarkings(datasetId)
  return cms
    .filter((m) => (m.minRole in ROLE_ORDER ? ROLE_ORDER[m.minRole as Role] : 99) > roleLvl)
    .map((m) => m.columnName)
}

/**
 * Mask cell values: for every column with a marking whose minRole level is
 * above `role`'s level, replace the value with MASK_LITERAL in every row.
 * Returns NEW row objects (input rows are never mutated) plus the list of
 * masked column names.
 */
export async function applyMasking(
  datasetId: string,
  rows: Row[],
  role: string,
): Promise<{ rows: Row[]; maskedColumns: string[] }> {
  const maskedColumns = await maskedColumnsFor(datasetId, role)
  if (maskedColumns.length === 0 || rows.length === 0) {
    return { rows, maskedColumns }
  }
  const masked = new Set(maskedColumns)
  return {
    rows: rows.map((row) => {
      let changed = false
      const out: Row = {}
      for (const [key, value] of Object.entries(row)) {
        if (masked.has(key)) {
          out[key] = MASK_LITERAL
          changed = true
        } else {
          out[key] = value
        }
      }
      return changed ? out : row
    }),
    maskedColumns,
  }
}

/**
 * Annotate a schema with the marking name per column (additive `markedWith`
 * field, null when unmarked). Used by the dataset detail endpoint.
 */
export async function maskSchema(
  columns: SchemaColumn[],
  datasetId: string,
): Promise<Array<SchemaColumn & { markedWith: string | null }>> {
  const cms = await getColumnMarkings(datasetId)
  const byColumn = new Map(cms.map((m) => [m.columnName, m.markingName]))
  return columns.map((col) => ({ ...col, markedWith: byColumn.get(col.name) ?? null }))
}
