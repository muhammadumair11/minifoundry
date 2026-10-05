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
// The validated address is pinned at socket creation. Each redirect gets a
// fresh validation and connection; the HTTP client never resolves it again.

import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import type { LookupFunction } from 'node:net'

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
  const hextets = groups.map((part) => Number.parseInt(part, 16))
  if (hextets.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return true
  if (hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff) {
    const embedded = `${hextets[6] >> 8}.${hextets[6] & 255}.${hextets[7] >> 8}.${hextets[7] & 255}`
    return isPrivateV4(embedded)
  }
  if (hextets.slice(0, 6).every((part) => part === 0)) return true // IPv4-compatible / unspecified
  const first = parseInt(groups[0], 16)
  if (Number.isNaN(first)) return true
  if ((first & 0xe000) !== 0x2000) return true // only global unicast 2000::/3
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (first === 0x2001 && groups[1].startsWith('db8')) return true // 2001:db8::/32 doc
  if (first === 0x2001 && hextets[1] === 0) return true // Teredo 2001::/32
  if (first === 0x2002) return true // 6to4 can tunnel private IPv4
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
async function resolvePublicHttpUrl(rawUrl: string): Promise<{
  url: URL
  address: string
  family: number
}> {
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
  const addresses = isLiteral
    ? [{ address: host, family: host.includes(':') ? 6 : 4 }]
    : await lookup(host, { all: true })
  const blocked = addresses.filter((a) => isBlockedAddress(a.address))
  if (blocked.length > 0 || addresses.length === 0) {
    const sample = blocked[0]?.address ?? 'no addresses'
    throw new Error(
      `Blocked: '${host}' resolves to a non-public address (${sample}). ` +
        'Connectors may only reach the public internet.',
    )
  }
  return { url, address: addresses[0].address, family: addresses[0].family }
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  return (await resolvePublicHttpUrl(rawUrl)).url
}

/** Connect to the already-validated address while retaining the original
 * hostname for Host and TLS certificate checks. DNS is not queried again. */
async function requestPinned(
  target: Awaited<ReturnType<typeof resolvePublicHttpUrl>>,
  init: { signal: AbortSignal; headers: Record<string, string> },
): Promise<Response> {
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    const family = target.family as 4 | 6
    // Bun's HTTP client requests all addresses before sorting them. The
    // callback must use the array form for that request, even with one pin.
    if (options.all) callback(null, [{ address: target.address, family }])
    else callback(null, target.address, family)
  }
  return new Promise<Response>((resolve, reject) => {
    const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(target.url, {
      method: 'GET', headers: init.headers, signal: init.signal, agent: false,
      lookup: pinnedLookup,
    }, (incoming) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((part) => headers.append(name, part))
        else if (value !== undefined) headers.set(name, value)
      }
      const status = incoming.statusCode ?? 502
      if (status < 200 || status > 599) {
        incoming.destroy()
        reject(new Error(`Unsupported HTTP response status ${status}`))
        return
      }
      const noBody = status === 204 || status === 205 || status === 304
      if (noBody) incoming.resume()
      resolve(new Response(noBody ? null : Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, {
        status, headers,
      }))
    })
    request.on('error', reject)
    request.end()
  })
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
  let current = await resolvePublicHttpUrl(rawUrl)
  let headers = { ...init.headers }
  for (let hop = 0; ; hop++) {
    const res = await requestPinned(current, { signal: init.signal, headers })
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
      const next = await resolvePublicHttpUrl(new URL(location, current.url).toString())
      if (next.url.origin !== current.url.origin) {
        headers = Object.fromEntries(Object.entries(headers).filter(([name]) =>
          !['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase()),
        ))
      }
      current = next
      continue
    }
    return res
  }
}
