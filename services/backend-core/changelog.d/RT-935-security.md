### Security
- RT-935 `[GATED]`, owner authorization 2026-10-30: clear the fixable HIGH/CRITICAL
  Trivy findings in the `api` and `worker` image dependencies. Bumps `proxy-addr` 2.0.7 to
  2.0.8, `body-parser` 2.2.2 to 2.4.0, `multer` 2.1.1 to 2.5.0, `protobufjs` 8.0.1 to 8.4.1,
  `browserslist` 4.28.2 to 4.28.7, `@opentelemetry/propagator-jaeger` 2.7.1 to 2.9.0 and
  `@opentelemetry/exporter-prometheus` 0.216.0 to 0.217.0. The exact-pinned transitive ones
  (`multer`, `protobufjs` 8.x, `propagator-jaeger`, `browserslist`) use `pnpm.overrides`
  in the root `package.json`; the Trivy scan stays report-only.
