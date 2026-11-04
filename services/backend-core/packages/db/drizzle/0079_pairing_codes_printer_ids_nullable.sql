-- 0079_pairing_codes_printer_ids_nullable.sql
--
-- RT-1181 (RT-1165 slice S1, the EXPAND step). [GATED] pairing contract and
-- database migration: the owner decision on RT-1165 (2026-11-04, comment 15479)
-- is to REMOVE the printer USB vendor/product IDs and the COM port from device
-- pairing. Applying this migration to the lab, a live database or any deploy is
-- NOT authorized by that decision.
--
-- Drops NOT NULL on `pairing_codes.printer_vendor_id` and
-- `pairing_codes.printer_product_id` (0024_pairing_codes.sql), so that an issuer
-- may omit them. `printer_com_port` is already nullable.
--
--   * The hex CHECKs `pairing_codes_printer_vendor_id_hex` and
--     `pairing_codes_printer_product_id_hex` STAY. A CHECK that evaluates to NULL
--     passes, so they now apply to non-NULL values only: a value that is stored
--     must still match `^0x[0-9A-Fa-f]{4}$`.
--   * Existing rows are not touched: every old row keeps its stored IDs.
--   * The columns are NOT dropped here. The drop is the contract step (RT-1184,
--     RT-1165 S4), after the Console (RT-1182) and the POS (RT-1183) stop using
--     them.
--
-- DATA-LIFECYCLE CLASSIFICATION (§XIV): unchanged from 0024 (BUSINESS-class; USB
-- vendor/product IDs are device-model identifiers, not personal data).
--
-- RLS / grants: none changed. The table keeps its FORCE ROW LEVEL SECURITY and its
-- SELECT, INSERT and UPDATE policies.
--
-- Lock impact: ACCESS EXCLUSIVE on `pairing_codes` for a catalog-only change.
-- DROP NOT NULL does not scan or rewrite the table, and the statement commits at
-- once.
--
-- Reversible via 0079_pairing_codes_printer_ids_nullable.down.sql (which refuses
-- while a row holds NULL).

BEGIN;

ALTER TABLE pairing_codes
  ALTER COLUMN printer_vendor_id DROP NOT NULL,
  ALTER COLUMN printer_product_id DROP NOT NULL;

COMMIT;
