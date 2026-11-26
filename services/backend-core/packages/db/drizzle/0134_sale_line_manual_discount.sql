-- 0134_sale_line_manual_discount -- Jira RT-1571 (RT-285 F-7, RT-740 lineage). `[GATED: migration]`.
-- Authorization: the owner's delegation (RT-1588 comment 18881 item 9; RT-1571 comment 18901). Owner decision
-- OQ-8 (RT-285 comment 18526): store the manual discount's kind, reason and approver on the sale line.
-- Decision record: services/backend-core/docs/decisions/rt-285-checkout-attribution.md §8 F-7.
--
-- The line's one manual discount (`CaptureSaleLineDiscount`, RT-740) has been validated and hashed into the
-- sale's payload hash since sales.yaml 1.14.0-draft, but only the net `line_amount` was kept. These columns
-- keep the rest as immutable sale-line facts, exactly as the till sent them:
--
--   sale_lines.discount_kind              percent | amount
--   sale_lines.discount_value             the whole percent (1-100) or the money taken off (> 0)
--   sale_lines.discount_amount            the money taken off the line (>= 0; `line_amount` = gross - this)
--   sale_lines.discount_reason_code       the RT-740 closed reason list (OD-28-9), never free text
--   sale_lines.discount_authority_source  cashier_approval | manager_session (a till claim, recorded as sent)
--   sale_lines.discount_approver_role     manager | admin (a till claim, recorded as sent)
--   sale_lines.discount_approver_user_id  the approver's users.id when the till sent one (a recorded claim)
--
-- The six required facts are all NULL (no manual discount, and every line captured before this migration:
-- "not recorded") or all set; the approver's user id is optional and only with them. The requester of the
-- discount is the sale's Transaction Operator (`sales.created_by`), already recorded; the approver is kept
-- apart from it, never merged.
--
-- No foreign key on discount_approver_user_id: the capture contract never verified that id (a provenance
-- claim, sales.yaml `CaptureSaleLineDiscount.approverUserId`), and refusing an unknown id now would change
-- what an existing till payload gets back. It is stored as recorded, like the tracking snapshot.
--
-- Columns only: no new table, so tools/module-boundaries/module-map.json, the RLS policies (sale_lines is
-- FORCE ROW LEVEL SECURITY with tenant-only policies, 0012) and the domain grants are unchanged: the domain
-- role's table-level SELECT and INSERT cover the new columns, and sale_lines still has no UPDATE grant, so
-- the facts are never rewritten. No backfill: earlier lines did not keep these facts and nothing can
-- recover them; they read as "not recorded".
--
-- The CHECKs mirror the capture DTO (capture-sale-request.dto.ts `CaptureSaleLineDiscountSchema`): the DTO
-- answers 400 first, so a CHECK is the last resort. They are added NOT VALID: every existing row has NULL in
-- the new columns, so a validating scan of the hot sale_lines table under the lock would prove nothing; new
-- rows are checked.
--
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on sale_lines for the catalog change only (nullable columns
-- without a default never rewrite the table); lock_timeout 2 s.
-- Rollback: 0134_sale_line_manual_discount.down.sql (refuses while any recorded discount would be lost).

BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE sale_lines
  ADD COLUMN IF NOT EXISTS discount_kind text,
  ADD COLUMN IF NOT EXISTS discount_value numeric(19,4),
  ADD COLUMN IF NOT EXISTS discount_amount numeric(19,4),
  ADD COLUMN IF NOT EXISTS discount_reason_code text,
  ADD COLUMN IF NOT EXISTS discount_authority_source text,
  ADD COLUMN IF NOT EXISTS discount_approver_role text,
  ADD COLUMN IF NOT EXISTS discount_approver_user_id uuid;

-- Whole or absent: the six required facts together; the approver's user id only with them.
ALTER TABLE sale_lines
  DROP CONSTRAINT IF EXISTS sale_lines_discount_whole;
ALTER TABLE sale_lines
  ADD CONSTRAINT sale_lines_discount_whole
  CHECK ((discount_kind IS NULL) = (discount_value IS NULL)
     AND (discount_kind IS NULL) = (discount_amount IS NULL)
     AND (discount_kind IS NULL) = (discount_reason_code IS NULL)
     AND (discount_kind IS NULL) = (discount_authority_source IS NULL)
     AND (discount_kind IS NULL) = (discount_approver_role IS NULL)
     AND (discount_approver_user_id IS NULL OR discount_kind IS NOT NULL)) NOT VALID;

-- The closed vocabularies of the capture contract (RT-740 OD-28-1, OD-28-9; RT-608).
ALTER TABLE sale_lines
  DROP CONSTRAINT IF EXISTS sale_lines_discount_vocabulary;
ALTER TABLE sale_lines
  ADD CONSTRAINT sale_lines_discount_vocabulary
  CHECK (discount_kind IS NULL
      OR (discount_kind IN ('percent', 'amount')
      AND discount_reason_code IN ('promotion', 'loyal_or_contract_customer', 'near_expiry_or_damaged',
                                   'price_correction')
      AND discount_authority_source IN ('cashier_approval', 'manager_session')
      AND discount_approver_role IN ('manager', 'admin'))) NOT VALID;

-- The magnitude rules the DTO enforces: a percent is a whole 1-100 (OD-28-2); an amount discount's value is
-- positive and equals its amount; the amount is never negative. NaN is refused explicitly (it compares
-- greater than every number).
ALTER TABLE sale_lines
  DROP CONSTRAINT IF EXISTS sale_lines_discount_magnitude;
ALTER TABLE sale_lines
  ADD CONSTRAINT sale_lines_discount_magnitude
  CHECK (discount_kind IS NULL
      OR (discount_value <> 'NaN'::numeric
      AND discount_amount <> 'NaN'::numeric
      AND discount_value > 0
      AND discount_amount >= 0
      AND (discount_kind <> 'percent' OR (discount_value = trunc(discount_value) AND discount_value <= 100))
      AND (discount_kind <> 'amount' OR discount_value = discount_amount))) NOT VALID;

COMMIT;
