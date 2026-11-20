### Changed
- RT-1513: the legacy instant transfer (`createStockTransfer`) answers 409 `transfer_workflow_required` once a tenant has
  shipment transfers on (one writable transfer workflow, 976); history is kept. The posting feed offers the two new work-item
  kinds, and a confirmed dispatch releases the receipt legs that waited for it. The `x-runtime-status: contract-only` marker
  of the nine operations is lifted; the contract gains the `transfer_item_unmapped` refusal text.
