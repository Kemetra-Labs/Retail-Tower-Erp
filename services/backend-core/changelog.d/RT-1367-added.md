### Added
- RT-1367 `[GATED: contract]`, owner decision in the RT-286 coordinating session (2026-11-12, OD-11 "Hybrid") and Jira RT-1367 (RT-286 spec 048 slice S8, contract half):
  the posting feed `erpnext-connector/posting-feed.yaml` is 1.13.0-draft. `ReturnLine` gains two OPTIONAL non-negative
  amounts, `promotionClawbackAmount` (option A: the line's part of the offer clawback, a reduced credit-note rate) and
  `promotionGiveBackAmount` (Hybrid: the discount of an earlier clawback that a returned reward unit gives back, a
  non-stock "promotion give-back" row), both omitted when 0. `refundTenders` = Σ `lineAmount` − Σ clawback + Σ
  give-back. Backend-Core derives the per-line split from stored rows (no migration) with one allocation rule, written
  in `pos-sales/sales.yaml` `recordReturn` and spec 048 §9: the clawback of an offer goes to its returned non-reward
  lines in proportion to their `lineAmount` (reward lines only on overflow), the give-back of an offer to its returned
  reward lines in proportion to the discount returned now, in whole minor units, largest remainder first. Golden
  vectors S3 step 2 now read refund 200.00 = net 120.00 + give-back 80.00, with `giveBack` and `feedLines` on every
  step. The 422 `promotion_return_requires_clawback` refusals stay: no work item carries either field until the
  Connector supports them (Connector first, RT-1340), and a second change then lifts the refusals.
