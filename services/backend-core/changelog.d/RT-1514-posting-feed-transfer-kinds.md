### Added
- RT-1514 `[GATED: contract]`, owner authorization in chat 2026-11-19 ("One gated PR"): the posting feed
  `erpnext-connector/posting-feed.yaml` (1.17.0-draft) adopts the two shipment-transfer work-item kinds
  `transfer_dispatch` and `transfer_receive`, reserved in 1.16.0-draft by RT-1512. `PostingWorkItem.kind` gains
  both values, with the optional `transfer` and `receipt` bodies and one conditional per kind (each carries its
  own body and no other, and its leg-level `externalId`). The ack is unchanged. The Connector posts them as
  ERPNext's native goods-in-transit pair; Backend-Core still emits neither (RT-1513), and the Connector keeps
  advertising only `sale_post`, `reversal` and `inventory_count` in its heartbeat until RT-1513 widens that enum.
