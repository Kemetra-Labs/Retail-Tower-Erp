### Removed
- RT-878 `[GATED .github]`, owner authorization 2026-10-25 (wave after RT-877, "Pr and
  merge auhtrized", option "retire YAML, keep tooling" for the lab deploy): the product's
  nested `.github/` is gone. GitHub runs only the monorepo's root workflows, so `ci.yml`,
  `api-fuzz.yml`, `clean-stale-caches.yml`, `scorecard.yml`, `update-loc-badge.yml`,
  `release-images.yml` and `deploy-lab.yml`, the PR and issue templates and
  `.github/scripts/ci-tier.sh` never ran here. Their root replacements are
  `backend-core.yml` (graph-selected), `api-fuzz-nightly.yml`, `clean-stale-caches.yml`,
  `scorecard.yml` and `release-backend-core.yml`. The lab deploy workflow is retired until
  it is rebuilt on the monorepo release; `deploy/lab/verify-release.cjs`,
  `deploy/release-compat-gate.cjs`, the SSM documents and their tests stay. The LOC badge
  script and badge, the one-time `ci-wiring.test.py` and the workflow checks in
  `deploy-lab.spec.ts`, `lab-ssm-documents.spec.ts` and `release-images.spec.ts` (now
  `release-bundle.spec.ts`, compose and bundle checks only) are removed with them.
