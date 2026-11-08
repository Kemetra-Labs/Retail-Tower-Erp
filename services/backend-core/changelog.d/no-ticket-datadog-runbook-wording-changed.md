### Changed
- The Datadog monitor, Synthetics and lab dashboard definitions (`deploy/datadog/`) now name this
  repository (`services/backend-core/deploy/datadog/README.md` in `Kemetra-Labs/Retail-Tower-Erp`)
  as the runbook and source of truth, instead of the frozen `Kemetra/Backend-Core`. Text only: no
  query, threshold, tag or recipient changes. The new text reaches Datadog the next time the owner
  runs `deploy/datadog/apply.mjs`.
