### Changed
- RT-1367 PR 2 `[GATED: contract]` (Jira RT-1367 scope item 4, owner decision OD-11 "Hybrid", 2026-11-12; the
  Connector half, RT-1340 phase 2, merged in #584 and runs in the lab since `lab-2026.11.8`): `recordReturn` now
  records a return of a promoted sale with an offer clawback (option A), a Hybrid give-back (golden sequence S3 step 2:
  refund 200.00 = net 120.00 + give-back 80.00) or a reward line returned at its net. The interim 422
  `promotion_return_requires_clawback` refusal is removed (the code is no longer returned; `sales.yaml` keeps it listed
  so older clients' mapping stays valid); OD-10 `promotion_clawback_exceeds_refund` stays. The returns integration spec
  runs every golden return step end to end and projects each accepted return through the production `buildWorkItem`:
  the feed lines carry the vector's `promotionClawbackAmount` / `promotionGiveBackAmount` and `refundTenders` =
  Σ `lineAmount` − Σ clawback + Σ give-back. No migration, no contract version change.
