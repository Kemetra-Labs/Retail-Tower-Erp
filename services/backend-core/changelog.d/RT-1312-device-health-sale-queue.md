### Added
- RT-1312 (Phase 1, RT-1124 finding F1): the POS heartbeat (`POST /api/pos/v1/terminals/heartbeat`)
  accepts an optional `sale_queue` (pending, dead-letter and held-previous-pairing sale counts plus
  the oldest pending sale's time), stored on `device_health` (migration `0090`, nullable columns)
  and shown as `saleQueue` on the console device health reads. A beat without it reads
  `saleQueue: null` (unknown), never zeros. Counts only: no sale id or amount.
  `pos-device-health.openapi.yaml` is `1.1.0-draft`; `pos_contract_revision` is 2, and a POS sends
  `sale_queue` only after a reply carried revision 2.
