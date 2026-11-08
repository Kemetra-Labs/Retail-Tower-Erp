### Added
- RT-451 slice S2 part 2 (owner approval RT-451 comment 16216; scope comment
  16236): the runtime of `posValidateTrackedLine`
  (`POST /api/pos/v1/tracked-line-validations`, `pos-sales/tracked-lines.yaml`),
  which drops its `x-runtime-status: contract-only` marker. It checks one lot
  of one product at the caller's store in the contract's order and answers 200
  `accepted` or `refused` with exactly one reason (`not_sellable`,
  `profile_mismatch`, `unknown_identity`, `wrong_product`, `recalled`, `held`,
  `expired`): sellable through its expiry date at the store's business date
  (G7-5), never refused on quantity (Q12), with the FEFO suggestion under
  `suggest` (G7-13). Every evaluated call writes one validation record. It
  accepts the operator envelope, or the device token with an `operatorUserId`
  claim verified as a cashier admission live at the server's now
  (`TrackedLineValidationAuthGuard`, a new reviewed composite); it is
  rate-limited per device (`posValidateTrackedLine`) and audited as
  `tracked_line.validated`. It answers only while the deployment gate
  `POS_TRACKED_SELLING_ENABLED` AND the tenant's switch (0086) are on;
  otherwise the non-disclosing 404, with nothing recorded.
- Migration `0087_tracked_line_validations` [GATED]: the append-only
  `tracked_line_validations` table (FORCE RLS, SELECT and INSERT policies only,
  same-tenant FKs to the store, the store's device and the product). Its down
  refuses while any record exists. Deploy step 2 runs the new
  `docs/operations/sql/tracked-line-validations-domain-grants.sql` (SELECT,
  INSERT); the API's boot grant check requires it.
- `pos-sales/tracked-lines.yaml` [GATED: contract], wording only (no shape
  change): the info block and the `NotFound` response name the two causes of
  the non-disclosing 404, the deployment gate and the tenant's switch
  (`tenant_inventory_settings.tracked_selling_enabled`,
  `setTrackedSellingSetting`).
