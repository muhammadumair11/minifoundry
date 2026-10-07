# syntax=docker/dockerfile:1
# MiniFoundry backend — one workspace build, per-service final stages.
#
#   docker build --target gateway  -t mf-gateway  .
#   docker build --target auth     -t mf-auth     .
#   ... (compose does this for every service)
#
# cargo-chef caches dependency compilation across source-only changes.

# ─── chef: recipe (dependency graph) ────────────────────────────────────
FROM rust:1-bookworm AS chef
RUN cargo install cargo-chef --locked
WORKDIR /app
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# ─── builder: cook dependencies, then build the workspace ───────────────
FROM chef AS builder
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --release --workspace

# ─── runtime base ────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 mf
WORKDIR /app
USER mf

# ─── compute runtime adds Python 3 (workbook execution parity) ───────────
FROM runtime AS compute-runtime
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*
USER mf

# ─── per-service images ──────────────────────────────────────────────────
FROM runtime AS gateway
COPY --from=builder /app/target/release/mf-gateway /usr/local/bin/mf-service
ENV PORT=8080
EXPOSE 8080
CMD ["mf-service"]

FROM runtime AS auth
COPY --from=builder /app/target/release/mf-auth-service /usr/local/bin/mf-service
ENV PORT=8081
EXPOSE 8081
CMD ["mf-service"]

FROM runtime AS catalog
COPY --from=builder /app/target/release/mf-catalog /usr/local/bin/mf-service
ENV PORT=8082
EXPOSE 8082
CMD ["mf-service"]

FROM runtime AS orchestration
COPY --from=builder /app/target/release/mf-orchestration /usr/local/bin/mf-service
ENV PORT=8083
EXPOSE 8083
CMD ["mf-service"]

FROM compute-runtime AS compute
COPY --from=builder /app/target/release/mf-compute /usr/local/bin/mf-service
ENV PORT=8084
EXPOSE 8084
CMD ["mf-service"]

FROM runtime AS ontology
COPY --from=builder /app/target/release/mf-ontology /usr/local/bin/mf-service
ENV PORT=8085
EXPOSE 8085
CMD ["mf-service"]

FROM runtime AS governance
COPY --from=builder /app/target/release/mf-governance /usr/local/bin/mf-service
ENV PORT=8086
EXPOSE 8086
CMD ["mf-service"]

FROM runtime AS public-api
COPY --from=builder /app/target/release/mf-public-api /usr/local/bin/mf-service
ENV PORT=8087
EXPOSE 8087
CMD ["mf-service"]

# ─── seed CLI (one-shot tool) ────────────────────────────────────────────
FROM runtime AS seed
COPY --from=builder /app/target/release/mf-seed /usr/local/bin/mf-seed
ENTRYPOINT ["mf-seed"]
CMD ["all"]
