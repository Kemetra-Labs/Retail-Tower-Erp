-- 0136_erp_credential_rotation.sql — Jira RT-1362 S2, `[GATED: migration]`, the first of six migrations
-- (0136-0141) holding the storage of overlap credential rotation.
-- Owner authorization: RT-1362 comment 19102 (S2 `[GATED: migration]` approved, a partial unique index
-- for rotate idempotency chosen over a lock) and comment 19107 (OVERLAP rotation: the
-- one-unrevoked-credential index change is covered by that decision). Contract: provisioning-feed.yaml
-- 1.2.0-draft, "Credential rotation" (merged by #932, RT-1362 S1).
--
-- The six files, each short and on its own table:
--   0136 (this)  erp_provisioning_request: routed host + trigger columns, rotation shape CHECK;
--                connector_registration: the adopted registration's provisioner host binding.
--   0137         CONCURRENTLY: at most one OPEN credential.rotate per registration.
--   0138         CONCURRENTLY: the (id, tenant, registration, kind) unique key the pending FK targets.
--   0139         auth_tokens: the pending marker (request id + kind discriminator), its FK and CHECK.
--   0140/0141    CONCURRENTLY: at most one CURRENT / at most one PENDING unrevoked connector credential.
-- The 0021 one-unrevoked-credential index `uq_auth_tokens_active_connector_credential` is NOT dropped in
-- this set (RT-1362 coordinator decision on #938): while it exists a pending credential next to a current
-- one is refused, so overlap writes stay impossible until a later PR teaches the readers (the status
-- reader, the legacy re-issue) about two unrevoked credentials and drops it.
--
-- DDL only, no backfill: every new column starts NULL on every row and stays NULL until the S2 runtime
-- writes it, so no FORCE-RLS backfill is involved.
--
--   1. erp_provisioning_request.routed_host_label + rotation_trigger: a `credential.rotate` request is
--      routed to ONE ERP host label (contract "Which host"), which a platform admin's correction of a
--      provisional adopted binding may change while the request is open (so it is not the frozen
--      `provisioned_host_label`, which 0112's CHECK also allows only on `succeeded`), and it records
--      what created it (`forced`: rotate-now; `scheduled`: the 14-day scheduler), the response's
--      `trigger`. Both are present exactly on `credential.rotate` rows, which also always name their
--      registration (CHECK `erp_provisioning_request_rotation_shape`). Nothing creates such a row yet.
--
--   2. connector_registration.provisioner_host_label / provisioner_host_binding /
--      provisioner_host_binding_revision: the provisioner host of an ADOPTED registration (RT-1557),
--      which has no succeeded `tenant.provision` to name its host. All three NULL (no binding: every
--      existing row) or all three set: `provisional` until the first credential call of a rotation
--      routed to it confirms it, then `confirmed`; the revision starts at 1 and increments on every
--      correction (contract `hostBindingRevision`, minimum 1). The label has the
--      `erp_provisioner_credential.host_label` shape.
--
-- BUSINESS-class: host labels, enum tokens and a counter. NO secret, NO hash, NO PII, NO money.
--
-- No new table, policy or grant: the runtime role already holds table-level grants on both tables
-- (docs/operations/sql/*-domain-grants.sql), and the existing policies cover the new columns.
--
-- Lock discipline (the 0109 pattern): one short transaction PER TABLE under lock_timeout 2s, every CHECK
-- added NOT VALID; each VALIDATE in its own transaction under SHARE UPDATE EXCLUSIVE, so reads and writes
-- continue while it scans. No index is built here (0137 and 0138 build theirs CONCURRENTLY).
--
-- Re-runnable: if a later transaction of this file fails (for example a VALIDATE hitting the 2s lock
-- timeout), the runner records nothing and the whole file runs again: every ADD COLUMN is IF NOT EXISTS
-- and every CHECK is preceded by DROP CONSTRAINT IF EXISTS.
--
-- Rollback: 0136_erp_credential_rotation.down.sql, after 0141 to 0137 down. It refuses while any
-- `credential.rotate` request or any provisioner host binding exists.

-- 1. erp_provisioning_request: routing and trigger of a credential.rotate ---
BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE erp_provisioning_request ADD COLUMN IF NOT EXISTS routed_host_label TEXT;
ALTER TABLE erp_provisioning_request ADD COLUMN IF NOT EXISTS rotation_trigger TEXT;

ALTER TABLE erp_provisioning_request DROP CONSTRAINT IF EXISTS erp_provisioning_request_rotation_shape;
ALTER TABLE erp_provisioning_request
  ADD CONSTRAINT erp_provisioning_request_rotation_shape
    CHECK ((kind = 'credential.rotate') = (routed_host_label IS NOT NULL)
           AND (kind = 'credential.rotate') = (rotation_trigger IS NOT NULL)
           AND (kind <> 'credential.rotate' OR connector_registration_id IS NOT NULL)
           AND (routed_host_label IS NULL
                OR (routed_host_label ~ '^[a-z0-9][a-z0-9-]*$' AND length(routed_host_label) <= 64))
           AND (rotation_trigger IS NULL OR rotation_trigger IN ('forced', 'scheduled')))
    NOT VALID;

COMMIT;

-- 2. connector_registration: the adopted registration's provisioner host ----
BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE connector_registration ADD COLUMN IF NOT EXISTS provisioner_host_label TEXT;
ALTER TABLE connector_registration ADD COLUMN IF NOT EXISTS provisioner_host_binding TEXT;
ALTER TABLE connector_registration ADD COLUMN IF NOT EXISTS provisioner_host_binding_revision INTEGER;

ALTER TABLE connector_registration DROP CONSTRAINT IF EXISTS connector_registration_provisioner_host_binding_valid;
ALTER TABLE connector_registration
  ADD CONSTRAINT connector_registration_provisioner_host_binding_valid
    CHECK ((provisioner_host_label IS NULL) = (provisioner_host_binding IS NULL)
           AND (provisioner_host_label IS NULL) = (provisioner_host_binding_revision IS NULL)
           AND (provisioner_host_label IS NULL
                OR (provisioner_host_label ~ '^[a-z0-9][a-z0-9-]*$' AND length(provisioner_host_label) <= 64))
           AND (provisioner_host_binding IS NULL OR provisioner_host_binding IN ('provisional', 'confirmed'))
           AND (provisioner_host_binding_revision IS NULL OR provisioner_host_binding_revision >= 1))
    NOT VALID;

COMMIT;

-- Each VALIDATE in its own transaction (SHARE UPDATE EXCLUSIVE: reads and writes continue).
BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE erp_provisioning_request VALIDATE CONSTRAINT erp_provisioning_request_rotation_shape;
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE connector_registration VALIDATE CONSTRAINT connector_registration_provisioner_host_binding_valid;
COMMIT;
