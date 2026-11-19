### Fixed
- RT-1312 Phase 3(b), slice B `[GATED: contract]`: `posQuarantineSale` refuses an upload that
  holds a NUL (U+0000) character, in the sale body or in `sourceSystem` / `externalId`, as a
  400 `validation_error` before anything is stored (Postgres cannot store it in `jsonb` or
  `text`); the sale stays on the till. `pos-sales/sale-quarantine.yaml` now names this cause
  under `ValidationFailure`.
