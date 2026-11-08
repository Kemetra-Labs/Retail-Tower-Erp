### Changed
- RT-451 follow-up (captain decisions, RT-451 comment 16246; owner delegation
  RT-1283 comment 16225), aligning the lot lookup with the TLV:
  - `posListTrackedLots` applies the Store Override's `is_active`, as the TLV
    does: a product inactive at the caller's store lists no lots (a 200 with an
    empty list), where the TLV refuses them as `not_sellable`.
  - Fail closed on a missing expiry: for a product that requires one
    (`expiry_required`), a lot without an `expiryDate` is never listed, never
    suggested by FEFO, and the TLV refuses it as `expired`.
  - `pos-sales/tracked-lines.yaml` [GATED: contract], wording only (no shape
    change, no new refusal code): the expiry rule, the TLV check order, the
    `expired` reason and the lot list name both cases.
