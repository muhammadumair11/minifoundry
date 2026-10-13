//! Immutable connection settings keep concurrent tenants isolated, including
//! transactions and reacquired pool connections. Never SET a tenant on a
//! connection borrowed from the shared worker pool.
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone)]
pub struct TenantPools {
    base: PgPool,
    pools: Arc<Mutex<VecDeque<(String, PgPool)>>>,
}

pub fn valid_organization_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

impl TenantPools {
    pub fn new(base: &PgPool) -> Self {
        Self {
            base: base.clone(),
            pools: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    pub fn pool(&self, organization: &str) -> Result<PgPool, sqlx::Error> {
        if !valid_organization_id(organization) {
            return Err(sqlx::Error::Protocol("invalid organization scope".into()));
        }
        let mut pools = self.pools.lock().expect("tenant pool cache");
        if let Some(index) = pools.iter().position(|(id, _)| id == organization) {
            let entry = pools.remove(index).unwrap();
            let pool = entry.1.clone();
            pools.push_back(entry);
            return Ok(pool);
        }
        let opts = (*self.base.connect_options())
            .clone()
            .options([("mf.organization_id", organization)]);
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .min_connections(0)
            .idle_timeout(Duration::from_secs(20))
            .acquire_timeout(Duration::from_secs(10))
            .connect_lazy_with(opts);
        // Eviction drops the cache's handle; ongoing requests retain their own.
        if pools.len() >= 16 {
            pools.pop_front();
        }
        pools.push_back((organization.to_owned(), pool.clone()));
        Ok(pool)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn tenant_pools_keep_immutable_connection_scopes() {
        let base = PgPoolOptions::new()
            .connect_lazy("postgres://u:p@localhost/db")
            .unwrap();
        let tenants = TenantPools::new(&base);
        let first = tenants.pool("org_a").unwrap();
        let second = tenants.pool("org_b").unwrap();
        let first_options = first.connect_options().get_options().unwrap().to_owned();
        let second_options = second.connect_options().get_options().unwrap().to_owned();
        assert!(first_options.contains("org_a"));
        assert!(!first_options.contains("org_b"));
        assert!(second_options.contains("org_b"));
        assert_eq!(
            first_options,
            tenants
                .pool("org_a")
                .unwrap()
                .connect_options()
                .get_options()
                .unwrap()
        );
        assert!(tenants.pool("*").is_err());
    }
    #[test]
    fn rejects_worker_scope_and_connection_option_injection() {
        for value in ["", "*", "org -crole=postgres", "org;RESET ALL", "org/a"] {
            assert!(!valid_organization_id(value));
        }
        assert!(valid_organization_id("org_demo"));
        assert!(valid_organization_id("019abc-123"));
    }
}
