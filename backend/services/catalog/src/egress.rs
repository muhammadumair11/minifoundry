//! SSRF egress guard — exact port of src/lib/egress.ts.
//!
//! Used by the REST connector (real_ingest.rs) so a connector URL can never
//! reach non-public infrastructure:
//!   • only http/https schemes;
//!   • the target host must resolve to PUBLIC addresses only (IP literals are
//!     checked directly; hostnames are resolved and EVERY record checked);
//!   • redirects are followed MANUALLY with a hard cap (3) and every hop's
//!     Location is re-validated; the validated address is PINNED for the
//!     connection (DNS is never queried twice).

use std::net::{IpAddr, SocketAddr};
use url::Url;

pub const MAX_REDIRECTS: usize = 3;

/// Blocked IPv4 CIDRs — loopback, private, link-local, CGNAT, doc, multicast,
/// reserved (base as u32 big-endian, prefix bits) — the legacy BLOCKED_V4.
const BLOCKED_V4: [(u32, u8); 14] = [
    (0x00000000, 8),  // 0.0.0.0/8      "this network"
    (0x0a000000, 8),  // 10.0.0.0/8     private
    (0x64400000, 10), // 100.64.0.0/10  CGNAT
    (0x7f000000, 8),  // 127.0.0.0/8    loopback
    (0xa9fe0000, 16), // 169.254.0.0/16 link-local (cloud metadata)
    (0xac100000, 12), // 172.16.0.0/12  private
    (0xc0000000, 24), // 192.0.0.0/24   IETF protocol assignments
    (0xc0000200, 24), // 192.0.2.0/24   TEST-NET-1
    (0xc6120000, 15), // 198.18.0.0/15  benchmarking
    (0xc6336400, 24), // 198.51.100.0/24 TEST-NET-2
    (0xcb007100, 24), // 203.0.113.0/24 TEST-NET-3
    (0xc0a80000, 16), // 192.168.0.0/16 private
    (0xe0000000, 4),  // 224.0.0.0/4    multicast
    (0xf0000000, 4),  // 240.0.0.0/4    reserved (incl. 255.255.255.255)
];

/// Port of `isPrivateV4` — anything that is not a clean dotted quad is
/// treated as hostile.
pub fn is_private_v4(ip: &str) -> bool {
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() != 4 {
        return true;
    }
    let mut n: u32 = 0;
    for part in parts {
        // JS Number(part): only plain non-negative decimal octets are valid;
        // Number("0x10") would be 16 — reject anything not all-digits.
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return true;
        }
        let Ok(v) = part.parse::<u32>() else {
            return true;
        };
        if v > 255 {
            return true;
        }
        n = (n << 8) | v;
    }
    for (base, bits) in BLOCKED_V4 {
        let mask: u32 = if bits == 0 {
            0
        } else {
            0xffffffffu32 << (32 - bits)
        };
        if (n & mask) == (base & mask) {
            return true;
        }
    }
    false
}

