# POS pilot release bucket: setup, key and rotation (RT-1297)

The pilot installer is served to allowlisted pilot tenants through a **private** S3 bucket and a
short-lived presigned URL signed by the api (RT-1292 resolver, RT-1297 presigner). This runbook is the
owner's one-time setup and the key rotation. Authority: Jira RT-1297 (slice P2a of RT-1290) and the
owner decision of 2026-11-09 recorded on RT-1290: the api reads with a **scoped IAM user key**, because
the lab hosts are SSM hybrid managed nodes (`mi-…`), not EC2, so no instance role exists. If this page and
`main` disagree, `main` wins and this page is corrected. No key, secret or account id belongs in this file.

Registering, activating and withdrawing a release are in section 7 (RT-1298). Not covered here (later
slices): putting a release into the bucket (the promotion workflow and its upload role) and the Console
page. Without an approved and activated release the lane answers `{ "available": false }` whatever is set
below. The converse does not hold: `available: true` only says a release is registered and activated. The
api does not check that the referenced object version exists in the bucket (the promotion workflow verified it
before registering), so a missing or deleted object shows up as a failed download, not as `available: false`.

## 1. What each piece may do

| Piece | Allowed | Never |
|---|---|---|
| Pilot bucket | Hold `pos/pilot/<version>/<file>` objects, versioned, encrypted | Be public, be read through the account root, hold anything outside `pos/pilot/` |
| Read user (this runbook) | `s3:GetObject` and `s3:GetObjectVersion` on `pos/pilot/*` | List, write, delete, or touch any other bucket or service |
| Presigned URL | One object version, 1 to 900 seconds (default 300), as an attachment | Be logged, stored, audited or cached |

## 2. One-time owner setup (AWS console, a non-root identity)

Create everything with an IAM identity that is **not** the account root, and do not create a root access
key for this. Region: `us-east-1` for the lab (the region of the registered lab nodes).

1. **Account-level Block Public Access:** in S3, "Block Public Access settings for this account", turn all
   four settings on. (On 2026-11-09 the account had none configured; check before you rely on it.)
2. **Create the bucket** with a name you choose, in the lab region. Use lower-case letters, digits and
   hyphens only, **no dots**: the Console CSP allows the bucket's virtual-hosted origin
   `https://<bucket>.s3.<region>.amazonaws.com` as its only `frame-src` (RT-1305), and a dotted name
   gets no `frame-src`, so the Console's Download POS hand-off would be blocked.
   - Object Ownership: **Bucket owner enforced** (ACLs disabled).
   - Block Public Access: all four settings **on**.
   - Versioning: **Enabled** (the resolver presigns a `VersionId`, so a replaced object is never served
     under the digest of the verified one).
   - Default encryption: **SSE-S3** (not SSE-KMS: the read user would then also need `kms:Decrypt`).
3. **Bucket policy:** refuse every request that does not use TLS. Replace `<bucket>` with the bucket name.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "DenyInsecureTransport",
         "Effect": "Deny",
         "Principal": "*",
         "Action": "s3:*",
         "Resource": ["arn:aws:s3:::<bucket>", "arn:aws:s3:::<bucket>/*"],
         "Condition": { "Bool": { "aws:SecureTransport": "false" } }
       }
     ]
   }
   ```

4. **Create the read policy** (IAM, "Create policy", JSON) and an IAM **user** with no console access that
   has only this policy. Replace `<bucket>`.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "ReadPilotReleases",
         "Effect": "Allow",
         "Action": ["s3:GetObject", "s3:GetObjectVersion"],
         "Resource": "arn:aws:s3:::<bucket>/pos/pilot/*"
       }
     ]
   }
   ```

5. **Create one access key** for that user (use case "Application running outside AWS"). The secret is
   shown once, in the console, to you only. Copy it straight into the host env file (next section); never
   through chat, a ticket, a PR or an SSM Run Command parameter, which keep their content.

## 3. Put the settings on the host

