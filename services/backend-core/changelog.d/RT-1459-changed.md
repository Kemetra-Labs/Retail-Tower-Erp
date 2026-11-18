### Changed
- RT-1459 (architecture audit A-13): the POS pilot promotion OIDC verifier now also pins GitHub's immutable numeric
  `repository_id` and `repository_owner_id` claims, not the repository name alone. A token from a renamed-and-reused
  repository carries the same `repository` and `job_workflow_ref` names but another id, and is now 403. Two new pins,
  `POS_PILOT_PROMOTION_OIDC_REPOSITORY_ID` and `POS_PILOT_PROMOTION_OIDC_REPOSITORY_OWNER_ID` (decimal digits, no leading
  zero), are required with the existing five; while either is blank or malformed the promotion writes stay off (fail
  closed, 401, one boot warning with a closed reason). `docker-compose.prod.yml`, `deploy/prod.env.example`,
  `deploy/README.md` and `docs/operations/pos-pilot-release-bucket.md` list them. **Deploy order:** set both ids on the host
  before or together with the deploy, or promotion writes turn off. No contract, migration or dependency change.
