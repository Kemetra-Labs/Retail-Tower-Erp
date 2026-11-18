### Changed
- RT-1454 `[GATED: package.json]`: `stores/deletion` and `console-force-actions` no longer import each
  other. The shared Console 429 (`ConsoleActionRateLimited`, `consoleRateLimited`) and the force-action
  cap and audit writer (`enforceForceActionCap`, `insertForceActionAudit`) moved unchanged to the
  neutral `apps/api/src/console-action-cap/`. Same 429 shape and the same cap (10 per tenant per
  hour). `pnpm lint:eslint` now also runs `pnpm lint:cycles` (`tools/import-cycles/`), which fails on a
  new circular import between files or between top-level modules of `apps/*/src`; the cycles that
  already exist at module level are listed in a shrink-only `baseline.json`.
