### Added
- RT-1055 `[GATED]`, decisions LS-1 to LS-5 selected under the owner delegation
  of 2026-11-02 (recommended options): contract-only draft
  `inventory/low-stock.yaml` (`1.0.0-draft`), `consoleListLowStock`
  (`GET /api/v1/inventory/low-stock`), the Admin-Console Overview low-stock
  read: (store, product) pairs below their reorder level, `critical` before
  `low`, then the on-hand / reorder-level ratio, bounded top-N, with unknown
  and negative on-hand counted and never listed. Decision record
  `docs/planning/rt-1055-low-stock-severity-read.md`. No runtime, no
  migration; the threshold fields and the runtime are follow-ups.
