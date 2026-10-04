// MiniFoundry — SSRF egress guard (Phase 0 "Foundation" hardening).
//
// Used by the REST connector (real-ingest.ts) so a connector URL can never be
// used to reach infrastructure that is not the public internet:
//   • only http/https schemes;
//   • the target host must be a PUBLIC address — IP literals are checked
//     directly, hostnames are resolved (ALL records) and every resolved
//     address must be public (blocks 127.0.0.1, ::1, 10/8, 172.16/12,
//     192.168/16, 169.254/16 link-local metadata, CGNAT, ULA, multicast, …);
//   • redirects are followed MANUALLY with a hard cap (3) and EVERY hop's
//     Location is re-validated (a public entry point must not bounce inward).
//
// Learning-scale limitation (documented in the README): the fetch itself still
// performs its own DNS resolution, so a DNS-rebinding TOCTOU window remains —
// closing it requires pinning the resolved IP at the socket layer.

import { lookup } from 'node:dns/promises'

const MAX_REDIRECTS = 3

/** Blocked IPv4 CIDRs — loopback, private, link-local, CGNAT, doc, multicast, reserved. */
const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8      "this network"
  [0x0a000000, 8], // 10.0.0.0/8     private
  [0x64400000, 10], // 100.64.0.0/10  CGNAT
  [0x7f000000, 8], // 127.0.0.0/8    loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (cloud metadata: 169.254.169.254)
  [0xac100000, 12], // 172.16.0.0/12  private
  [0xc0000000, 24], // 192.0.0.0/24   IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24   TEST-NET-1
  [0xc6120000, 15], // 198.18.0.0/15  benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xe0000000, 4], // 224.0.0.0/4    multicast
  [0xf0000000, 4], // 240.0.0.0/4    reserved (incl. 255.255.255.255)
]

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return true // not a dotted quad → treat as hostile
  let n = 0
  for (const part of parts) {
    const v = Number(part)
    if (!Number.isInteger(v) || v < 0 || v > 255) return true
    n = (n << 8) | v
  }
  for (const [base, bits] of BLOCKED_V4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    if ((n & mask) === (base & mask)) return true
  }
  return false
}

function isPrivateV6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0] // strip zone id
  // IPv4-mapped / IPv4-compatible → evaluate the embedded IPv4.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateV4(mapped[1])
  if (addr === '::' || addr === '::1') return true // unspecified / loopback
  // Expand :: groups into 8 hextets.
  const halves = addr.split('::')
  if (halves.length > 2) return true
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = 8 - left.length - right.length
  if (fill < 0) return true
  const groups = [...left, ...Array(fill).fill('0'), ...right]
  if (groups.length !== 8) return true
  const first = parseInt(groups[0], 16)
  if (Number.isNaN(first)) return true
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (first === 0x2001 && groups[1].startsWith('db8')) return true // 2001:db8::/32 doc
  if (first === 0x0064 && groups[1] === 'ff9b' && groups.slice(2, 6).every((g) => g === '0')) {
    return true // 64:ff9b::/96 well-known NAT64 prefix
  }
  return false
}

/** True when the address string is private/reserved and must be blocked. */
function isBlockedAddress(address: string): boolean {
  return address.includes(':') ? isPrivateV6(address) : isPrivateV4(address)
}

/**
 * Assert that `url` is a fetchable public http(s) URL. Throws a clean,
 * user-facing Error when the scheme is wrong, the host is private/reserved,
 * or DNS resolution fails / yields only non-public addresses.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked: only http(s) URLs are allowed (got '${url.protocol}')`)
  }
  const host = url.hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) throw new Error('URL has no host')

  // IP literal → check directly. Hostname → resolve ALL records and check each.
  const isLiteral = /^[\d.]+$/.test(host) || host.includes(':')
  const addresses = isLiteral ? [{ address: host }] : await lookup(host, { all: true })
  const blocked = addresses.filter((a) => isBlockedAddress(a.address))
  if (blocked.length > 0 || addresses.length === 0) {
    const sample = blocked[0]?.address ?? 'no addresses'
    throw new Error(
      `Blocked: '${host}' resolves to a non-public address (${sample}). ` +
        'Connectors may only reach the public internet.',
    )
  }
  return url
}

/**
 * GET with SSRF egress controls: public-URL validation, manual redirects with
 * a 3-hop cap (each hop re-validated), plus the caller's timeout/headers.
 * Returns the final Response (status/headers/body streaming stay with the caller).
 */
export async function egressFetch(
  rawUrl: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
): Promise<Response> {
  let currentUrl = await assertPublicHttpUrl(rawUrl)
  for (let hop = 0; ; hop++) {
    const res = await fetch(currentUrl, {
      signal: init.signal,
      redirect: 'manual',
      headers: init.headers,
    })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop >= MAX_REDIRECTS) {
        try { await res.body?.cancel() } catch { /* best-effort */ }
        throw new Error(`Blocked: more than ${MAX_REDIRECTS} redirects`)
      }
      const location = res.headers.get('location')
      try { await res.body?.cancel() } catch { /* best-effort */ }
      if (!location) throw new Error(`Redirect ${res.status} without a Location header`)
      // Relative Locations resolve against the current URL; every hop is
      // re-validated (scheme + public host) before following.
      currentUrl = await assertPublicHttpUrl(new URL(location, currentUrl).toString())
      continue
    }
    return res
  }
}
