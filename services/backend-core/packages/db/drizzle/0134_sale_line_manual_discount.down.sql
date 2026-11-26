-- 0134_sale_line_manual_discount.down.sql
--
-- RT-1571 -- rollback for 0134_sale_line_manual_discount.sql: drops the seven manual-discount columns of
-- sale_lines with their three CHECKs.
--
-- The rollback REFUSES while any sale line carries a recorded manual discount: these are immutable sale facts
-- (the discount's kind, reason and approver), so dropping them is not something this file does silently:
-- back up and decide first.
--
-- sale_lines is FORCE ROW LEVEL SECURITY with tenant-only policies (0012: no platform-admin branch) and the
-- production migration owner is not a superuser, so the guard reads under each tenant's app.current_tenant,
-- with an explicit tenant_id predicate, listing the tenants as platform admin (with the GUC pinned to the nil
-- UUID first: an unset or empty GUC would fail a policy's uuid cast); a bare SELECT would see no rows and let
-- the rollback through. FORCE is never lifted. sale_lines is locked ACCESS EXCLUSIVE first, so no row can be
-- committed between the guard and the DROPs. Every line has a tenant (sale_lines.tenant_id references
-- tenants).
--
-- Rerunnable: every DROP is IF EXISTS, and the guard reads the column only while it exists.
-- Supports the UP -> DOWN -> UP round trip exercised by
-- packages/db/__tests__/migration/0134-sale-line-manual-discount.spec.ts and the full-chain down in
-- packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

LOCK TABLE sale_lines IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  t uuid;
  n bigint := 0;
  m bigint;
  has_discounts boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'sale_lines' AND column_name = 'discount_kind')
    INTO has_discounts;
  IF has_discounts THEN
    PERFORM set_config('app.is_platform_admin', 'true', true);
    PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
    FOR t IN SELECT id FROM tenants LOOP
      PERFORM set_config('app.current_tenant', t::text, true);
      EXECUTE 'SELECT count(*) FROM sale_lines WHERE tenant_id = $1 AND discount_kind IS NOT NULL' INTO m USING t;
      n := n + m;
    END LOOP;
    PERFORM set_config('app.is_platform_admin', '', true);
    PERFORM set_config('app.current_tenant', '', true);
  END IF;
  IF n > 0 THEN
    RAISE EXCEPTION '0134 down refused: % sale line(s) carry a recorded manual discount; the facts would be lost', n
      USING HINT = 'Back up the rows, then decide; this rollback never drops recorded sale facts.';
  END IF;
END
$$;

ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS sale_lines_discount_magnitude;
ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS sale_lines_discount_vocabulary;
ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS sale_lines_discount_whole;
ALTER TABLE sale_lines
  DROP COLUMN IF EXISTS discount_approver_user_id,
  DROP COLUMN IF EXISTS discount_approver_role,
  DROP COLUMN IF EXISTS discount_authority_source,
  DROP COLUMN IF EXISTS discount_reason_code,
  DROP COLUMN IF EXISTS discount_amount,
  DROP COLUMN IF EXISTS discount_value,
  DROP COLUMN IF EXISTS discount_kind;

COMMIT;