/// Port of `isPrivateV6` — string-level parsing identical to the legacy
/// implementation (zone ids, ::ffff: mapped, expansion, range checks).
pub fn is_private_v6(ip: &str) -> bool {
    let addr: String = ip
        .to_lowercase()
        .split('%')
        .next()
        .unwrap_or("")
        .to_string();
    // IPv4-mapped / IPv4-compatible → evaluate the embedded IPv4.
    let mapped_re = regex::Regex::new(r"^::ffff:(\d+\.\d+\.\d+\.\d+)$").unwrap();
    if let Some(caps) = mapped_re.captures(&addr) {
        return is_private_v4(&caps[1]);
    }
    if addr == "::" || addr == "::1" {
        return true; // unspecified / loopback
    }
    // Expand :: groups into 8 hextets.
    let halves: Vec<&str> = addr.split("::").collect();
    if halves.len() > 2 {
        return true;
    }
    let left: Vec<&str> = if !halves[0].is_empty() {
        halves[0].split(':').collect()
    } else {
        Vec::new()
    };
    let right: Vec<&str> = if halves.len() == 2 && !halves[1].is_empty() {
        halves[1].split(':').collect()
    } else {
        Vec::new()
    };
    let fill = 8 - left.len() as i32 - right.len() as i32;
    if fill < 0 {
        return true;
    }
    let mut groups: Vec<String> = Vec::new();
    groups.extend(left.iter().map(|s| s.to_string()));
    groups.extend(std::iter::repeat_n("0".to_string(), fill as usize));
    groups.extend(right.iter().map(|s| s.to_string()));
    if groups.len() != 8 {
        return true;
    }
    let hextets: Vec<i64> = groups
        .iter()
        .map(|p| i64::from_str_radix(p, 16).unwrap_or(-1))
        .collect();
    if hextets.iter().any(|&h| !(0..=0xffff).contains(&h)) {
        return true;
    }
    if hextets[0..5].iter().all(|&h| h == 0) && hextets[5] == 0xffff {
        let embedded = format!(
            "{}.{}.{}.{}",
            hextets[6] >> 8,
            hextets[6] & 255,
            hextets[7] >> 8,
            hextets[7] & 255
        );
        return is_private_v4(&embedded);
    }
    if hextets[0..6].iter().all(|&h| h == 0) {
        return true; // IPv4-compatible / unspecified
    }
    let first = hextets[0];
    if (first & 0xe000) != 0x2000 {
        return true; // only global unicast 2000::/3
    }
    if (first & 0xfe00) == 0xfc00 {
        return true; // fc00::/7 unique local
    }
    if (first & 0xffc0) == 0xfe80 {
        return true; // fe80::/10 link-local
    }
    if (first & 0xff00) == 0xff00 {
        return true; // ff00::/8 multicast
    }
    if first == 0x2001 && groups[1].starts_with("db8") {
        return true; // 2001:db8::/32 doc
    }
    if first == 0x2001 && hextets[1] == 0 {
        return true; // Teredo 2001::/32
    }
    if first == 0x2002 {
        return true; // 6to4 can tunnel private IPv4
    }
    false
}

/// True when the address string is private/reserved and must be blocked.
pub fn is_blocked_address(address: &str) -> bool {
    if address.contains(':') {
        is_private_v6(address)
    } else {
        is_private_v4(address)
    }
}

#[derive(Debug)]
pub struct ResolvedTarget {
    pub url: Url,
    pub address: IpAddr,
}

/// Port of `resolvePublicHttpUrl`: validate scheme, host and EVERY resolved
/// address. Clean user-facing error strings match the legacy exactly.
pub fn resolve_public_http_url(raw_url: &str) -> Result<ResolvedTarget, String> {
    let url = Url::parse(raw_url).map_err(|_| "Invalid URL".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!(
            "Blocked: only http(s) URLs are allowed (got '{}:')",
            url.scheme()
        ));
    }
    let host = url
        .host_str()
        .unwrap_or("")
        .trim()
        .to_lowercase()
        .trim_matches(|c| c == '[' || c == ']')
        .to_string();
    if host.is_empty() {
        return Err("URL has no host".to_string());
    }

    // IP literal → check directly. Hostname → resolve ALL records, check each.
    let digits_dots = regex::Regex::new(r"^[\d.]+$").unwrap();
    let is_literal = digits_dots.is_match(&host) || host.contains(':');
    let addresses: Vec<IpAddr> = if is_literal {
        match host.parse::<IpAddr>() {
            Ok(ip) => vec![ip],
            // A "literal" that does not parse is hostile input — block it the
            // same way the legacy blocked non-quad v4 / malformed v6 strings.
            Err(_) => {
                return Err(format!(
                    "Blocked: '{host}' resolves to a non-public address ({host}). \
                     Connectors may only reach the public internet."
                ))
            }
        }
    } else {
        resolve_all(&host)?
    };
    let blocked: Vec<IpAddr> = addresses
        .iter()
        .copied()
        .filter(|a| is_blocked_address(&a.to_string()))
        .collect();
    if !blocked.is_empty() || addresses.is_empty() {
        let sample = blocked
            .first()
            .map(|a| a.to_string())
            .unwrap_or_else(|| "no addresses".to_string());
        return Err(format!(
            "Blocked: '{host}' resolves to a non-public address ({sample}). \
             Connectors may only reach the public internet."
        ));
    }
    Ok(ResolvedTarget {
        url,
        address: addresses[0],
    })
}

