-- 0138_erp_provisioning_request_rotation_key_idx — Jira RT-1362 S2 (follows 0137), `[GATED: migration]`. The unique
-- key (id, tenant_id, connector_registration_id, kind) of erp_provisioning_request: the target of 0139's pending FK,
-- so a pending connector credential can only name a `credential.rotate` request of its OWN tenant and registration
-- (the token side carries the constant kind `credential.rotate`). `id` is the primary key, so the key holds on
-- every existing row. A foreign key may reference the columns of a non-partial unique index.
-- A dedicated single-statement CONCURRENTLY migration (precedents 0036, 0048, 0117, 0126), and deliberately NO
-- `IF NOT EXISTS` (see 0117): an interrupted build fails the retry until the INVALID index is dropped.
CREATE UNIQUE INDEX CONCURRENTLY uq_erp_provisioning_request_rotation_key ON erp_provisioning_request (id, tenant_id, connector_registration_id, kind);
