### Added
- RT-1115 `[GATED: edge template]`, owner decision on RT-1082 (2026-11-03): the Caddy edge
  serves the POS lab update feed at `/pos-feed/lab/` as plain static files (HTTP `Range`,
  `no-cache`, no SPA fallback) from a read-only `POS_FEED_DIR` mount. The route and the mount
  are inert unless the host sets `POS_FEED_DIR`.
