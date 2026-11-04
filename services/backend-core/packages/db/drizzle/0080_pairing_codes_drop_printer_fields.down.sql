-- 0080_pairing_codes_drop_printer_fields.down.sql
--
-- Rollback for 0080_pairing_codes_drop_printer_fields.sql (RT-1184 / RT-1165 S4).
--
-- DATA LOSS IS NOT UNDONE: the up migration discarded every stored printer vendor
-- id, product id and COM port, and this rollback cannot bring them back. It
-- restores the SHAPE only: the three columns, NULLABLE (the state 0079 left them
-- in; 0024's NOT NULL on the two ids is not restored, because every existing row
-- would hold NULL), and their CHECK constraints, which apply to non-NULL values
-- only. Every row, old or new, holds NULL in all three columns afterwards. To get
-- the values back, restore them from a backup taken before 0080.
--
-- Roll back the RT-1184 API first or at the same time: the API of RT-1181 and
-- earlier reads and writes these columns, the RT-1184 API does neither.
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0080-pairing-codes-drop-printer-fields.spec.ts.

BEGIN;

ALTER TABLE pairing_codes
  ADD COLUMN IF NOT EXISTS printer_vendor_id  TEXT,
  ADD COLUMN IF NOT EXISTS printer_product_id TEXT,
  ADD COLUMN IF NOT EXISTS printer_com_port   TEXT;

ALTER TABLE pairing_codes
  DROP CONSTRAINT IF EXISTS pairing_codes_printer_vendor_id_hex,
  DROP CONSTRAINT IF EXISTS pairing_codes_printer_product_id_hex,
  DROP CONSTRAINT IF EXISTS pairing_codes_printer_com_port_non_empty;

ALTER TABLE pairing_codes
  ADD CONSTRAINT pairing_codes_printer_vendor_id_hex
    CHECK (printer_vendor_id ~ '^0x[0-9A-Fa-f]{4}$'),
  ADD CONSTRAINT pairing_codes_printer_product_id_hex
    CHECK (printer_product_id ~ '^0x[0-9A-Fa-f]{4}$'),
  ADD CONSTRAINT pairing_codes_printer_com_port_non_empty
    CHECK (printer_com_port IS NULL OR length(btrim(printer_com_port)) > 0);

COMMIT;
