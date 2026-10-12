//! Shared service state. public-api is STATELESS: no database, no migrations
//! — token identity/rate limits come from the auth service's internal API,
//! data from the owning services, usage logs go out as mf.apiusage events.

use crate::fanout::FanOut;

#[derive(Clone)]
pub struct AppState {
    pub nats: async_nats::Client,
    pub auth: FanOut,
    pub catalog: FanOut,
    pub orchestration: FanOut,
    pub ontology: FanOut,
    pub governance: FanOut,
}

impl AppState {
    pub fn from_env(nats: async_nats::Client) -> Self {
        Self {
            nats,
            auth: FanOut::from_env("auth", "AUTH_INTERNAL_URL", 8081),
            catalog: FanOut::from_env("catalog", "CATALOG_INTERNAL_URL", 8082),
            orchestration: FanOut::from_env("orchestration", "ORCHESTRATION_INTERNAL_URL", 8083),
            ontology: FanOut::from_env("ontology", "ONTOLOGY_INTERNAL_URL", 8085),
            governance: FanOut::from_env("governance", "GOVERNANCE_INTERNAL_URL", 8086),
        }
    }
}
