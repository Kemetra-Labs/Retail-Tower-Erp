### Fixed
- RT-1603: the lab deploy SSM document (`deploy/lab/ssm/RT-BackendLabDeploy.yaml`) now checks the
  target release's prerequisites in a read-only G-Prereq gate, before it backs up or swaps anything
  on lab-01: `deploy/apply-domain-grants.sh --check-env` (new mode: the grants step's environment
  checks without psql) and the new `docs/operations/sql/release-prerequisites.sql` (the role
  migration 0132 needs, in a read-only transaction; shipped in the release bundle and run as Deploy
  step 0). A run that stops after the wrapper/env swap but before `up -d` now restores the
  pre-deploy wrapper and `backend.env`, then takes the auto-revert's outcome claim and stops its
  timer, so a rerun needs no manual restore. The owner publishes the new document version.
