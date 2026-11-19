### Changed
- RT-1312 (Phase 3): `pos_contract_revision` in the heartbeat reply is now 3. It tells a till that
  `posQuarantineSale` (`pos-sales/sale-quarantine.yaml`) is live and that the Console can show its
  queue, so a till may upload a sale Backend-Core refused, or one held after a re-pair. A till on an
  older build ignores the new value.
