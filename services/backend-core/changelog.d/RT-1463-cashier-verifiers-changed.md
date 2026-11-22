### Changed
- RT-1463 (step 1 of the catalog split): the cashier admission verifiers move to their owning
  module. `operator-attribution.ts` and `tracked-line-cashier.ts` leave `catalog/sales/` for
  `pos-cashier-admissions/`, which owns `cashier_admissions`, and the device-path selector
  `selectsDevicePath` moves there too (`device-path.ts`). A new `pos-cashier-admissions/index.ts`
  is the port that sales, shift cash-up and voucher guards import. The console cursor primitives
  `KEY_INSTANT` and `namesRealInstant` move to `common/cursor/opaque-cursor.ts`, so inventory no
  longer imports console-sales. DI tokens, SQL, routes and behaviour are unchanged. The
  module-boundaries baseline shrinks by 12 lines and the import-cycles baseline by 6 module edges
  (`catalog↔pos-shifts`, `catalog↔vouchers-pos`, `console-sales→catalog`, `inventory→console-sales`).
