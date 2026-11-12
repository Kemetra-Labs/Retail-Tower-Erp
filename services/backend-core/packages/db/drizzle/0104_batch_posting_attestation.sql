-- 0104_batch_posting_attestation.sql
--
-- The owner attestation of the ERP batch posting (Jira RT-452; the RT-50 Q13
-- precondition `erp_batch_posting_verified`). [GATED] migration, authorized by
-- the owner in chat on 2026-11-12: for `erp_batch_posting_verified` the owner
-- chose "Owner attestation", then "Okay, fire child sessions ... And tell them
-- to validate with you as you is Opus. Okay, and merge authorized. And turn on
-- autofix for all PRs. Go." Applying this migration to a lab or live database
-- is a separate owner step.
--
-- Why a column set and not a computed signal: the evidence that the
-- ERPNext-Connector posts batch-tracked lines with their batch reference is a
-- bench run (RT-452), which this server cannot read. The owner attests it, once,
-- with a reference to that evidence, through the operator CLI
-- `inventory-effects attest-batch-posting` (the same transaction and tenant
-- rules as `activate`).
--
-- Adds THREE nullable columns to `tenant_inventory_settings`:
--
--   erp_batch_posting_attested_at    when the owner attested; NULL = not attested
--   erp_batch_posting_attested_by    the operator user id who recorded it
--   erp_batch_posting_evidence_ref   the reference to the evidence (a Jira
--                                    comment, a bench run id); at most 200
--                                    characters, never blank when set
--
-- Two CHECKs: the three are all NULL or all set, and the evidence reference is
-- non-blank and at most 200 characters.
--
-- Nothing in this migration attests anything: after it, every tenant reads as
-- not attested, so `erp_batch_posting_verified` stays unmet for every tenant.
--
-- ADDITIVE: no existing row, policy or constraint changes. RLS is the existing
-- tenant policy on `tenant_inventory_settings` (ENABLE + FORCE, 0056). No new
-- table, so NO new grant: the domain role already holds SELECT, INSERT and
-- UPDATE on it (apps/api/src/auth/grants/baseline.grants.ts).
--
-- Lock: ACCESS EXCLUSIVE on `tenant_inventory_settings` for the length of the
-- statements. Nullable columns without a default are catalog-only (no rewrite);
-- the table holds one row per tenant, so the CHECK validation is immediate.
--
-- Deploy coupling: the API reads the attested-at column with raw SQL, and the
-- CLI writes the three. Apply 0104 before the API that reads it is rolled
-- (migrate is step 1 of every release).
--
-- DATA-LIFECYCLE CLASSIFICATION (§XIV): BUSINESS-CLASS. A timestamp, an
-- operator UUID and a short evidence reference per tenant. No PII, no money.
--
-- Reversal: 0104_batch_posting_attestation.down.sql REFUSES while any tenant
-- holds an attestation (the down would discard the owner's record); otherwise
-- it drops ONLY these three columns and their two constraints.

BEGIN;

ALTER TABLE tenant_inventory_settings
  ADD COLUMN IF NOT EXISTS erp_batch_posting_attested_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS erp_batch_posting_attested_by  UUID,
  ADD COLUMN IF NOT EXISTS erp_batch_posting_evidence_ref TEXT;

ALTER TABLE tenant_inventory_settings
  ADD CONSTRAINT tenant_inventory_settings_batch_posting_attest_together
    CHECK ((erp_batch_posting_attested_at IS NULL) = (erp_batch_posting_attested_by IS NULL)
       AND (erp_batch_posting_attested_at IS NULL) = (erp_batch_posting_evidence_ref IS NULL)),
  ADD CONSTRAINT tenant_inventory_settings_batch_posting_evidence_ref
    CHECK (erp_batch_posting_evidence_ref IS NULL
       OR (btrim(erp_batch_posting_evidence_ref) <> '' AND char_length(erp_batch_posting_evidence_ref) <= 200));

COMMIT;
