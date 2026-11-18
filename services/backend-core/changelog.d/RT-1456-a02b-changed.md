### Changed
- RT-1456 (audit A-02, step 2 of 2): `pos-shifts/shift-money` and `pos-shifts/shift-cash-arithmetic`
  moved to `common/money/` with no logic change and no re-export shim. The `formatMoney` re-export in
  `pos-shifts/index.ts` is removed and the Console force-actions service imports it from `common`.
  `cash-variance-policy` no longer sits in a module-level import cycle (20 api modules in cycles
  before, 19 after). No route, contract, table or wire change.
