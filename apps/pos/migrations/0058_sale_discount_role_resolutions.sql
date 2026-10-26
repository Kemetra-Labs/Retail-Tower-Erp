-- RT-906 (RT-905 decision) — the approver role resolved for a held discount
-- line, frozen before the sale's first capture POST.
--
-- [GATED] approval: the owner authorised this migration in Jira RT-905
-- comment 14049 on 2026-10-27 ("Storage: a new append-only side table,
-- [GATED] POS migration authorized for this purpose … variant 2(b)"). RT-906
-- carries it. 0058 is the next free number after 0057.
--
-- ## Why
--
-- RT-858 holds a discounted sale whose frozen discount has no
-- `approver_role` (a cashier approval granted by a PIN record with no role
-- yet, RT-861): `sales.yaml` requires `approverRole` and POS never invents
-- one. The owner decided (RT-905 comment 14049) that the role may be the
-- approving manager's PIN-record role as of that manager's latest online
-- manager / admin sign-in on the terminal (`refreshRole`). `lines_json` and
-- `manager_approvals` stay immutable, so the resolved role lives here.
--
-- A held sale has never been POSTed. Its first POST fixes the
-- `Idempotency-Key` fingerprint, and a later body change is a terminal 409.
-- So a row is written once, before that first POST, and never edited: every
-- retry builds the same body whatever the PIN record says later.
--
-- ## Shape
--
--   • (sale_id, placeholder_id) — the held sale and its line's frozen
--     discount placeholder; one resolution per discount line.
--   • approval_id — the consumed `cart.discount.manual` approval the line's
--     `cart.discount.manager_authorized` audit row names.
--   • approver_role — `manager` | `admin`, read from the approver's PIN record
--     on the sale's own tenant, branch and terminal.
--   • source — how it was resolved; a closed set: `pin_record_refresh`.
--   • resolved_at — when.
--
-- No FK: a resolution must never block a sale or approval write, and the
-- resolver reads both before it inserts. Additive, IF NOT EXISTS, ships empty.
--
-- ## §A2 migration safety
--
--   • Additive only: one new table and two triggers on it; no existing table,
--     column, constraint, index or trigger is altered or dropped.
--   • Ships empty, so no CHECK can fail on an existing database.
--   • Code before 0058 never names the table, so it reads and writes every
--     other table unchanged after the migration.
--   • Append-only: UPDATE and DELETE are refused by triggers, as in 0048. The
--     writer inserts with ON CONFLICT DO NOTHING (never REPLACE).
--   • No PIN, hash, users.id or secret is stored; nothing reaches the renderer.
--
-- ## Rollback
--
--   DROP TRIGGER IF EXISTS trg_sale_discount_role_resolutions_no_update;
--   DROP TRIGGER IF EXISTS trg_sale_discount_role_resolutions_no_delete;
--   DROP TABLE IF EXISTS sale_discount_role_resolutions;
-- restores 0057. A sale already captured is unaffected; a released sale not
-- yet sent is held again under `discount_capture_unavailable` (fail closed).

CREATE TABLE IF NOT EXISTS sale_discount_role_resolutions (
  sale_id         TEXT  NOT NULL CHECK (length(sale_id) > 0),
  placeholder_id  TEXT  NOT NULL CHECK (length(placeholder_id) > 0),
  approval_id     TEXT  NOT NULL
                  CHECK (length(approval_id) = 36 AND approval_id = lower(approval_id)),
  approver_role   TEXT  NOT NULL CHECK (approver_role IN ('manager', 'admin')),
  source          TEXT  NOT NULL CHECK (source IN ('pin_record_refresh')),
  resolved_at     TEXT  NOT NULL CHECK (length(resolved_at) > 0),
  PRIMARY KEY (sale_id, placeholder_id)
);

-- Written once, before the first capture POST, and never edited (0048's rule).
CREATE TRIGGER IF NOT EXISTS trg_sale_discount_role_resolutions_no_update
BEFORE UPDATE ON sale_discount_role_resolutions
BEGIN
  SELECT RAISE(ABORT, 'sale_discount_role_resolutions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_discount_role_resolutions_no_delete
BEFORE DELETE ON sale_discount_role_resolutions
BEGIN
  SELECT RAISE(ABORT, 'sale_discount_role_resolutions is append-only');
END;
