### Added
- RT-1571 `[GATED: contract]` `[GATED: migration]`, authorized under the owner's delegation (RT-1588 comment 18881
  item 9; RT-1571 comment 18901; RT-285 F-7, owner decision OQ-8, RT-740 lineage): a captured line's manual
  discount (`CaptureSaleLineDiscount`: kind, value, amount, reason code, authority source, approver role and, when
  sent, the approver's user id) is now stored on the sale line as sent (migration 0134, seven `sale_lines.discount_*`
  columns, whole or absent, no backfill) and returned. `pos-sales/sales.yaml` 1.30.0-draft adds the optional
  `SaleLine.discount` (`SaleLineDiscount`) to `captureSale` and `readSale`; `pos-sales/sale-history.yaml`
  1.2.0-draft and `console-sales.openapi.yaml` 1.4.0-draft add the optional `SaleHistoryLine.discount` without the
  approver's user id. The request, its validation, the payload hash and the replay rules are unchanged; a line
  captured before 0134 reads with no `discount` ("not recorded"). No POS, Console or Connector change.