On lab-01 (and any other host that runs the api), edit the root-only env file in place with an editor;
do not echo a value and never `cat` the file. On the lab it is `/root/rt-lab-secrets/backend.env`
(mode `0600`). Set:

```
POS_PILOT_RELEASE_PUBLISHER=<the pilot Authenticode subject, exactly as the signing certificate carries it>
POS_PILOT_RELEASE_BUCKET=<bucket>
POS_PILOT_RELEASE_S3_REGION=us-east-1
POS_PILOT_RELEASE_S3_ACCESS_KEY_ID=<the key id>
POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY=<the secret>
```

`POS_PILOT_RELEASE_URL_TTL_SECONDS` is optional (integer 1 to 900; blank means 300). Then recreate the
api so it re-reads the file, for example `/opt/rt-lab/backend/dc up -d --force-recreate api`, and confirm
the container is healthy. The lab deploy backs up `backend.env` before each live run (runbook step 6 in
`deploy/README.md`), so a key written here is in those backups too.

Check, without printing a value:

- the api log has **no** `pilot release …` warning at boot (`presigner not bound: credentials_partial`
  or `region_invalid`, `lane is configured but the presigner is not bound`, or `presigner is bound but
  the lane is off`: each means a value is missing or malformed and the lane is still off);
- only the `api` container has the `POS_PILOT_RELEASE_*` and `POS_PILOT_PROMOTION_*` names. List **names
  only** (a bare `docker inspect` prints values): `docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' dp2-api | cut -d= -f1 | grep 'POS_PILOT_'`.
  The same command on `dp2-worker` must print nothing.

An end-to-end download from the lab is proven only after a release has been put into the bucket by the
promotion workflow (a later slice) and registered and activated (section 7): RT-1290 check V-7.

## 4. Rotate the key

1. In the AWS console create a **second** access key for the same user (a user holds at most two).
2. Write the new key id and secret into the host env file, replacing the old ones.
3. Recreate the api (`up -d --force-recreate api`) and confirm it is healthy with no
   `presigner not bound` line.
4. Delete the **old** access key (this also invalidates any URL still signed with it: the api issues URLs of at
   most 15 minutes, but a leaked key could sign longer ones, and deleting the key kills those too). Purge
   the old value from every `backend.env` backup copy the lab deploy made.

At once, and not on a schedule, if the key may have leaked (a backup copy, a log, a shared screen): do
steps 1 to 4, then check CloudTrail for the old key id. A leaked read key can fetch only objects under
`pos/pilot/*`, and only by naming the exact key (any version of it, the latest included); it cannot list
the bucket or write.

## 5. Turning the lane off

Blank any one of the pin, the bucket or the three S3 values and recreate the api: the lane answers
`{ "available": false }` again. A URL the api already issued stays usable until its own expiry (at most 15
minutes) unless you also deactivate or delete the access key in AWS, which invalidates every URL signed
with it at once.

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Console gets `{ "available": false }` for an allowlisted tenant | Any of the pin, the bucket or the S3 values is blank; no release is registered and activated; or the tenant is not on the allowlist. The answer never says which. |
| Log line `pilot release presigner not bound: credentials_partial` | One of the key id and the secret is blank, or the region is set without the key. |
| Log line `pilot release presigner not bound: region_invalid` | `POS_PILOT_RELEASE_S3_REGION` is not a region name such as `us-east-1`. |
| `POS_PILOT_RELEASE_URL_TTL_SECONDS` set to 3600 and the lane is off | The lifetime must be an integer of 1 to 900; it is never clamped. |
| The browser gets `AccessDenied` from S3 on a fresh URL | The user's policy does not cover `s3:GetObjectVersion` on `pos/pilot/*`, the object is outside that prefix, the key was deleted or rotated, or the version id is not the object's. |
| `SignatureDoesNotMatch` | The secret was copied with a stray space or line break, or the key id and secret belong to different keys. |
| `Request has expired` right after a URL is issued | The host clock is more than the lifetime (300 s by default) away from AWS time. Fix the host's time sync; do not raise the lifetime. |
| A bucket in another region than `POS_PILOT_RELEASE_S3_REGION` | S3 answers with a redirect or `AuthorizationQueryParametersError`, not a working download: set the region to the bucket's own. |

