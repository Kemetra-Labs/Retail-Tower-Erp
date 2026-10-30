### Changed
- RT-983 (production config, owner decision 2026-10-30): the production
  compose passes `POS_SALE_TENDERS_ENABLED` and
  `POS_SALE_TENDERS_SAME_METHOD_ENABLED` to the API, both defaulting to
  `false`, and `deploy/prod.env.example` documents them. Before this the
  compose's explicit environment list dropped them, so the RT-77 tender gate
  could not be turned on from `backend.env`, and a POS that sends `tenders` got
  400 on every sale. Behaviour is unchanged until an environment sets the flag.
