# Backend-Core production image — multi-stage build for a pnpm workspace.
#
# Targets:
#   - api      : NestJS HTTP API (node dist/main.js), listens PORT(3000) + METRICS_PORT(9464)
#   - worker   : standalone BullMQ consumer (no HTTP server)
#   - migrate  : one-shot DB migration CLI (packages/db -> node dist/cli/migrate.js up)
#
# Build a specific target with:  docker build --target api -t dp2-api .
# Compose builds all three via per-service `target:` (see docker-compose.prod.yml).
#
# glibc (bookworm-slim), NOT alpine: pg + NestJS native deps are more reliable on glibc.

# ---- base: node 24 LTS (digest-pinned) + pnpm via corepack ------------------------------------
FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
# pnpm deploy needs workspace packages injected so internal deps (@data-pulse-2/*)
# are bundled into the pruned output rather than left as unresolved workspace links.
ENV npm_config_inject_workspace_packages=true
# RT-1615: CVE-2025-6020 (and CVE-2024-22365), Debian DLA-4941-1. The pinned base digest ships
# libpam 1.5.2-6+deb12u2; install exactly the four PAM packages it contains at the fixed
# 1.5.2-6+deb12u3, and nothing else. Reproducible source: one fixed snapshot.debian.org timestamp
# of bookworm-security (the archive run that first published +deb12u3), read as the ONLY apt source
# (SourceList override + SourceParts=-, so live deb.debian.org is never consulted). Integrity:
# InRelease signature checked against the base image's debian-archive-keyring (signed-by; never
# trusted=yes), then Packages and .deb SHA256 by apt. check-valid-until=no only skips the
# snapshot's expiry date (Valid-Until 2026-12-03), not the signature. Plain http because the base
# has no ca-certificates and adding it would change more than PAM. No --allow-downgrades: if a
# future base digest carries a newer PAM, this step fails the build and must be removed; if it
# carries exactly +deb12u3, this step is a silent no-op, so removal is tracked on RT-1615.
# Remove this RUN when the upstream node:24-bookworm-slim digest itself carries +deb12u3.
RUN echo 'deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian-security/20261126T194341Z bookworm-security main' > /tmp/rt1615-pam.list \
    && APT_OPTS='-o Dir::Etc::SourceList=/tmp/rt1615-pam.list -o Dir::Etc::SourceParts=- -o Acquire::Retries=5' \
    && apt-get $APT_OPTS update \
    && DEBIAN_FRONTEND=noninteractive apt-get $APT_OPTS install -y --no-install-recommends \
        libpam0g=1.5.2-6+deb12u3 \
        libpam-modules=1.5.2-6+deb12u3 \
        libpam-modules-bin=1.5.2-6+deb12u3 \
        libpam-runtime=1.5.2-6+deb12u3 \
    && rm -f /tmp/rt1615-pam.list \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb /var/cache/apt/*.bin \
        /var/log/apt/* /var/log/dpkg.log /var/cache/debconf/*-old
RUN corepack enable
WORKDIR /repo

# ---- build: install full workspace, compile, prune per-app --------------------
FROM base AS build
# lockfile + workspace manifest + shared tsconfig first for better layer caching.
# tsconfig.base.json is REQUIRED: every package extends ../../tsconfig.base.json
# (it carries skipLibCheck + shared compiler options). Omitting it makes every
# package's `extends` resolve to a missing file, silently dropping skipLibCheck
# and breaking `tsc` on transitive .d.ts of third-party dependencies.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
# compile every workspace package (tsc -> dist/)
RUN pnpm -r run build
# produce self-contained, prod-only bundles for each runtime target
# workspace deps resolved via npm_config_inject_workspace_packages (set in base);
# pnpm 9.15 `deploy` has no --legacy flag — the env handles injection.
RUN pnpm --filter=@data-pulse-2/api    deploy --prod /out/api
RUN pnpm --filter=@data-pulse-2/worker deploy --prod /out/worker
RUN pnpm --filter=@data-pulse-2/db     deploy --prod /out/db

# ---- api runtime --------------------------------------------------------------
FROM base AS api
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
# The OpenAPI loader resolves contracts relative to the monorepo layout:
#   /app/dist/openapi/loader.js -> ../../../../packages/contracts/openapi == /packages/contracts/openapi
# The pruned bundle has no such tree, so place the static contract YAMLs there.
COPY --from=build --chown=node:node /repo/packages/contracts/openapi /packages/contracts/openapi
# The migration-status gauge (app.module.ts countMigrationFiles) reads the drizzle
# SQL dir; without it the pruned image reports db_migration_status pending forever.
# Ship the migrations and point DB_MIGRATIONS_DIR at them (set in compose).
COPY --from=build --chown=node:node /repo/packages/db/drizzle /packages/db/drizzle
ENV NODE_ENV=production
USER node
# 3000 = HTTP API, 9464 = Prometheus metrics (also used as the liveness probe)
EXPOSE 3000 9464
CMD ["node", "dist/main.js"]

# ---- worker runtime -----------------------------------------------------------
FROM base AS worker
WORKDIR /app
COPY --from=build --chown=node:node /out/worker ./
ENV NODE_ENV=production
USER node
CMD ["node", "dist/main.js"]

# ---- migrate (one-shot) -------------------------------------------------------
FROM base AS migrate
WORKDIR /app
COPY --from=build --chown=node:node /out/db ./
ENV NODE_ENV=production
USER node
# migrations resolved relative to the bundled db package
CMD ["node", "dist/cli/migrate.js", "up"]
