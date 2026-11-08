### Changed
- RT-1282 `[GATED: deploy config]`: the lab deploy document `RT-BackendLabDeploy` now recreates
  the Datadog agent after the auto-revert is cancelled, when the agent is running and the
  release's compose files differ from the current release's. Before, `up -d` never recreated the
  opt-in `datadog` profile, so the agent kept its old check config (the `backend-core/v0.7.0`
  deploy left it without the worker scrape). The step reports `RT_GATE datadog-agent
  pass|skip|fail`, never stops or reverts a deploy, never pulls an image and never renders
  compose config. The owner still publishes the new document version in AWS.