/// DNS resolution of ALL A/AAAA records (node `lookup(host, {all:true})`).
fn resolve_all(host: &str) -> Result<Vec<IpAddr>, String> {
    use dns_lookup::{getaddrinfo, AddrInfoHints};
    let hints = AddrInfoHints::default();
    let iter = getaddrinfo(Some(host), None, Some(hints)).map_err(|e| {
        format!(
            "Blocked: '{host}' resolves to a non-public address (no addresses). \
             Connectors may only reach the public internet. ({e:?})"
        )
    })?;
    let mut out: Vec<IpAddr> = Vec::new();
    for info in iter {
        let info = info.map_err(|_| {
            "Blocked: DNS resolution failed. Connectors may only reach the public internet."
                .to_string()
        })?;
        let ip = info.sockaddr.ip();
        if !out.contains(&ip) {
            out.push(ip);
        }
    }
    if out.is_empty() {
        return Err(format!(
            "Blocked: '{host}' resolves to a non-public address (no addresses). \
             Connectors may only reach the public internet."
        ));
    }
    Ok(out)
}

/// Assert that `url` is a fetchable public http(s) URL (validation only).
pub fn assert_public_http_url(raw_url: &str) -> Result<Url, String> {
    Ok(resolve_public_http_url(raw_url)?.url)
}

/// GET with SSRF egress controls: public-URL validation, manual redirects with
/// a 3-hop cap (each hop re-validated + address pinned), caller timeout and
/// headers. Returns the final response.
pub async fn egress_fetch(
    raw_url: &str,
    headers: &[(&str, &str)],
    timeout: std::time::Duration,
) -> Result<reqwest::Response, String> {
    let mut current = resolve_public_http_url(raw_url)?;
    let mut header_list: Vec<(String, String)> = headers
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    for hop in 0.. {
        let resp = request_pinned(&current, &header_list, timeout).await?;
        let status = resp.status();
        if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            if hop >= MAX_REDIRECTS {
                return Err(format!("Blocked: more than {MAX_REDIRECTS} redirects"));
            }
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let Some(location) = location else {
                return Err(format!(
                    "Redirect {} without a Location header",
                    status.as_u16()
                ));
            };
            // Relative Locations resolve against the current URL; every hop is
            // re-validated (scheme + public host) before following.
            let next_url = current
                .url
                .join(&location)
                .map_err(|_| "Invalid URL".to_string())?;
            let cross_origin = next_url.origin() != current.url.origin();
            let next = resolve_public_http_url(next_url.as_str())?;
            if cross_origin {
                header_list.retain(|(name, _)| {
                    !matches!(
                        name.to_lowercase().as_str(),
                        "authorization" | "cookie" | "proxy-authorization"
                    )
                });
            }
            current = next;
            continue;
        }
        return Ok(resp);
    }
    unreachable!()
}

