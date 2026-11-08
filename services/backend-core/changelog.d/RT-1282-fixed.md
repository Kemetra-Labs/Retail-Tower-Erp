### Fixed
- RT-1282 `[GATED: deploy config]`: a Backend-Core lab deploy now recreates the Datadog agent
  (opt-in compose profile `datadog`) when it was running and the release's compose files changed,
  so a new OpenMetrics check (such as the RT-1281 worker scrape) takes effect without a manual
  `--force-recreate`. The step runs after the auto-revert is cancelled, reports
  `RT_GATE datadog-agent pass|skip|fail`, and never stops or rolls back the deploy. The owner
  must publish the new `RT-BackendLabDeploy` version in AWS before it applies.
