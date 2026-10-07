//! Set-Cookie builders shared by the auth service and the gateway
//! (transparent refresh). Mirrors the legacy `buildSetCookies` attribute set.

pub struct CookieSpec {
    pub name: &'static str,
    pub value: String,
    pub http_only: bool,
    pub same_site: &'static str,
    pub path: &'static str,
    pub max_age: i64,
    pub secure: bool,
}

impl CookieSpec {
    pub fn to_header(&self) -> String {
        let mut h = format!("{}={}", self.name, self.value);
        h.push_str(&format!("; Max-Age={}", self.max_age));
        h.push_str(&format!("; Path={}", self.path));
        h.push_str(&format!("; SameSite={}", self.same_site));
        if self.http_only {
            h.push_str("; HttpOnly");
        }
        if self.secure {
            h.push_str("; Secure");
        }
        h
    }
}

/// Access-JWT cookie (HttpOnly `foundry-session`).
pub fn session_cookie(value: String, secure: bool, max_age: i64) -> CookieSpec {
    CookieSpec {
        name: mf_auth::SESSION_COOKIE,
        value,
        http_only: true,
        same_site: "Lax",
        path: "/",
        max_age,
        secure,
    }
}

/// Refresh-token cookie (HttpOnly `foundry-refresh`).
pub fn refresh_cookie(value: String, secure: bool, max_age: i64) -> CookieSpec {
    CookieSpec {
        name: mf_auth::REFRESH_COOKIE,
        value,
        http_only: true,
        same_site: "Lax",
        path: "/",
        max_age,
        secure,
    }
}

/// Legacy JS-readable role cookie (`foundry-role`).
pub fn role_cookie(value: String, secure: bool, max_age: i64) -> CookieSpec {
    CookieSpec {
        name: mf_auth::LEGACY_ROLE_COOKIE,
        value,
        http_only: false,
        same_site: "Lax",
        path: "/",
        max_age,
        secure,
    }
}

/// Expired clone of a cookie (Max-Age=0) for logout.
pub fn expire(name: &'static str, secure: bool) -> CookieSpec {
    CookieSpec {
        name,
        value: String::new(),
        http_only: name != mf_auth::LEGACY_ROLE_COOKIE,
        same_site: "Lax",
        path: "/",
        max_age: 0,
        secure,
    }
}
