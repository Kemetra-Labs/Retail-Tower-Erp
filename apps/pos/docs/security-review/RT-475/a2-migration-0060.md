<!--
RT-475 — §A2 migration-safety record for migration 0060_tenant_branding_cache
(spec 039 FR-31). Written with the implementation, before merge.
-->

# §A2: Migration safety for `0060_tenant_branding_cache` (RT-475)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-475: POS tenant logo read-down, offline cache and slots |
| Gate | §A2, migration safety (`[GATED]`) |
| Migration | `migrations/0060_tenant_branding_cache.sql` |
| Approval | Spec 039 (owner-approved 2026-10-13) puts this cache in RT-475 as a local migration with an §A2 record (§8: "RT-475 — POS worker, cache (`0051`, §A2)"; FR-31, FR-33). The RT-475 task brief of 2026-11-01 carries it. 0051 was taken by later work, so it lands as 0060. **The owner should confirm this reading at review.** |
| Baseline | `origin/main` at `3fe42b60` |
| Prepared by | The implementation agent (Claude Code), 2026-11-01. **Not an independent review.** |
| Verdict | **Agent-assessed PASS.** Additive only: two new tables, empty, and nothing existing touched. |

## 2. What it changes

| Change | Kind | Notes |
| :-- | :-- | :-- |
| `tenant_branding_name` | New table, at most one row (`id = 1`) | `tenant_id`, `paired_at`, `tenant_display_name`, `revision`, `etag`, `logo_state IN ('present','none')`, `fetched_at` |
| `tenant_branding_logo` | New table, at most one row (`id = 1`) | `tenant_id`, `revision ≥ 1`, `version` (64 hex), `updated_at`, `card IN (0,1)`, `warnings_json`, `renditions_json`, `payload_sha256` (64 hex) |

The cache keeps one row per table on purpose. A new read deletes both rows and writes the new ones in one transaction (`branding-cache.ts` `replace`), so the old renditions never outlive a version change (Jira acceptance criterion, tested).

It is a table pair of its own, not columns on `terminal_assignment`. A re-pair rewrites that row (`INSERT OR REPLACE`), and the isolation rule has to be explicit and tested rather than a side effect.

## 3. Controls

| # | Control | Evidence | Result |
| :-- | :-- | :-- | :-- |
| A2-1 | **Additive only.** | Two `CREATE TABLE IF NOT EXISTS` statements. No `ALTER`, `DROP`, `UPDATE` or `DELETE` (test). | PASS |
| A2-2 | **Ships empty; no backfill.** | Test "ships empty". An empty cache shows today's screens; the worker fills it on its first read. | PASS |
| A2-3 | **Constraints hold.** | A second row, an unknown `logo_state`, an empty tenant, a logo at revision 0, a short version and `card = 2` are all refused (test). | PASS |
| A2-4 | **Runs inside the runner's transaction.** | No `PRAGMA` and no statement that cannot run in a transaction. Applied once by the real runner (test). | PASS |
| A2-5 | **No secret, no PII.** | The tenant's display name and logo appear on screen and on receipts anyway. No token, credential or customer data is stored. | PASS |
| A2-6 | **Corruption is contained.** | Each record is validated on every read: the ETag recomputed (FR-18), the records cross-checked, the PNG header checked, and the local digest recomputed (FR-35a). A failing record is deleted, and the next network read is unconditional (tests). | PASS |

## 4. Rollback

Downgrades are unsupported. A pre-0060 build refuses a database that lists 0060 as applied (`SchemaAheadError`, RT-320). The cache is disposable: dropping both tables loses only the cached logo, which the next read restores.
