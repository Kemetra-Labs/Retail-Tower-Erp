### Changed
- RT-451 (production config): the production compose passes
  `POS_TRACKED_SELLING_ENABLED` to the API, defaulting to `false`, and
  `deploy/prod.env.example` documents it. Before this the compose's explicit
  environment list dropped it, so the tracked-selling deployment gate could not
  be set from `backend.env` on a deployed environment. Behaviour is unchanged
  until an environment sets the flag; tracked selling is still in effect only
  while a tenant has also switched it on.
