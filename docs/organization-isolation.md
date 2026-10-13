# Organization isolation

Catalog, Orchestration, Compute, Ontology and Governance domain tables carry `organization_id`. Forced PostgreSQL row policies apply to the service's table owner. Reads and updates cannot cross the active organization, and inserts use the connection's organization. Composite foreign keys prevent cross-organization parent bindings; resource names are unique within an organization.

The gateway resolves active membership on each authenticated request, strips inbound identity headers and supplies the organization from that membership. A machine request must authenticate with the service token to choose an explicit organization. Domain handlers reject missing or wildcard organization context in shared mode. Anonymous demo requests use `org_demo`.

Handlers use `mf_web::TenantState` to clone service state with an immutable tenant database pool. Connections carry their organization in startup options and are never reassigned between organizations. Each service caches up to 16 organization pools, with at most two connections per pool and a 20-second idle timeout. Account for these bounds when configuring PostgreSQL capacity.

Startup and trusted worker claim/scheduler queries use a separate wildcard pool that is never exposed to request handlers. Workers switch to the stored job or schedule organization before reading inputs or writing outputs. Internal HTTP fan-out and NATS events retain organization context through task-local scope; consumers select an organization pool before applying an event. Events without organization attribution are skipped.

API-token verification returns the token's stored organization, which scopes public API requests independently of browser identity or caller-supplied headers. Authentication counts and reset operations use explicit organization predicates. Browser token storage is partitioned by user and organization.

Legacy domain rows without ownership migrate to `org_demo`. The reset CLI preserves SQLx migration ledgers. Applied SQL migrations must retain their original bytes and LF line endings to preserve checksums.

See [testing](testing.md) for row-policy tests and the integration journey covering requests, background work, tokens and scoped resets.
