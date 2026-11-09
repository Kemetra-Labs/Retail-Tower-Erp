### Added
- RT-1297 `[GATED: deps/lockfile]`, owner authorization in the issue (RT-1290 slice P2a): the S3 presigner of the POS pilot
  release lane, which RT-1292 left unbound. With `POS_PILOT_RELEASE_S3_REGION`, `POS_PILOT_RELEASE_S3_ACCESS_KEY_ID` and
  `POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY` all valid, the api signs a presigned download URL for the current pilot release:
  one verified object version, an attachment disposition and a lifetime of 1 to 900 seconds, checked before anything is
  signed. The key is passed to the SDK explicitly, so no ambient `AWS_*` setting can sign; a missing, partial or malformed
  key leaves the lane off (`{ "available": false }`) and logs only a closed reason. A presign failure carries the SDK error
  name only. New dependencies `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (3.1156.0, the worker's SES SDK line).
  `docker-compose.prod.yml` now passes the pilot lane settings, including the three S3 values, to the api service only (they
  were unmapped, so the lane could not be switched on); `deploy/prod.env.example`, `deploy/README.md` and
  `docs/operations/pos-pilot-release-bucket.md` document them with the bucket and read-only IAM setup and the key rotation.
  No contract, migration or eligibility change: registering, activating and withdrawing a release stay `contract-only`.
