-- 0139_auth_tokens_pending_rotation.sql — Jira RT-1362 S2 (follows 0138), `[GATED: migration]` (RT-1362 comments 19102
-- and 19107). The PENDING marker of overlap rotation on auth_tokens, alone in its file: auth_tokens is read on every
-- bearer lookup, so its ACCESS EXCLUSIVE is held only for the short catalog changes below and never waits on another
-- table's DDL.
--
--   pending_rotation_request_id  NULL: the registration's CURRENT credential (every existing row); a value: the open
--                                `credential.rotate` request that issued this credential as its pending replacement.
--   pending_rotation_kind        the discriminator of that FK: NULL, or exactly 'credential.rotate', set together
--                                with the request id (CHECK).
--   FK (pending_rotation_request_id, tenant_id, connector_registration_id, pending_rotation_kind)
--      -> erp_provisioning_request (id, tenant_id, connector_registration_id, kind)  (0138's unique key)
--      so a pending credential can only name a `credential.rotate` request of its OWN tenant and registration: never
--      another registration's rotation and never a `tenant.provision` request. ON DELETE RESTRICT.
--   CHECK auth_tokens_pending_rotation_shape: only a tenant connector credential linked to a registration may be
--      pending.
--
-- No pending credential can be written yet: the 0021 index `uq_auth_tokens_active_connector_credential` (still in
-- place) allows only one unrevoked connector credential per registration, so a pending one next to the current one
-- is refused. A later PR drops it, after the readers (the status reader, the legacy re-issue) handle two unrevoked
-- credentials. "Pending only while a rotation is open" is a runtime rule of that work: a rotation that ends in any
-- terminal state other than `succeeded` revokes its pending credential in the same transaction. Promote order: a
-- partial unique index is never deferrable, so the promote REVOKES the old current credential first and only then
-- clears both marker columns, in one transaction.
--
-- DDL only: both columns start NULL (no rewrite, no backfill). Lock discipline (the 0109 pattern): one short
-- transaction under lock_timeout 2s adds the FK and the CHECK NOT VALID; each VALIDATE runs in its own transaction
-- (SHARE UPDATE EXCLUSIVE on auth_tokens: reads and writes continue). Re-runnable: ADD COLUMN IF NOT EXISTS and DROP
-- CONSTRAINT IF EXISTS before each ADD.
--
-- FK validation under FORCE RLS: the migration owner is NOSUPERUSER and PostgreSQL validates a foreign key as the
-- owner with row security applied. The 0000 auth_tokens policy casts `app.current_tenant` with a bare ::uuid, which
-- 22P02s on '' (left by an earlier transaction-local setting in the same session), so the FK VALIDATE pins it to the
-- nil UUID and sets the platform-admin flag (both transaction-local): the cast is valid and every row is checked.
--
-- Rollback: 0139_auth_tokens_pending_rotation.down.sql (after 0141 and 0140 down). It refuses while any credential
-- carries a pending marker.

BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS pending_rotation_request_id UUID;
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS pending_rotation_kind TEXT;

ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_pending_rotation_request_fk;
ALTER TABLE auth_tokens
  ADD CONSTRAINT auth_tokens_pending_rotation_request_fk
    FOREIGN KEY (pending_rotation_request_id, tenant_id, connector_registration_id, pending_rotation_kind)
    REFERENCES erp_provisioning_request (id, tenant_id, connector_registration_id, kind) ON DELETE RESTRICT
    NOT VALID;

ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_pending_rotation_shape;
ALTER TABLE auth_tokens
  ADD CONSTRAINT auth_tokens_pending_rotation_shape
    CHECK ((pending_rotation_request_id IS NULL) = (pending_rotation_kind IS NULL)
           AND (pending_rotation_kind IS NULL OR pending_rotation_kind = 'credential.rotate')
           AND (pending_rotation_request_id IS NULL
                OR (scope = 'connector' AND connector_registration_id IS NOT NULL AND tenant_id IS NOT NULL)))
    NOT VALID;

COMMIT;

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
