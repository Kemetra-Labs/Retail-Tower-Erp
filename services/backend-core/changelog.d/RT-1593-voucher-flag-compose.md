### Changed
- RT-1593 (production config): the production compose now passes
  `POS_SALE_VOUCHER_TENDER_ENABLED` to the API as
  `${POS_SALE_VOUCHER_TENDER_ENABLED:-false}`, so a host can turn the voucher
  tender gate on from `backend.env`. Before this the compose's explicit
  environment list dropped it. The default stays off, so a deployment that does
  not set it behaves exactly as before. `compose-api-env.spec.ts` moves the name
  from its exclusion list to the default-equals-unset probes, and
  `deploy/prod.env.example` documents it. No code, contract, migration or
  Connector change.
