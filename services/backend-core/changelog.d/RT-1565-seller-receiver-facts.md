### Added
- RT-1565 `[GATED: contract]` `[GATED: migration]`, owner approval on RT-1565 comments 18562 and 18563 (RT-285 F-1,
  owner decisions OQ-1, OQ-2 and OQ-5): `pos-sales/sales.yaml` 1.29.0-draft adds an optional seller per sale line
  (`CaptureSaleLine.sellerUserId`) and an optional payment receiver per tender (`SaleTender.receivedByUserId`, absent
  meaning the Transaction Operator). Neither is part of the payload hash. Each named member must not be revoked or
  deleted at `occurredAt`, and must have access to the sale's store, else 422 `sale_seller_refused` with nothing
  recorded. Migration 0133 stores the seller frozen with the sale's store and the member's role
  (`sale_lines.seller_user_id`, `seller_store_id`, `seller_role_id`), the receiver (`sale_tenders.received_by_user_id`)
  and a tenant-unique `memberships.seller_code` for the coming till roster (RT-1567). `readSale` returns
  `SaleLine.seller` and `SaleTender.receivedByUserId` when recorded. The credit-return four-eyes check now names the
  sale's Transaction Operator `operatorUserId` (was `sellerUserId`); the rule is unchanged and stays bound to
  `sales.created_by` (RT-285 OQ-5). No POS, Console, Connector or commission change.