## 7. Registering, activating and withdrawing a release (RT-1298)

A release reaches the Console in three separate, audited steps. Registering never makes it downloadable.

| Step | Who | How it is authenticated | Audit action |
|---|---|---|---|
| Register | The owner-run promotion workflow | Its GitHub OIDC token (no stored secret) | `pos.pilot_release.registered` |
| Activate | A platform admin | The Console session cookie and a trusted `Origin` | `pos.pilot_release.activated` |
| Withdraw | The promotion workflow | Its GitHub OIDC token | `pos.pilot_release.withdrawn` |

**Pins.** Set the five `POS_PILOT_PROMOTION_OIDC_*` values on the host (section 3 shows where; none is a
secret). They must equal what GitHub puts in the token of the promotion job: the audience the workflow
requests, the repository, the protected approval environment of the job, the ref, and the
`job_workflow_ref`. The promotion workflow (a later slice) fixes the real environment and workflow names;
until it exists leave them blank, and every workflow write is 401. Check the api log at boot: there must be
no `pilot release promotion writes are off` line once you mean them to be on.

**Answers.** A token that cannot be authenticated is 401. A genuine token whose claims differ from the pins is
403, and so is a register body whose `promotionRunUrl` names another run than the token's. Nothing is written in
either case. A lab or production class, or a lab-marked publisher, is 422; the same version or digest with other
values is 409; an equal replay is a 200 that writes nothing.

**One current release.** At most one release is current. Activating while another is current is 409
`release_current_exists`; withdraw the current one first. A withdrawn release is never re-approved (409
`release_withdrawn` on activation): a fix ships as a higher version. Withdrawing stops the resolver at once.

**Activating.** There is no Console page yet. A platform admin calls
`POST /api/v1/platform/pos-pilot-releases/{releaseId}/activate` with their Console session; the response is the
release with `activatedAt` set. The tenants that may download it are the allowlist
(`PUT /api/v1/platform/pos-pilot-tenants/{tenantId}`, also a platform admin).

**What the pins do and do not prove.** GitHub's issuer is shared by every repository, so the pins are what make a
token yours: the exact `repository`, the `environment` the job runs in, the `ref`, and the `job_workflow_ref`
(the workflow file at that ref). Each is an exact, case-sensitive match against the claim as GitHub writes it
(the environment name too); a case mismatch is a 403 and the api never says why. They are sufficient only with
the GitHub-side settings that this code cannot check, so before the first registration confirm:

- the promotion environment has a **required reviewer** (you) and **deployment branches limited to `main`**;
- `main` is protected, and the promotion workflow is changed only through reviewed pull requests (CODEOWNERS
  already covers `.github/**`);
- the workflow is started only by `workflow_dispatch`, and no other trigger is added to that file (the pins
  cannot see the event name);
- the person who runs it is a **plain GitHub user account**: the token's `actor` and the body's `approvedBy` must
  be a GitHub login (letters, digits and single hyphens, at most 39 characters), so a bot account or an
  Enterprise Managed User login with an underscore is refused (403, or 400 for `approvedBy`);
- the workflow file name has no spaces (a pin with a space is refused at boot as `invalid`).

The `repository` is matched by name. If the organisation or repository were ever deleted or renamed and the
name re-registered by someone else, their repository would satisfy the pin: keep the names reserved. Pinning
the immutable `repository_id` and `repository_owner_id` claims as well is a cheap hardening the owner can ask for.

**Key rotation.** GitHub rotates its signing keys; the api fetches the key set on first use, caches it for 10
minutes, and refetches an unknown key at most every 30 seconds. A genuine token signed by a brand-new key that
arrives inside that window gets 401: the workflow's retry succeeds. While GitHub's key set cannot be fetched and
the cache has expired, every write is 401 (fail closed).

