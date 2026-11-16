# syntax=docker/dockerfile:1
# Multi-stage build: node (engine/ui/web) -> rust (backend) -> slim runtime.

# ---- 1. Frontend: engine, ui, web --------------------------------------------
FROM node:24-bookworm-slim AS web
WORKDIR /src
# Workspace manifests first for better layer caching.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/ui/package.json packages/ui/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm run build

# ---- 2. Backend ----------------------------------------------------------------
FROM rust:1-bookworm AS backend
WORKDIR /src/backend
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/migrations ./migrations
COPY backend/src ./src
RUN cargo build --release --locked

# ---- 3. Runtime ----------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 webgame \
    && useradd --system --uid 10001 --gid webgame --home-dir /app --shell /usr/sbin/nologin webgame \
    && mkdir -p /data /app \
    && chown webgame:webgame /data

WORKDIR /app
COPY --from=backend /src/backend/target/release/webgame-server /app/webgame-server
COPY --from=web /src/packages/engine/dist /app/engine
COPY --from=web /src/apps/web/dist /app/web

ENV PORT=8080 \
    DATA_DIR=/data \
    DATABASE_URL=sqlite:///data/webgame.db?mode=rwc \
    ENGINE_DIST=/app/engine \
    WEB_DIST=/app/web \
    RUST_LOG=info

VOLUME ["/data"]
EXPOSE 8080
USER webgame:webgame
# The binary checks itself (no curl in the image); it reads PORT like the server does.
HEALTHCHECK --interval=30s --timeout=6s --start-period=15s --retries=3     CMD ["/app/webgame-server", "healthcheck"]
# The server handles SIGTERM itself (graceful drain on `docker stop`).
STOPSIGNAL SIGTERM
CMD ["/app/webgame-server"]
