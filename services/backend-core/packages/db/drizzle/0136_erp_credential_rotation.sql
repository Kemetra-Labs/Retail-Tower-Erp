-- 0136_erp_credential_rotation.sql — Jira RT-1362 S2 (PR-A of the S2 runtime), `[GATED: migration]`.
-- Owner authorization: RT-1362 comment 19102 (S2 `[GATED: migration]` approved, a partial unique index
-- for rotate idempotency chosen over a lock) and comment 19107 (OVERLAP rotation: the
-- one-unrevoked-credential index change is covered by that decision). Contract: provisioning-feed.yaml
-- 1.2.0-draft, "Credential rotation" (merged by #932, RT-1362 S1).
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
--      UNIQUE (id, tenant_id, connector_registration_id) is the target of the pending FK below.
--
--   2. uq_erp_provisioning_request_open_credential_rotate: at most one OPEN `credential.rotate` request
--      per registration (the 0109 `tenant.provision` pattern). A second trigger (scheduler or
--      rotate-now) returns the open one; the index is the race backstop. erp_provisioning_request holds
--      one row per provisioning request, so a plain build in this transaction is short.
--
--   3. connector_registration.provisioner_host_label / provisioner_host_binding /
--      provisioner_host_binding_revision: the provisioner host of an ADOPTED registration (RT-1557),
--      which has no succeeded `tenant.provision` to name its host. All three NULL (no binding: every
--      existing row) or all three set: `provisional` until the first credential call of a rotation
--      routed to it confirms it, then `confirmed`; the revision starts at 1 and increments on every
--      correction (contract `hostBindingRevision`, minimum 1). The label has the
--      `erp_provisioner_credential.host_label` shape.
--
--   4. auth_tokens.pending_rotation_request_id: the PENDING marker of overlap rotation. NULL is the
--      registration's CURRENT credential (every existing row); a value names the open
--      `credential.rotate` request that issued this credential as its pending replacement. Composite FK
--      (pending_rotation_request_id, tenant_id, connector_registration_id) ->
--      erp_provisioning_request (id, tenant_id, connector_registration_id), so a pending credential can
--      only name a rotation of its OWN registration and tenant. Only a connector credential linked to a
--      registration may be pending (CHECK).
--      The one-unrevoked-credential index (0021, `uq_auth_tokens_active_connector_credential`) becomes
--      AT MOST ONE CURRENT plus AT MOST ONE PENDING per registration. The two new partial unique
--      indexes are built CONCURRENTLY in 0137 and 0138 (auth_tokens is a hot table: every bearer
--      lookup reads it), and the old index is dropped CONCURRENTLY in 0139, after both exist. Until
--      0139 runs the old index still allows only one unrevoked credential, which is today's behaviour.
--      "Pending only while a rotation is open" is a runtime rule (RT-1362 S2 PR-B): a rotation that
--      ends in any terminal state other than `succeeded` revokes its pending credential in the same
--      transaction, and the promote clears the marker before the request becomes `succeeded`.
--      Promote order (PR-C): a partial unique index is never deferrable, so the promote REVOKES the old
--      current credential first and only then clears the pending marker, in one transaction.
--
-- BUSINESS-class: ids, host labels, enum tokens and a counter. NO secret, NO hash, NO PII, NO money.
--
-- No new table, policy or grant: the runtime role already holds table-level grants on the three tables
-- (docs/operations/sql/*-domain-grants.sql), and the existing policies cover the new columns.
--
-- Lock discipline (the 0109 pattern): each transaction takes short catalog locks under lock_timeout 2s
-- and adds every CHECK and FK on an existing table as NOT VALID; each VALIDATE runs in its own
-- transaction under SHARE UPDATE EXCLUSIVE, so reads and writes continue while it scans. The hot table
-- auth_tokens gets its own short transaction, so its ACCESS EXCLUSIVE never waits on the other tables'
-- locks or the request index build.
--
-- Re-runnable: if a later transaction of this file fails (for example a VALIDATE hitting the 2s lock
-- timeout), the runner records nothing and the whole file runs again: every ADD COLUMN is IF NOT EXISTS,
-- every CHECK and the FK are preceded by DROP CONSTRAINT IF EXISTS, the FK's unique target is added only
-- when missing, and the index is IF NOT EXISTS.
--
-- FK validation under FORCE RLS: the migration owner is NOSUPERUSER, and PostgreSQL validates a foreign
-- key as the owner with row security applied. The auth_tokens policy (0000) casts `app.current_tenant`
-- to uuid without an empty-string guard, so that transaction pins the tenant GUC to the nil UUID and sets
-- the platform-admin flag (both transaction-local): the cast is valid and every row is checked.
--
-- Rollback: 0136_erp_credential_rotation.down.sql (after 0139, 0138 and 0137 down). It refuses while a
-- `credential.rotate` request exists (a pending credential always names one), so it cannot discard
-- rotation state.

BEGIN;

SET LOCAL lock_timeout = '2s';

-- 1. erp_provisioning_request: routing and trigger of a credential.rotate ---
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

-- The pending FK target (section 4). Small table: a short build. Added only when missing (not dropped and
-- re-added like the CHECKs): on a re-run the pending FK already depends on it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'uq_erp_provisioning_request_id_tenant_registration'
                    AND conrelid = 'public.erp_provisioning_request'::regclass) THEN
    ALTER TABLE erp_provisioning_request
      ADD CONSTRAINT uq_erp_provisioning_request_id_tenant_registration
        UNIQUE (id, tenant_id, connector_registration_id);
  END IF;
END
$$;

-- 2. At most one open credential.rotate per registration ---------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_provisioning_request_open_credential_rotate
  ON erp_provisioning_request (connector_registration_id)
  WHERE kind = 'credential.rotate'
    AND status NOT IN ('succeeded', 'failed_permanent', 'compensated', 'cancelled');

-- 3. connector_registration: the adopted registration's provisioner host ----
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

-- 4. auth_tokens: the pending marker (its own short transaction) -------------
BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS pending_rotation_request_id UUID;

ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_pending_rotation_request_fk;
ALTER TABLE auth_tokens
  ADD CONSTRAINT auth_tokens_pending_rotation_request_fk
    FOREIGN KEY (pending_rotation_request_id, tenant_id, connector_registration_id)
    REFERENCES erp_provisioning_request (id, tenant_id, connector_registration_id) ON DELETE RESTRICT
    NOT VALID;

ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_pending_rotation_shape;
ALTER TABLE auth_tokens
  ADD CONSTRAINT auth_tokens_pending_rotation_shape
    CHECK (pending_rotation_request_id IS NULL
           OR (scope = 'connector' AND connector_registration_id IS NOT NULL AND tenant_id IS NOT NULL))
    NOT VALID;

COMMIT;

-- Each VALIDATE in its own transaction with the same lock bound (SHARE UPDATE EXCLUSIVE on the
-- validated table; the FK also takes ROW SHARE on the referenced one: reads and writes continue).
BEGIN;
SET LOCAL lock_timeout = '2s';
-- See "FK validation under FORCE RLS" above.
SELECT set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
SELECT set_config('app.is_platform_admin', 'true', true);
ALTER TABLE auth_tokens VALIDATE CONSTRAINT auth_tokens_pending_rotation_request_fk;
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE auth_tokens VALIDATE CONSTRAINT auth_tokens_pending_rotation_shape;
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE erp_provisioning_request VALIDATE CONSTRAINT erp_provisioning_request_rotation_shape;
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE connector_registration VALIDATE CONSTRAINT connector_registration_provisioner_host_binding_valid;
COMMIT;
