### Changed
- RT-1223: `IdempotencyInterceptor.handle` is split into named steps
  (`resolvePolicyAndKey`, `handleInFlight`, `handleReplay`,
  `handleCollision`) behind a short dispatcher. Responses, metrics, audit,
  the RT-155 path-param key and the in-progress marker lifecycle are
  unchanged and pinned by a characterization matrix.
