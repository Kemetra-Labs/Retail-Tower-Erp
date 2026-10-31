### Security
- RT-985 `[GATED]`, owner authorization 2026-10-30: clear the critical/high dependency
  findings the GitLab dependency scan reports on `pnpm-lock.yaml` that RT-935 did not cover,
  with same-major bumps only. All of them are dev/test-only (`testcontainers`, `ajv`,
  `supertest`, `eslint`); none is in the `pnpm deploy --prod` graph the runtime images
  ship. Lockfile-only re-resolution: `undici` 7.25.0 to 7.30.1, `fast-uri` 3.1.2 to 3.1.9,
  `brace-expansion` 1.1.14 to 1.1.21 (and 2.1.0 to 2.1.7, flagged by `pnpm audit`),
  `protobufjs` 7.5.6 to 7.6.6, `form-data` 4.0.5 to 4.0.6, `tmp` 0.2.5 to 0.2.7. One scoped
  `pnpm.overrides` entry, `@grpc/grpc-js@<1.14.5` to 1.14.6, moves the `dockerode` copy
  onto the version the OpenTelemetry exporters already use; it is inert once `dockerode`
  resolves a fixed version. Not changed, pending owner decision or fix: `zod` 3.23.8 and
  `uuid` 10.0.0 (major bumps) and `braces` 3.0.3 (no fix published).
