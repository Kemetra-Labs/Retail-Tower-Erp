-- 0133_sale_seller_receiver_facts -- Jira RT-1565 (RT-285 F-1). `[GATED: migration]`.
-- Owner approval: RT-1565 comments 18562 (the plan) and 18563 ("Approved, build it", chat 2026-11-23).
-- Decision record: services/backend-core/docs/decisions/rt-285-checkout-attribution.md §5.2, §8 F-1
-- (owner decisions OQ-1, OQ-2 and OQ-5, RT-285 comment 18526).
--
-- Seller attribution per sale line and payment receiver per tender, as immutable sale facts. The Transaction
-- Operator stays `sales.created_by`; the approver stays per action; drawer custody is W6. Nothing here is
-- commission (F-5) or a correction (F-2).
--
--   memberships.seller_code     The member's Seller Code (OQ-1): unique within the tenant among non-deleted
--                               memberships, 2-16 upper-case letters or digits. Nullable: most members have
--                               none. No contract exposes it yet (the roster is F-3, RT-1567).
--   sale_lines.seller_user_id   The line's seller, frozen at capture with the store and role it held then
--   sale_lines.seller_store_id  (Policy §8: employee, store and role at sale time). All three are NULL (no
--   sale_lines.seller_role_id   seller; every sale before this migration) or all three are set.
--   sale_tenders.received_by_user_id
--                               Who took this payment. NULL means the Transaction Operator (`created_by`),
--                               the default; it is set only when another member received it.
--
-- Columns only: no new table, so tools/module-boundaries/module-map.json and the RLS policies are unchanged
-- (the existing tenant policies cover every column). No backfill: existing rows mean "no seller" and
-- "received by the operator", which is what they recorded. The domain role's table-level grants already
-- cover the new columns; sale_lines and sale_tenders still get no UPDATE, so the facts stay immutable.
--
-- Foreign keys: the seller and receiver point at users(id) like sales.created_by; the frozen store at
-- stores(id) and the frozen role at roles(id). All ON DELETE RESTRICT (a fact never loses its subject).
-- They are added NOT VALID: every existing row has NULL in the new columns, so a validating scan of the
-- hot sale tables under lock would prove nothing; new rows are checked. The CHECKs are NOT VALID for the
-- same reason.
--
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on memberships, sale_lines and sale_tenders for the catalog change
-- only (nullable columns without a default never rewrite the table); lock_timeout 2 s. The unique index is
-- built inside the transaction (memberships is small; CONCURRENTLY cannot run in a transaction block).
-- Rollback: 0133_sale_seller_receiver_facts.down.sql (refuses while any recorded fact would be lost).

BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS seller_code text;

ALTER TABLE memberships
  DROP CONSTRAINT IF EXISTS memberships_seller_code_format;
ALTER TABLE memberships
  ADD CONSTRAINT memberships_seller_code_format
  CHECK (seller_code IS NULL OR seller_code ~ '^[A-Z0-9]{2,16}$') NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_memberships_tenant_seller_code
  ON memberships (tenant_id, seller_code)
  WHERE seller_code IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE sale_lines
  ADD COLUMN IF NOT EXISTS seller_user_id uuid,
  ADD COLUMN IF NOT EXISTS seller_store_id uuid,
  ADD COLUMN IF NOT EXISTS seller_role_id uuid;

ALTER TABLE sale_lines
  DROP CONSTRAINT IF EXISTS sale_lines_seller_snapshot_whole;
ALTER TABLE sale_lines
  ADD CONSTRAINT sale_lines_seller_snapshot_whole
  CHECK ((seller_user_id IS NULL) = (seller_store_id IS NULL)
     AND (seller_user_id IS NULL) = (seller_role_id IS NULL)) NOT VALID;

ALTER TABLE sale_lines
  DROP CONSTRAINT IF EXISTS fk_sale_lines_seller_user;
ALTER TABLE sale_lines
  ADD CONSTRAINT fk_sale_lines_seller_user
  FOREIGN KEY (seller_user_id) REFERENCES users (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE sale_lines
  DROP CONSTRAINT IF EXISTS fk_sale_lines_seller_store;
ALTER TABLE sale_lines
  ADD CONSTRAINT fk_sale_lines_seller_store
  FOREIGN KEY (seller_store_id) REFERENCES stores (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE sale_lines
  DROP CONSTRAINT IF EXISTS fk_sale_lines_seller_role;
ALTER TABLE sale_lines
  ADD CONSTRAINT fk_sale_lines_seller_role
  FOREIGN KEY (seller_role_id) REFERENCES roles (id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE sale_tenders
  ADD COLUMN IF NOT EXISTS received_by_user_id uuid;

ALTER TABLE sale_tenders
  DROP CONSTRAINT IF EXISTS fk_sale_tenders_received_by_user;
ALTER TABLE sale_tenders
  ADD CONSTRAINT fk_sale_tenders_received_by_user
  FOREIGN KEY (received_by_user_id) REFERENCES users (id) ON DELETE RESTRICT NOT VALID;

COMMIT;
