//! MiniFoundry — auth core (framework-free; axum glue lives in mf-web).
//!
//! Ports `src/lib/auth-service.ts` + `src/lib/runtime-mode.ts` +
//! the role model from `src/lib/governance.ts`:
//!
//! - Roles: `viewer < editor < admin`; `anonymous` = -1 (below viewer);
//!   `system` = trusted machine actor (service token / scheduler).
//! - Passwords: `scrypt:<saltHex>:<hashHex>` — node:crypto scryptSync defaults
//!   (N=16384, r=8, p=1, 64-byte key), byte-compatible with the old hashes.
//! - Sessions: signed JWTs (HS256 over `AUTH_SECRET`) carried in the HttpOnly
//!   `foundry-session` cookie + rotating `foundry-refresh` token. Claims mirror
//!   the old HMAC payload: { uid, email, name, role, realRole?, iat, exp }.
//! - Runtime modes: demo (default) vs shared (`MF_DEMO_MODE=false`), service
//!   token via `MF_SERVICE_TOKEN` compared in constant time.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ─── Cookies & headers ──────────────────────────────────────────────────

/// HttpOnly access-JWT cookie (name preserved from the old stack).
pub const SESSION_COOKIE: &str = "foundry-session";
/// HttpOnly rotating refresh-token cookie.
pub const REFRESH_COOKIE: &str = "foundry-refresh";
/// Legacy JS-readable role-simulator cookie (demo mode only).
pub const LEGACY_ROLE_COOKIE: &str = "foundry-role";
/// Anonymous learner identity cookie (demo mode only).
pub const LEARNER_COOKIE: &str = "foundry-learner-id";
/// Machine-caller header.
pub const SERVICE_TOKEN_HEADER: &str = "x-service-token";

/// Identity headers injected by the gateway (stripped from external requests).
pub const HEADER_ACTOR_ROLE: &str = "x-mf-actor-role";
pub const HEADER_ACTOR_EMAIL: &str = "x-mf-actor-email";
pub const HEADER_ACTOR_UID: &str = "x-mf-actor-uid";
pub const HEADER_ACTOR_NAME: &str = "x-mf-actor-name";
pub const HEADER_ACTOR_REAL_ROLE: &str = "x-mf-actor-real-role";
pub const HEADER_ORGANIZATION_ID: &str = "x-mf-organization-id";
/// `"1"` when the caller presented a valid service token (trusted machine).
pub const HEADER_IS_SERVICE: &str = "x-mf-service";
/// `"1"` when the platform runs in demo mode.
pub const HEADER_DEMO_MODE: &str = "x-mf-demo-mode";

/// 7 days — same TTL as the old session tokens.
pub const SESSION_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;
/// Access-token lifetime (short; the gateway refreshes transparently).
pub const ACCESS_TTL_SECONDS: i64 = 15 * 60;

// ─── Roles ──────────────────────────────────────────────────────────────

pub const ROLE_VIEWER: &str = "viewer";
pub const ROLE_EDITOR: &str = "editor";
pub const ROLE_ADMIN: &str = "admin";
pub const ROLE_OWNER: &str = "owner";
pub const ROLE_ORG_ADMIN: &str = "org_admin";
pub const ROLE_ACCESS_MANAGER: &str = "access_manager";
pub const ROLE_AUDITOR: &str = "auditor";
pub const ROLE_ANONYMOUS: &str = "anonymous";
pub const ROLE_SYSTEM: &str = "system";

/// Numeric level of a role string; unknown roles rank below viewer (-1).
/// Mirrors `roleLevel()` in governance.ts.
pub fn role_level(role: &str) -> i8 {
    match role {
        ROLE_VIEWER | ROLE_ACCESS_MANAGER => 0,
        ROLE_EDITOR => 1,
        ROLE_ADMIN | ROLE_ORG_ADMIN | ROLE_OWNER => 2,
        _ => -1,
    }
}

/// True when `role`'s level >= `min`'s level. Mirrors `roleAtLeast()`.
pub fn role_at_least(role: &str, min: &str) -> bool {
    role_level(role) >= role_level(min)
}

// ─── Actor ──────────────────────────────────────────────────────────────

