-- 0079_pairing_codes_printer_ids_nullable.down.sql
--
-- Rollback for 0079_pairing_codes_printer_ids_nullable.sql (RT-1181 / RT-1165 S1).
-- Restores NOT NULL on `pairing_codes.printer_vendor_id` and
-- `pairing_codes.printer_product_id`.
--
-- A row issued WITHOUT the printer IDs holds NULL there, and the IDs cannot be
-- invented. So the rollback REFUSES while any such row exists: SET NOT NULL fails
-- with SQLSTATE 23502 (not_null_violation) naming the column. Back the rows up and
-- cancel, delete or backfill them explicitly first. The check is made by the
-- statement itself, which reads every row whatever the row-level security policy
-- of the migration role (a counting query here would see no rows under FORCE ROW
-- LEVEL SECURITY and read as "none").
--
-- Roll back the RT-1181 API first: it inserts NULL and fails once NOT NULL is back.
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0079-pairing-codes-printer-ids-nullable.spec.ts.

BEGIN;

ALTER TABLE pairing_codes
  ALTER COLUMN printer_vendor_id SET NOT NULL,
  ALTER COLUMN printer_product_id SET NOT NULL;

COMMIT;
