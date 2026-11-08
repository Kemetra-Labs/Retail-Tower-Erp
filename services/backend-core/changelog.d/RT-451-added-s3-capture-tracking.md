### Added
- RT-451 S3 capture tracking `[GATED: migration]` (captain decisions under owner
  delegation, RT-451 comments 16262, 16269 and 16275; migration M2 with the content of comment
  15288's S3 row):
  - Migration `0089_sale_capture_tracking`: the frozen tracking snapshot and
    G7-9 class on `sale_lines`, `sales.safety_revision` / `safety_synced_at` /
    `tracking_status`, and the append-only `sale_line_findings` table (FORCE
    RLS, SELECT and INSERT only). All new columns are nullable, with NOT VALID
    CHECKs and no backfill. The down migration refuses while any tracked sale
    data exists, and it can be re-run. Grant fragment and deploy step
    `docs/operations/sql/sale-line-findings-domain-grants.sql`: SELECT and
    INSERT on the findings, plus SELECT on `erpnext_tracking_map`.
  - `captureSale` accepts `CaptureSaleLine.tracking` and the request's
    `safetyRevision` / `safetySyncedAt`:
    - The safety pair is provenance. It is kept out of `payload_hash`, stored
      first-write-wins and echoed on `Sale`.
    - `tracking` is part of `payload_hash`, so a replay with different tracking
      is 409. It is frozen on the line and echoed as `SaleLine.tracking`.
  - While tracked selling is on (the deployment gate AND the tenant switch),
    every line is classified by G7-9 with its precedence:
    - row 1 is valid;
    - rows 2 and 3 record one critical sale-line finding per cause:
      `validation_missing`, `validation_mismatch`, `quality_hold`, `recall_hold`
      at `occurredAt`, `expired` at the business date (a missing required
      expiry fails closed) and `edge_map_missing`;
    - row 4 (`tracking_missing`, `identity_unknown`, `identity_other_product`)
      makes the sale `tracking_unresolved` and writes no finding.
  - While tracked selling is off, a tracked product's line, with or without
    `tracking`, is an ordinary line: nothing is classified or refused, and a
    sent `tracking` is stored as received (provenance, still hashed)
    (sales.yaml 1.21.0, OD-T4; RT-451 comment 16269).
  - The Tracking Profile setter lifts `409 tracking_activation_pending` for
    `batch` only, while tracked selling is on. `serial` stays refused (RT-50
    Q11; comment 16275).
  - An ad-hoc line (no tenant product) is never classified. A `tracking` on it
    is stored as received (provenance), with no finding and no
    `tracking_unresolved` (comment 16275).
  - A per-product capture/profile advisory lock is added (comment 11790):
    capture takes it shared and the setter exclusive. A first sale line and a
    profile change can therefore never both commit unseen by each other.
  - Out of scope, and still to come: withholding the effects and the posting
    intent of a row-3 or row-4 sale (S4, S6) and Tracking Resolution (S5).
