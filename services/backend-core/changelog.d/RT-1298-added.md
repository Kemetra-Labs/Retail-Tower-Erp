### Added
- RT-1298 `[GATED: contract]`, owner authorization in the issue (RT-1290 slice P2b, owner decision D-5a): the POS pilot release
  registry writes that RT-1292 left `contract-only` are now served. `platformRegisterPilotRelease` and
  `platformWithdrawPilotRelease` are called by the owner-run promotion workflow, which authenticates with its **GitHub OIDC
  token** (no stored secret): the api verifies it with `jose` against GitHub's key set (RS256, issuer
  `https://token.actions.githubusercontent.com`, the configured audience, unexpired and at most 15 minutes old) and pins the
  `repository`, `environment`, `ref` and `job_workflow_ref` claims to `POS_PILOT_PROMOTION_OIDC_*`. A token that cannot be
  authenticated is 401; a genuine token with other claims, or a register body naming another run than the token's, is 403;
  while any pin is unset no token is accepted. Register writes one immutable row (201), answers an equal replay with 200,
  refuses a conflicting version or digest (409) and a lab or production class or lab-marked publisher (422), derives the
  object key, and audits once (`pos.pilot_release.registered`, actor label `github-oidc:<login>`). Withdraw sets `approved`
  to false for good. `platformActivatePilotRelease` is a platform admin on the Console session: one current release at a time
  (409 `release_current_exists`, `release_withdrawn`), replays write nothing. The contract drops the three `contract-only`
  markers and describes the OIDC scheme. New outbound call from the api to `token.actions.githubusercontent.com` (the key set
  is cached with a refetch cooldown), accepted with D-5a. `docker-compose.prod.yml` passes the five pins to the api service only;
  `deploy/README.md`, `deploy/prod.env.example` and `docs/operations/pos-pilot-release-bucket.md` document them. No migration:
  the 0088 insert and update policies and the existing `audit_events.actor_label` are used. No dependency change.
