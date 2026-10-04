// MiniFoundry — runtime mode boundary (Phase 0 "Foundation" hardening).
//
// MiniFoundry has TWO explicit runtime modes:
//
//   demo (default)  — `MF_DEMO_MODE` unset or `true`. Anonymous / no-cookie
//                     callers resolve to trusted 'admin' so the local sandbox
//                     stays explorable without login (scheduler mini-service,
//                     curl, agent-browser QA). The `foundry-role` simulator
//                     cookie is honored. This mode is NOT for shared deploys.
//
//   shared          — `MF_DEMO_MODE=false`. For any deployment reachable by
//                     more than one person:
//                     • anonymous callers resolve to 'anonymous' (level -1,
//                       below viewer) so EVERY role-guarded app API 403s —
//                       they cannot read or mutate data;
//                     • the `foundry-role` simulator cookie is IGNORED
//                       (otherwise anyone could escalate by setting it);
//                     • machine callers (scheduler, scripts) must present
//                       `x-service-token: <MF_SERVICE_TOKEN>` to be treated
//                       as the trusted 'system' actor.
//
// Login/session routes are open by design in both modes (otherwise nobody
// could ever authenticate).

import type { NextRequest } from 'next/server'

/** Header a machine caller must send when MF_SERVICE_TOKEN is configured. */
export const SERVICE_TOKEN_HEADER = 'x-service-token'

/** True when the app runs in the permissive local-demo mode (the default). */
export function isDemoMode(): boolean {
  const raw = (process.env.MF_DEMO_MODE ?? 'true').trim().toLowerCase()
  return raw !== 'false' && raw !== '0' && raw !== 'no'
}

/** Value of the configured service token (null when none is set). */
export function configuredServiceToken(): string | null {
  const token = process.env.MF_SERVICE_TOKEN?.trim()
  return token ? token : null
}

/**
 * Whether this request may act as the trusted machine caller ('system'):
 * - when no service token is configured → true ONLY in demo mode (the
 *   historical no-cookie behavior; in shared mode a token is mandatory);
 * - when a token IS configured → the request must present a matching
 *   constant value (length-safe comparison, not secret-dependent).
 */
export function isServiceAuthorized(req: NextRequest): boolean {
  const configured = configuredServiceToken()
  if (!configured) return isDemoMode()
  const provided = req.headers.get(SERVICE_TOKEN_HEADER)?.trim() ?? ''
  if (provided.length !== configured.length) return false
  let diff = 0
  for (let i = 0; i < configured.length; i++) {
    diff |= provided.charCodeAt(i) ^ configured.charCodeAt(i)
  }
  return diff === 0
}

/** True when the app is in shared mode — used for user-facing hints. */
export function modeLabel(): 'demo' | 'shared' {
  return isDemoMode() ? 'demo' : 'shared'
}
