### Changed
- RT-1212: one `requireRedisUrl` helper in `packages/shared` replaces the repeated throw-in-production / fall-back-in-dev REDIS_URL guard in the api and worker factories and the worker scheduler base; error messages and dev fallbacks are unchanged.
