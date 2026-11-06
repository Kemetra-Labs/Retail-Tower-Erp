### Added
- RT-1230 `[GATED]`, owner authorization Jira RT-1205 decision 1 and RT-1230
  comments 15798 and 15800 (2026-11-06; RT-160 D-2): `POST
  /api/pos/v1/audit-events` (contract 1.3.0-draft) accepts the privileged,
  security and exception POS actions that reach central audit:
  `manager_approval.granted`, `manager_approval.refused`,
  `payment.recovery_completed`, `payment.recovery_cancelled`,
  `cart.held_cancelled_by_manager`, `cart.cancel.post_handoff`,
  `sale.receipt.manual_override`, `sale.void.requested`,
  `payment.force_failed`, `tender.reversed` and `tender.reversal_pending`.
  Each payload has a closed key set taken from the shape the POS writes; a
  payload that breaks it is rejected per event with `schema_violation`. The
  contract now documents `schema_violation`, including an unsupported
  category, as non-retryable. The 7 existing categories, auth and RLS are
  unchanged.
