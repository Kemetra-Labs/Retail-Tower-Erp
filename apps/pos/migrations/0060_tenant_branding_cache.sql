-- RT-475 — the local tenant branding cache (spec 039 FR-31).
--
-- [GATED] approval: spec 039 (`services/backend-core/specs/039-tenant-logo-branding`,
-- owner-approved 2026-10-13) puts the POS branding cache in RT-475 as a local
-- migration with an §A2 record ("RT-475 — POS worker, cache (`0051`, §A2)",
-- §8; FR-31, FR-33). 0051 was taken by later work; 0060 is the next free
-- number. The RT-475 task brief (2026-11-01) carries it. No Backend-Core
-- contract change: the cache mirrors `posGetTenantBranding` (RT-473 S2).
--
-- ## Why
--
-- The POS shows the tenant logo on the boot, pairing, sign-in and lock screens,
-- offline. The read-down worker stores the last branding it read here; the
-- screens read only this cache, never the network (FR-36).
--
-- ## Shape (two records, each validated on its own, FR-31)
--
-- `tenant_branding_name` — one row at most (`id = 1`):
--   tenant_id, paired_at   the pairing the record was read under; a record
--                          from another pairing is ignored and purged (FR-32)
--   tenant_display_name    `tenants.name` (OD-10)
--   revision, etag         the branding revision and its FR-18 ETag, recomputed
--                          locally on every read (FR-35a)
--   logo_state             'present' or 'none' (`logo: null` from the server)
--
-- `tenant_branding_logo` — one row at most (`id = 1`), only when 'present':
--   version, revision, updated_at, card, warnings_json
--   renditions_json        the 8 screen renditions and the receipt rendition,
--                          base64 PNG, exactly as the server re-encoded them
--   payload_sha256         a local digest over the record (FR-31), recomputed
--                          on every read
--
-- One row per table: a new read replaces both rows in one transaction, so the
-- old renditions are deleted in the same write. No secret is stored: the
-- tenant name and the logo are shown on screen and printed on receipts.
-- Nothing here is sent to Backend-Core.
--
-- ## §A2 migration safety
--
--   • Additive only: two new tables, IF NOT EXISTS, shipped empty. No existing
--     table, column, index or trigger is touched; no backfill.
--   • The CHECKs keep each row well-formed; deeper validation (ETag, digest,
--     PNG header) runs in main on read, and a failing record is deleted.
--   • The runner applies it in its per-file transaction, after the RT-320
--     pre-migration snapshot of the live database.
--
-- ## Rollback
--
-- Downgrades are unsupported. A pre-0060 build refuses a database that lists
-- 0060 as applied (`SchemaAheadError`, RT-320). The cache is disposable: an
-- empty cache shows today's screens and the next read fills it again.

CREATE TABLE IF NOT EXISTS tenant_branding_name (
  id                   INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  tenant_id            TEXT    NOT NULL CHECK (length(tenant_id) > 0),
  paired_at            INTEGER NOT NULL,
  tenant_display_name  TEXT    NOT NULL,
  revision             INTEGER NOT NULL CHECK (revision >= 0),
  etag                 TEXT    NOT NULL,
  logo_state           TEXT    NOT NULL CHECK (logo_state IN ('present', 'none')),
  fetched_at           TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_branding_logo (
  id               INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  tenant_id        TEXT    NOT NULL CHECK (length(tenant_id) > 0),
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  version          TEXT    NOT NULL CHECK (length(version) = 64),
  updated_at       TEXT    NOT NULL,
  card             INTEGER NOT NULL CHECK (card IN (0, 1)),
  warnings_json    TEXT    NOT NULL,
  renditions_json  TEXT    NOT NULL,
  payload_sha256   TEXT    NOT NULL CHECK (length(payload_sha256) = 64)
);
