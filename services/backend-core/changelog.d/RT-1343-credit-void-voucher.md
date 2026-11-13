### Changed
- RT-1343 `[GATED: contract, migration]`, owner decisions in chat 2026-11-12 (item 2; a blocker
  before `POS_SALE_VOUCHER_TENDER_ENABLED` can be turned on): a voucher-paid credit sale can now
  be voided. `CreditReversalRefundTender.method` gains `voucher` (`pos-sales/sales.yaml`
  1.24.0-draft; migration 0107 widens `sale_credit_reversal_tenders_method_valid`), so a credit
  `void` mirrors a `voucher` sale tender; only `card_external` carries a `reference`, and a credit
  `return` stays cash only. A created credit void RESTORES each voucher in its own transaction, as
  `recordVoid` does since item 3: the redemption is reversed by the requesting device and the
  voucher is `active` again, with one `voucher.reversed` audit row naming the sale and the void's
  operator. `recordCreditSaleReversal` now takes the verified device (`posDeviceId`) and refuses a
  request without one (401).