/// Connect to the already-validated address while retaining the original
/// hostname for Host and TLS checks (reqwest DNS override = pinning).
async fn request_pinned(
    target: &ResolvedTarget,
    headers: &[(String, String)],
    timeout: std::time::Duration,
) -> Result<reqwest::Response, String> {
    let port = target.url.port_or_known_default().unwrap_or(80);
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .resolve(
            target.url.host_str().unwrap_or(""),
            SocketAddr::new(target.address, port),
        )
        .build()
        .map_err(|e| format!("Fetch failed: {e}"))?;
    let mut rb = client.get(target.url.as_str());
    for (k, v) in headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    rb.send().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_v4_ranges_match_legacy() {
        for ip in [
            "0.0.0.0",
            "0.1.2.3",
            "10.0.0.1",
            "10.255.255.255",
            "100.64.0.1",
            "100.127.0.1",
            "127.0.0.1",
            "127.9.9.9",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.19.255.255",
            "198.51.100.1",
            "203.0.113.1",
            "192.168.0.1",
            "192.168.255.255",
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
        ] {
            assert!(is_private_v4(ip), "{ip} must be blocked");
        }
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "100.63.0.1",
            "100.128.0.1",
            "172.15.0.1",
            "172.32.0.1",
            "192.169.0.1",
            "93.184.216.34",
        ] {
            assert!(!is_private_v4(ip), "{ip} must be allowed");
        }
        // hostile non-quads
        assert!(is_private_v4("127.1"));
        assert!(is_private_v4("1.2.3.4.5"));
        assert!(is_private_v4("abc"));
        assert!(is_private_v4("256.1.1.1"));
        assert!(is_private_v4("1.2.3.0x10"));
    }

    #[test]
    fn blocked_v6_ranges_match_legacy() {
        for ip in [
            "::",
            "::1",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "ff02::1",
            "2001:db8::1",
            "2001::1",               // Teredo (hextets[1] == 0)
            "2002:c000:0204::1",     // 6to4
            "::ffff:127.0.0.1",      // mapped loopback
            "::ffff:a9fe:a9fe",      // mapped 169.254.169.254 (embedded-v4 rule)
            "0:0:0:0:0:ffff:7f00:1", // expanded mapped loopback
            "::2",                   // IPv4-compatible
            "1234::1",               // outside 2000::/3
        ] {
            assert!(is_private_v6(ip), "{ip} must be blocked");
        }
        for ip in [
            "2001:4860:4860::8888",
            "2606:2800:220:1:248:1893:25c8:1946",
            "2001:500::1",
        ] {
            assert!(!is_private_v6(ip), "{ip} must be allowed");
        }
        // malformed → hostile
        assert!(is_private_v6(":::"));
        assert!(is_private_v6("1:2:3:4:5:6:7:8:9"));
        assert!(is_private_v6("gggg::1"));
    }

    #[test]
    fn blocked_address_dispatch() {
        assert!(is_blocked_address("127.0.0.1"));
        assert!(is_blocked_address("::1"));
        assert!(!is_blocked_address("8.8.8.8"));
    }

    #[test]
    fn scheme_and_host_validation() {
        let err = resolve_public_http_url("file:///etc/passwd").unwrap_err();
        assert_eq!(err, "Blocked: only http(s) URLs are allowed (got 'file:')");
        let err = resolve_public_http_url("not a url").unwrap_err();
        assert_eq!(err, "Invalid URL");
        // IP literals never touch DNS
        let err = resolve_public_http_url("http://127.0.0.1/x").unwrap_err();
        assert!(
            err.starts_with("Blocked: '127.0.0.1' resolves to a non-public address (127.0.0.1)")
        );
        assert!(err.ends_with("Connectors may only reach the public internet."));
        let err = resolve_public_http_url("http://[::1]:8080/x").unwrap_err();
        assert!(err.contains("non-public address"));
        let err = resolve_public_http_url("http://10.1.2.3").unwrap_err();
        assert!(err.contains("(10.1.2.3)"));
        // metadata endpoint
        assert!(resolve_public_http_url("http://169.254.169.254/latest/meta-data").is_err());
    }

    #[test]
    fn literal_detection_matches_legacy_regex() {
        // WHATWG URL normalization (same in JS `new URL`): exotic IPv4 forms
        // are normalized to dotted quads BEFORE the legacy literal check.
        let err = resolve_public_http_url("http://0x7f000001/x").unwrap_err();
        assert!(err.contains("non-public address"));
        let err = resolve_public_http_url("http://2130706433/x").unwrap_err();
        assert!(err.contains("non-public address"));
        // a trailing-dot IPv4 normalizes to the plain quad (public → allowed)
        assert!(resolve_public_http_url("http://1.2.3.4./x").is_ok());
    }

    #[tokio::test]
    async fn egress_fetch_rejects_private_before_network() {
        let err = egress_fetch(
            "http://192.168.1.1/admin",
            &[("accept", "*/*")],
            std::time::Duration::from_secs(2),
        )
        .await
        .unwrap_err();
        assert!(err.contains("Blocked"));
    }
}