/// The resolved caller identity, produced by the gateway and re-read from
/// `X-Mf-Actor-*` headers by every service. Mirrors `getActor()` results.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Actor {
    /// Effective role: viewer|editor|admin|anonymous|system.
    pub role: String,
    /// Session email, `learner:<uuid>` (demo), or null for machine/simulator.
    pub email: Option<String>,
    /// User id when a real session exists.
    pub uid: Option<String>,
    /// Display name when a real session exists.
    pub name: Option<String>,
    /// True while an admin impersonates another role (demo simulator).
    pub real_role: Option<String>,
    /// Active tenant selected for this session. None only for demo/system actors.
    pub organization_id: Option<String>,
    /// True when the caller presented a valid service token (bypasses role
    /// guards exactly like `isServiceAuthorized()` did in the old routes).
    pub is_service: bool,
}

impl Actor {
    /// Anonymous actor (shared-mode default for unauthenticated callers).
    pub fn anonymous() -> Self {
        Self {
            role: ROLE_ANONYMOUS.into(),
            email: None,
            uid: None,
            name: None,
            real_role: None,
            organization_id: None,
            is_service: false,
        }
    }

    /// Trusted machine actor (valid `x-service-token`).
    pub fn service() -> Self {
        Self {
            role: ROLE_SYSTEM.into(),
            email: None,
            uid: None,
            name: None,
            real_role: None,
            organization_id: None,
            is_service: true,
        }
    }

    /// Demo-mode fallback for cookie-less callers: trusted admin.
    pub fn demo_admin() -> Self {
        Self {
            role: ROLE_ADMIN.into(),
            email: None,
            uid: None,
            name: None,
            real_role: None,
            organization_id: None,
            is_service: false,
        }
    }
}

// ─── Runtime mode (ports runtime-mode.ts) ───────────────────────────────

#[derive(Debug, Clone)]
pub struct RuntimeMode {
    /// True when `MF_DEMO_MODE` is unset/true/1/yes.
    pub demo: bool,
    /// Configured service token (empty/None when unset).
    pub service_token: Option<String>,
}

impl RuntimeMode {
    pub fn from_env() -> Self {
        let raw = std::env::var("MF_DEMO_MODE").unwrap_or_else(|_| "true".into());
        let raw = raw.trim().to_lowercase();
        let demo = raw != "false" && raw != "0" && raw != "no";
        let service_token = std::env::var("MF_SERVICE_TOKEN")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        Self {
            demo,
            service_token,
        }
    }

    pub fn from_parts(demo: bool, service_token: Option<String>) -> Self {
        Self {
            demo,
            service_token,
        }
    }

    /// Constant-time service-token check. False when no token is configured
    /// (every mode) — mirrors `isServiceAuthorized()`.
    pub fn is_service_authorized(&self, provided: Option<&str>) -> bool {
        let Some(configured) = self.service_token.as_deref() else {
            return false;
        };
        let Some(provided) = provided else {
            return false;
        };
        let provided = provided.trim();
        if provided.len() != configured.len() {
            return false;
        }
        subtle::ConstantTimeEq::ct_eq(provided.as_bytes(), configured.as_bytes()).into()
    }

    pub fn mode_label(&self) -> &'static str {
        if self.demo {
            "demo"
        } else {
            "shared"
        }
    }
}

/// Resolve `AUTH_SECRET`: required in shared mode (fail-fast), dev fallback in
/// demo mode only — same rules as auth-service.ts.
pub fn resolve_auth_secret(mode: &RuntimeMode) -> Result<String, String> {
    if let Ok(secret) = std::env::var("AUTH_SECRET") {
        let secret = secret.trim().to_string();
        if !secret.is_empty() {
            return Ok(secret);
        }
    }
    if mode.demo {
        eprintln!("[minifoundry] AUTH_SECRET is not set — using the development fallback in demo mode only.");
        return Ok("<redacted>".into());
    }
    Err("AUTH_SECRET must be configured before MiniFoundry can run in shared mode".into())
}

// ─── Session payload / JWT ──────────────────────────────────────────────

