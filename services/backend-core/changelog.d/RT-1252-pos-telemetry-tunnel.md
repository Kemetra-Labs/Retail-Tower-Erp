### Added
- RT-1252 `[GATED]` (OpenAPI and env/compose, owner approval on RT-1252 comment 15673): POS
  device telemetry tunnel. `pos-telemetry.openapi.yaml` adds `posGetTelemetryConfig` and
  `posForwardTelemetryEnvelope` (`device` bearer only). Paired terminals report errors through
  Backend-Core to Sentry project `kemetra/pos`, so terminals never hold a DSN. The tunnel reuses
  the Console tunnel's allowlist rebuild, stamps `service=pos` and the server-minted
  `tenant_ref`/`store_ref`/`terminal_ref` HMAC refs (OBS-1 §1 "POS fleet refs", RT-1251), drops
  an event captured under another device, and applies per-device and global rate limits. New
  optional settings `POS_SENTRY_DSN` and `POS_TELEMETRY_REF_KEY`; either empty keeps it inert.
