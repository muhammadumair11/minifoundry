use crate::ApiError;
use axum::{
    extract::{FromRequestParts, Request},
    http::request::Parts,
    middleware::Next,
    response::Response,
};

pub trait TenantService: Clone + Send + Sync {
    fn tenant_pools(&self) -> &mf_db::TenantPools;
    fn demo_mode(&self) -> bool;
    fn with_database(&self, db: sqlx::PgPool) -> Self;
    fn for_organization(&self, organization: &str) -> Result<Self, sqlx::Error> {
        Ok(self.with_database(self.tenant_pools().pool(organization)?))
    }
}

pub struct TenantState<S>(pub S);

impl<S: TenantService> FromRequestParts<S> for TenantState<S> {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let organization = parts
            .headers
            .get("x-mf-organization-id")
            .and_then(|v| v.to_str().ok())
            .or_else(|| state.demo_mode().then_some("org_demo"))
            .ok_or_else(|| ApiError::forbidden("organization context required"))?;
        if !mf_db::valid_organization_id(organization) {
            return Err(ApiError::forbidden("invalid organization context"));
        }
        Ok(Self(state.for_organization(organization)?))
    }
}

pub async fn organization_context(request: Request, next: Next) -> Response {
    let organization = request
        .headers()
        .get("x-mf-organization-id")
        .and_then(|v| v.to_str().ok())
        .filter(|id| mf_db::valid_organization_id(id))
        .map(str::to_owned)
        .or_else(|| {
            mf_auth::RuntimeMode::from_env()
                .demo
                .then(|| "org_demo".to_owned())
        });
    mf_events::with_organization(organization, next.run(request)).await
}
