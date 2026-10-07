//! /api/session + /api/session/role — governance role introspection and the
//! demo simulator / admin impersonation switch (ports of the legacy routes).

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use mf_web::{actor_from_headers, json_ok, require_role, ApiError, ApiResult};

use crate::audit::{self, AuditOptions};
use crate::cookies;
use crate::routes::{as_object, parse_body, req_enum, with_cookies};
use crate::state::{AppState, UserRow};
use crate::tokens_common::{build_access_token, refresh_ttl};

const ROLES: &[&str] = &["viewer", "editor", "admin"];

/// GET /api/session — current governance role + real session identity.
/// `role` is the EFFECTIVE role (gateway-resolved, simulator-aware);
/// `session` is null for simulator/anonymous callers.
pub async fn get_session(
    State(_state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let actor = actor_from_headers(&headers);
    let session = match (&actor.uid, &actor.email) {
        (Some(_), Some(email)) => {
            let real_role = actor
                .real_role
                .clone()
                .unwrap_or_else(|| actor.role.clone());
            let impersonating =
                actor.real_role.is_some() && actor.real_role.as_deref() != Some(&actor.role);
            serde_json::json!({
                "email": email,
                "name": actor.name,
                "role": real_role,
                "effectiveRole": actor.role,
                "impersonating": impersonating,
            })
        }
        _ => serde_json::Value::Null,
    };
    Ok(json_ok(
        serde_json::json!({ "role": actor.role, "session": session }),
    ))
}

/// POST /api/session/role — switch the active governance role.
/// Real sessions: admins only; the access JWT is re-issued with the effective
/// role (session-carried impersonation). Anonymous (demo): simulator cookie.
pub async fn set_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let v = parse_body(&body)?;
    let m = as_object(v)?;
    let target = req_enum(&m, "role", ROLES)?;

    let actor = actor_from_headers(&headers);
    let resp = json_ok(serde_json::json!({ "role": target }));

    if actor.uid.is_some() {
        // Real session: true admins only (an impersonating admin may restore).
        let real_role = actor
            .real_role
            .clone()
            .unwrap_or_else(|| actor.role.clone());
        if real_role != "admin" {
            return Err(ApiError::forbidden("only admin users can switch roles"));
        }

        let mut specs = Vec::new();
        if target != actor.role {
            // Re-issue the access token with the new effective role.
            let user = UserRow {
                id: actor.uid.clone().unwrap_or_default(),
                email: actor.email.clone().unwrap_or_default(),
                name: actor.name.clone().unwrap_or_default(),
                role: real_role.clone(),
                password_hash: String::new(),
                is_active: true,
                last_login_at: None,
                created_at: mf_db::now(),
            };
            let (_payload, access) = build_access_token(&state, &user, Some(target))?;
            specs.push(cookies::session_cookie(
                access,
                state.cookie_secure,
                crate::tokens_common::access_ttl(),
            ));
            // Persist the override on the live refresh token(s) so the
            // impersonation survives access-token refreshes (legacy sessions
            // carried it for their whole TTL).
            if let Some(rt) = crate::routes::get_cookie(&headers, mf_auth::REFRESH_COOKIE) {
                use sha2::{Digest, Sha256};
                let hash = hex::encode(Sha256::digest(rt.as_bytes()));
                let override_or_null: Option<&str> = if target == real_role {
                    None
                } else {
                    Some(target)
                };
                let _ = sqlx::query(
                    "UPDATE refresh_tokens SET impersonated_role = $1 \
                     WHERE token_hash = $2 AND revoked_at IS NULL",
                )
                .bind(override_or_null)
                .bind(&hash)
                .execute(&state.db)
                .await;
            }
        }
        // Legacy cookie follows the EFFECTIVE role so JS-readable state agrees.
        specs.push(cookies::role_cookie(
            target.to_string(),
            state.cookie_secure,
            refresh_ttl(),
        ));

        let impersonated = if target != real_role { "yes" } else { "no" };
        let detail = format!("role={target} impersonated={impersonated}");
        audit::audit(
            &state,
            &actor,
            AuditOptions::new("session.role_switch", "user")
                .actor_role(target)
                .resource_id(actor.uid.as_deref())
                .detail(Some(&detail)),
        )
        .await;

        return Ok(with_cookies(resp, specs));
    }

    // Anonymous demo mode — simulator cookie only (legacy branch keeps this
    // cookie non-secure and JS-readable).
    let spec = cookies::role_cookie(target.to_string(), false, refresh_ttl());

    audit::audit(
        &state,
        &actor,
        AuditOptions::new("session.role_switch", "user")
            .detail(Some(&format!("role={target} simulator=yes"))),
    )
    .await;

    Ok(with_cookies(resp, vec![spec]))
}

/// require_role re-export guard used by the router wiring test.
#[allow(dead_code)]
fn _assert_guard_exists(a: &mf_auth::Actor) -> Result<(), ApiError> {
    require_role(a, "admin")
}