**Retry.** A register retry (same body, any `Idempotency-Key`) is a 200 with the stored release. The key is only
checked for shape: replay detection is by content. A retry of a withdrawn release is also a 200 and its
`approved` is `false`: read it, a release is never re-approved.

| Symptom | Likely cause |
|---|---|
| Register answers 401 | The token is missing, expired, for another audience or issuer, or GitHub's key set cannot be fetched from the host; or a pin is blank (see the boot warning). |
| Register answers 403 | A pin differs from the token's claim, or the body's `promotionRunUrl` names another run or repository. The api never says which. |
| Activate answers 409 `release_current_exists` | Another release is current: withdraw it first. |
| The tenant still gets `{ "available": false }` after activation | The tenant is not on the allowlist, the pin, bucket or S3 key (section 3) is blank, or the release was withdrawn. |

## 8. Verifying a pilot release before promotion: the dry-run (RT-1300)

`.github/workflows/promote-pos-pilot.yml` is, for now, **verify-only**. It cannot upload, register or
activate: it holds no environment, secret, AWS credential or id-token, its token is read-only, and it never
calls Backend-Core. Use it before the real promotion exists, and again before each live one.

**Run it** (Actions → promote-pos-pilot → Run workflow, any ref, it is read-only) with two inputs. A
manually started workflow can be dispatched only once its file is on the default branch, so the first run is
after the change that adds it is merged:

- `tag`: the published pilot release, `pos-pilot/vX.Y.Z`. The tag must exist and its commit must be on `main`.
- `leaf_sha1`: the SHA-1 thumbprint (40 hex) of the pilot signing leaf, as the `release-pos-pilot` signing step
  printed it (the same value as the `POS_PILOT_LEAF_SHA1` variable of the signing environment).

**What it checks, in order** (the first failure stops the run; no repository, release, S3 or registry state is
changed either way, and the output is informational: the workflow can be run from any ref):

1. The tag is `pos-pilot/vX.Y.Z` exactly (a lab tag or a look-alike is refused), its commit is on `main`, and the
   tag still points at that commit when the release is read.
2. The release is published (not a draft or a prerelease) and holds exactly the installer, its `.sha256` and
   `release-manifest.json`.
3. The manifest says product `pos-pilot`, signing `pilot`, mode `release`, this tag, this commit and this
   repository, with one artifact whose digest is the installer's; the `.sha256` matches the bytes; the size is 1
   byte to 2 GiB (the registry's limit).
4. `gh attestation verify` passes, bound to this repository, the `release-pos-pilot.yml` workflow (at this
   commit), this commit and this tag.
5. The installer's signer is the pinned leaf, subject `CN=Kemetra POS PILOT`, self-signed. Only then is that
   public leaf trusted, on the hosted runner only, so Windows can answer `Valid`; the status must be `Valid` and
   timestamped, and the trust is removed again whatever happens.

The run summary then states what a live promotion would do with these bytes (the object key
`pos/pilot/<version>/POS-Pulse-Setup-<version>.exe`, the SHA-256, the size and the registration fields) and that
nothing was uploaded, registered or activated.

**Not built yet** (a later, separately approved change to the same file, after the owner sets up the bucket, the
upload role and the protected promotion environment): the S3 upload, the second OIDC token and the register call.
That version must run on `main` only, because the Backend-Core `ref` pin is one exact value (section 7).

| Symptom | Likely cause |
|---|---|
| `tag ... is not on main` | The release was tagged on a commit that never reached `main`. |
| `the release assets are not exactly ...` | An asset was added to or removed from the release after it was published. Never edit a pilot release: ship a higher version. |
| `gh attestation verify` fails | The installer was not attested by `release-pos-pilot.yml` for this commit and tag, or the bytes differ from the attested ones. |
| `the installer is signed by another certificate` | `leaf_sha1` is wrong, or the installer was not signed with the pinned pilot leaf. |
