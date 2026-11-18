### Changed
- RT-1456 (audit A-02, step 1 of 2): four pure primitives moved from domain modules to `common/` with
  no logic change and no re-export shims: `iso4217-minor-units` (`common/money/`), `payload-hash`
  (`common/hashing/`), `decimal-quantity` (`common/quantity/`) and `deployment-environment`
  (`common/`). Importers rewritten mechanically. `offers`, `settlement`, `common` and `connector` no
  longer sit in a module-level import cycle (24 api modules in cycles before, 20 after).
  `pos-shifts/shift-money` and `shift-cash-arithmetic` move after RT-1453's #678 merges. No route,
  contract, table or wire change.
