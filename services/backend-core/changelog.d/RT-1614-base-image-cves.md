### Security
- RT-1614 `[GATED]`, owner authorization 2026-11-27: bump the `node:24-bookworm-slim`
  base image digest in `Dockerfile` (built 2026-11-24) to clear the apt
  (CVE-2026-109518) and libpam (CVE-2025-6020) findings in the api, worker and
  migrate images.