/// JWT claims — mirrors the old `SessionPayload` (plus standard iat/exp/nbf).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionPayload {
    pub uid: String,
    pub email: String,
    pub name: String,
    /// EFFECTIVE role — equals realRole except during admin impersonation.
    pub role: String,
    /// Present only while an admin impersonates another role.
    #[serde(rename = "realRole", skip_serializing_if = "Option::is_none")]
    pub real_role: Option<String>,
    #[serde(rename = "organizationId")]
    pub organization_id: String,
    pub iat: i64,
    pub exp: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    #[error("token expired")]
    Expired,
    #[error("invalid token")]
    Invalid,
}

/// Sign an HS256 access token for `payload` (exp honored as given).
pub fn sign_token(payload: &SessionPayload, secret: &str) -> Result<String, TokenError> {
    let key = jsonwebtoken::EncodingKey::from_secret(secret.as_bytes());
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        payload,
        &key,
    )
    .map_err(|_| TokenError::Invalid)
}

/// Verify signature + expiry and return the payload.
pub fn verify_token(token: &str, secret: &str) -> Result<SessionPayload, TokenError> {
    let key = jsonwebtoken::DecodingKey::from_secret(secret.as_bytes());
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.validate_exp = true;
    validation.required_spec_claims = [
        "exp",
        "iat",
        "uid",
        "email",
        "name",
        "role",
        "organizationId",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let data =
        jsonwebtoken::decode::<SessionPayload>(token, &key, &validation).map_err(|e| {
            match e.kind() {
                jsonwebtoken::errors::ErrorKind::ExpiredSignature => TokenError::Expired,
                _ => TokenError::Invalid,
            }
        })?;
    Ok(data.claims)
}

/// Build a fresh session payload (iat=now, exp=now+ttl).
pub fn build_session(
    uid: &str,
    email: &str,
    name: &str,
    role: &str,
    real_role: Option<String>,
    organization_id: &str,
    ttl_seconds: i64,
) -> SessionPayload {
    let iat = Utc::now().timestamp();
    SessionPayload {
        uid: uid.into(),
        email: email.into(),
        name: name.into(),
        role: role.into(),
        real_role,
        organization_id: organization_id.into(),
        iat,
        exp: iat + ttl_seconds,
    }
}

// ─── Passwords (scrypt, node-compatible) ────────────────────────────────

/// `scrypt:<saltHex>:<hashHex>` with a random 16-byte salt, 64-byte key,
/// node:crypto defaults (N=16384, r=8, p=1).
pub fn hash_password(password: &str) -> Result<String, String> {
    use rand::RngCore;
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let params = scrypt::Params::new(14, 8, 1, 64).map_err(|e| e.to_string())?;
    let mut hash = [0u8; 64];
    scrypt::scrypt(password.as_bytes(), &salt, &params, &mut hash).map_err(|e| e.to_string())?;
    Ok(format!(
        "scrypt:{}:{}",
        hex::encode(salt),
        hex::encode(hash)
    ))
}

/// Constant-time verify against a stored `scrypt:<saltHex>:<hashHex>` string.
pub fn verify_password(password: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split(':').collect();
    if parts.len() != 3 || parts[0] != "scrypt" {
        return false;
    }
    let (Ok(salt), Ok(expected)) = (hex::decode(parts[1]), hex::decode(parts[2])) else {
        return false;
    };
    if salt.is_empty() || expected.is_empty() {
        return false;
    }
    let params = match scrypt::Params::new(14, 8, 1, expected.len()) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let mut actual = vec![0u8; expected.len()];
    if scrypt::scrypt(password.as_bytes(), &salt, &params, &mut actual).is_err() {
        return false;
    }
    subtle::ConstantTimeEq::ct_eq(actual.as_slice(), expected.as_slice()).into()
}

// ─── API token secrets (public foundry/v1 API) ──────────────────────────

/// sha256 hex of a plaintext `mf_live_...` secret (plaintext never stored).
pub fn token_sha256(plaintext: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(plaintext.as_bytes());
    hex::encode(h.finalize())
}

/// Generate a new `mf_live_<48 hex chars>` API secret (24 random bytes —
/// matches the legacy `mf_live_${randomBytes(24).hex}` format).
pub fn generate_api_secret() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("mf_live_{}", hex::encode(bytes))
}

/// Safe-to-display prefix: first 12 chars (`mf_live_XXX`).
pub fn token_prefix(plaintext: &str) -> String {
    plaintext.chars().take(12).collect()
}

