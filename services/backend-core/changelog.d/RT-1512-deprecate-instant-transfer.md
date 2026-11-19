### Deprecated
- RT-1512: `createStockTransfer` (`POST /api/inventory/v1/transfers`), the
  instant transfer, is not the target shipment workflow (decision 974). It
  keeps its route and behaviour until a tenant activates shipment transfers
  (RT-1513); RT-1517 removes it.
