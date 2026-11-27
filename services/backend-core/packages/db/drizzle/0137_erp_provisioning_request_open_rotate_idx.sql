-- 0137_erp_provisioning_request_open_rotate_idx — Jira RT-1362 S2 (follows 0136), `[GATED: migration]` (RT-1362
-- comment 19102: a partial unique index for rotate idempotency, chosen over a lock). At most one OPEN
-- `credential.rotate` request per registration (the 0109 `tenant.provision` pattern): a second trigger (the scheduler
-- or rotate-now) returns the open one, and this index is the race backstop. No such row exists yet.
-- A dedicated single-statement CONCURRENTLY migration (precedents 0036, 0048, 0117, 0126), so the build never blocks
-- the provisioner feed's writes. Deliberately NO `IF NOT EXISTS` (see 0117): an interrupted build can leave an
-- INVALID index of this name, and a retry that skipped it would be recorded as applied while the index enforces
-- nothing; with the plain form a retry fails until the operator runs `DROP INDEX CONCURRENTLY` on it: fail closed.
CREATE UNIQUE INDEX CONCURRENTLY uq_erp_provisioning_request_open_credential_rotate ON erp_provisioning_request (connector_registration_id) WHERE kind = 'credential.rotate' AND status NOT IN ('succeeded', 'failed_permanent', 'compensated', 'cancelled');