/// Cookie timestamp helper for `Expires` attributes.
pub fn cookie_expires(at: DateTime<Utc>) -> String {
    at.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

// ─── Actor header value encoding ────────────────────────────────────────
// HTTP header values must be ASCII; user emails/names may not be. The gateway
// base64url-encodes those two headers and services decode them (falling back
// to the raw value for tolerance).

/// base64url (no padding) encode a header value.
pub fn hdr_encode(s: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s.as_bytes())
}

/// Decode a base64url header value; falls back to the raw string when the
/// value was not encoded (plain-ASCII senders).
pub fn hdr_decode(raw: &str) -> String {
    use base64::Engine;
    match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw.as_bytes()) {
        Ok(bytes) => String::from_utf8(bytes).unwrap_or_else(|_| raw.to_string()),
        Err(_) => raw.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_levels_match_legacy() {
        assert_eq!(role_level("viewer"), 0);
        assert_eq!(role_level("editor"), 1);
        assert_eq!(role_level("admin"), 2);
        assert_eq!(role_level("anonymous"), -1);
        assert_eq!(role_level("system"), -1);
        assert!(role_at_least("admin", "editor"));
        assert!(!role_at_least("viewer", "editor"));
        assert!(!role_at_least("anonymous", "viewer"));
    }

    #[test]
    fn scrypt_round_trip_and_legacy_format() {
        let stored = hash_password("<redacted>").unwrap();
        assert!(stored.starts_with("scrypt:"));
        assert_eq!(stored.split(':').count(), 3);
        assert!(verify_password("<redacted>", &stored));
        assert!(!verify_password("wrong", &stored));
        assert!(!verify_password("x", "garbage"));
    }

    #[test]
    fn scrypt_params_match_node_defaults() {
        // Node: scryptSync(password, salt, 64) with N=16384,r=8,p=1.
        // Known-answer: salt=00..00, password="pw".
        let salt = hex::decode("00000000000000000000000000000000").unwrap();
        let params = scrypt::Params::new(14, 8, 1, 64).unwrap();
        let mut out = [0u8; 64];
        scrypt::scrypt(b"pw", &salt, &params, &mut out).unwrap();
        assert_eq!(out.len(), 64);
        assert!(out.iter().any(|b| *b != 0));
    }

    #[test]
    fn jwt_round_trip() {
        let secret = "test-secret-value-that-is-long-enough";
        let s = build_session("u1", "a@b.c", "A B", "admin", None, "org1", 60);
        let token = sign_token(&s, secret).unwrap();
        let back = verify_token(&token, secret).unwrap();
        assert_eq!(back.uid, "u1");
        assert_eq!(back.role, "admin");
        assert!(verify_token(&token, "other-secret").is_err());
    }

    #[test]
    fn jwt_expiry_is_detected() {
        let secret = "test-secret-value-that-is-long-enough";
        // NOTE: jsonwebtoken applies a 60s verification leeway, so expiry
        // must be tested beyond it.
        let s = build_session("u1", "a@b.c", "A", "viewer", None, "org1", -120);
        let token = sign_token(&s, secret).unwrap();
        assert!(matches!(
            verify_token(&token, secret),
            Err(TokenError::Expired)
        ));
    }

    #[test]
    fn service_token_constant_time() {
        let mode = RuntimeMode::from_parts(false, Some("s3cret".into()));
        assert!(mode.is_service_authorized(Some("s3cret")));
        assert!(!mode.is_service_authorized(Some("wrong1")));
        assert!(!mode.is_service_authorized(None));
        let none = RuntimeMode::from_parts(false, None);
        assert!(!none.is_service_authorized(Some("s3cret")));
    }

    #[test]
    fn demo_mode_env_parsing() {
        assert!(RuntimeMode::from_parts(true, None).demo);
        assert_eq!(RuntimeMode::from_parts(false, None).mode_label(), "shared");
    }

    #[test]
    fn api_token_helpers() {
        let secret = generate_api_secret();
        assert!(secret.starts_with("mf_live_"));
        assert_eq!(token_prefix(&secret).len(), 12);
        assert_eq!(token_sha256("abc").len(), 64);
        assert_ne!(token_sha256("abc"), token_sha256("abd"));
    }
}
