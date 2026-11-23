-- 0133_sale_seller_receiver_facts.down.sql
--
-- RT-1565 -- rollback for 0133_sale_seller_receiver_facts.sql: drops the seller snapshot columns of
-- sale_lines, the receiver of sale_tenders, and memberships.seller_code with its index and CHECK.
--
-- The rollback REFUSES while any recorded fact would be lost: a sale line with a seller, a tender with a
-- receiver, or a membership with a Seller Code. These are immutable sale facts (and the codes the tills
-- resolve), so dropping them is not something this file does silently: back up and decide first.
--
-- The three tables are FORCE ROW LEVEL SECURITY and the production migration owner is not a superuser, and
-- sale_lines and sale_tenders have tenant-only read policies (0012, 0033: no platform-admin branch). So the
-- guard reads under each tenant's app.current_tenant, with an explicit tenant_id predicate, listing the
-- tenants as platform admin (with the GUC pinned to the nil UUID first: an unset or empty GUC would fail a
-- policy's uuid cast); a bare SELECT would see no rows and let the rollback through. FORCE is never lifted.
-- The three tables are locked ACCESS EXCLUSIVE first, so no row can be committed between the guard and the
-- DROPs. Every fact row has a tenant (each table's tenant_id references tenants).
--
-- Rerunnable: every DROP is IF EXISTS, and the guard reads the columns only while they exist.
-- Supports the UP -> DOWN -> UP round trip exercised by
-- packages/db/__tests__/migration/0133-sale-seller-receiver-facts.spec.ts and the full-chain down in
-- packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

LOCK TABLE memberships, sale_lines, sale_tenders IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  t uuid;
  n bigint := 0;
  m bigint;
  has_lines boolean;
  has_tenders boolean;
  has_codes boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'sale_lines' AND column_name = 'seller_user_id'),
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'sale_tenders' AND column_name = 'received_by_user_id'),
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'memberships' AND column_name = 'seller_code')
    INTO has_lines, has_tenders, has_codes;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    IF has_lines THEN
      EXECUTE 'SELECT count(*) FROM sale_lines WHERE tenant_id = $1 AND seller_user_id IS NOT NULL' INTO m USING t;
      n := n + m;
    END IF;
    IF has_tenders THEN
      EXECUTE 'SELECT count(*) FROM sale_tenders WHERE tenant_id = $1 AND received_by_user_id IS NOT NULL' INTO m USING t;
      n := n + m;
    END IF;
    IF has_codes THEN
      EXECUTE 'SELECT count(*) FROM memberships WHERE tenant_id = $1 AND seller_code IS NOT NULL' INTO m USING t;
      n := n + m;
    END IF;
  END LOOP;
  PERFORM set_config('app.is_platform_admin', '', true);
  PERFORM set_config('app.current_tenant', '', true);
  IF n > 0 THEN
    RAISE EXCEPTION '0133 down refused: % row(s) carry a seller, a payment receiver or a Seller Code; the facts would be lost', n
      USING HINT = 'Back up the rows, then decide; this rollback never drops recorded sale facts.';
  END IF;
END
$$;

ALTER TABLE sale_tenders DROP CONSTRAINT IF EXISTS fk_sale_tenders_received_by_user;
ALTER TABLE sale_tenders DROP COLUMN IF EXISTS received_by_user_id;

ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS fk_sale_lines_seller_role;
ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS fk_sale_lines_seller_store;
ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS fk_sale_lines_seller_user;
ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS sale_lines_seller_snapshot_whole;
ALTER TABLE sale_lines
  DROP COLUMN IF EXISTS seller_role_id,
  DROP COLUMN IF EXISTS seller_store_id,
  DROP COLUMN IF EXISTS seller_user_id;

DROP INDEX IF EXISTS uq_memberships_tenant_seller_code;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_seller_code_format;
ALTER TABLE memberships DROP COLUMN IF EXISTS seller_code;

COMMIT;
