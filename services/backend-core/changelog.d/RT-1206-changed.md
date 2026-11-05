### Changed
- RT-1206 `[GATED]`, owner confirmation Jira RT-1206 comment 15587 (RT-148 ruling
  2026-10-02): `captureSale` answers a provenance replay whose sale facts hash
  differently from the stored `payload_hash` with 409 `idempotency_key_conflict`
  instead of 200 with the stored sale (`pos-sales/sales.yaml` 1.18.0-draft). The
  mismatch is counted in `idempotency_conflict_total` and audited as
  `sale.replay_payload_mismatch_rejected`. Identical replays, the stored hash and the
  store-scope order are unchanged.
