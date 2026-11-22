### Changed
- RT-1549 `[GATED: contract]`: the posting-feed contract `erpnext-connector/posting-feed.yaml` (1.17.0-draft,
  description only) drops the RT-1514 statement that the Connector keeps advertising only `sale_post`, `reversal`
  and `inventory_count` in its heartbeat. Since RT-1519 (connector-health 1.3.0-draft) the heartbeat lists
  `transfer_dispatch` and `transfer_receive` too, and the Connector advertises every kind it accepts. The new
  note says Backend-Core may emit the two transfer kinds only for a tenant whose Connector reports both. No
  schema, enum, example or operation changes.
