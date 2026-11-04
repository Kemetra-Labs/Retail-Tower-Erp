-- 0080_pairing_codes_drop_printer_fields.sql
--
-- RT-1184 (RT-1165 slice S4, the CONTRACT step). [GATED] pairing contract and
-- DESTRUCTIVE database migration: the owner decision on RT-1165 (2026-11-04,
-- comment 15479) is to REMOVE the printer USB vendor/product IDs and the COM port
-- from device pairing. Applying this migration to the lab, a live database or any
-- deploy is NOT authorized by that decision, and it must not be applied before the
-- Console (RT-1182) and the POS (RT-1183) are merged and deployed and no older
-- paired POS build remains (RT-1184 acceptance item 5).
--
-- For an existing Backend-Core deployment, fully roll out the RT-1184 API and
-- stop or drain every older API instance BEFORE applying this migration. Older
-- API instances read and insert these columns and fail with SQLSTATE 42703
-- after they are dropped.
--
-- Drops `pairing_codes.printer_vendor_id`, `printer_product_id` and
-- `printer_com_port` (0024_pairing_codes.sql; the first two made nullable by
-- 0079_pairing_codes_printer_ids_nullable.sql), together with their CHECK
-- constraints, which go with the columns:
--   pairing_codes_printer_vendor_id_hex
--   pairing_codes_printer_product_id_hex
--   pairing_codes_printer_com_port_non_empty
--
-- DATA LOSS: every stored printer vendor id, product id and COM port of every
-- pairing code (pending, used or cancelled) is discarded. The values are
-- device-model identifiers copied at issue time; Backend-Core does not read them
-- after the pair response, and the POS keeps its own copy. Back the table up first
-- if the history of what was issued matters.
--
-- DATA-LIFECYCLE CLASSIFICATION (§XIV): unchanged from 0024 (BUSINESS-class; USB
-- vendor/product IDs are device-model identifiers, not personal data).
--
-- RLS / grants: none changed. The table keeps its FORCE ROW LEVEL SECURITY and its
-- SELECT, INSERT and UPDATE policies. No index, view or trigger references these
-- columns.
--
-- Lock impact: ACCESS EXCLUSIVE on `pairing_codes` for a catalog-only change.
-- DROP COLUMN does not rewrite the table; the space is reclaimed lazily.
--
-- Rollback: 0080_pairing_codes_drop_printer_fields.down.sql restores the three
-- columns and their CHECKs, EMPTY. It cannot restore the dropped values; restore
-- them from a backup taken before this migration if they are needed.

BEGIN;

ALTER TABLE pairing_codes
  DROP COLUMN IF EXISTS printer_vendor_id,
  DROP COLUMN IF EXISTS printer_product_id,
  DROP COLUMN IF EXISTS printer_com_port;

COMMIT;
