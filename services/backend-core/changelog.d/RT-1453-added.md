### Added
- RT-1453 `[GATED: package.json]`: `pnpm lint:module-boundaries` (run by `pnpm lint:eslint`) fails CI on a new
  deep import of another api module's internal file or a new raw SQL reference to another module's table in
  `apps/api/src`. The module map and table ownership are declared in `tools/module-boundaries/module-map.json`;
  today's violations are a shrink-only baseline that later PRs shrink by moving the reach-ins behind ports.
