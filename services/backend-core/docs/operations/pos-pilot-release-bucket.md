# POS pilot release bucket: setup, key and rotation (RT-1297)

The pilot installer is served to allowlisted pilot tenants through a **private** S3 bucket and a
short-lived presigned URL signed by the api (RT-1292 resolver, RT-1297 presigner). This runbook is the
owner's one-time setup and the key rotation. Authority: Jira RT-1297 (slice P2a of RT-1290) and the
owner decision of 2026-11-09 recorded on RT-1290: the api reads with a **scoped IAM user key**, because
the lab hosts are SSM hybrid managed nodes (`mi-…`), not EC2, so no instance role exists. If this page and
`main` disagree, `main` wins and this page is corrected. No key, secret or account id belongs in this file.

Not covered here (later slices): putting a release into the bucket (the promotion workflow and its upload
role), registering, activating or withdrawing a release, and the Console page. Until those exist, nothing
is in the bucket and the lane answers `{ "available": false }` whatever is set below.

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
2. **Create the bucket** with a name you choose, in the lab region:
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
- only the `api` container has the `POS_PILOT_RELEASE_*` names. List **names only** (a bare
  `docker inspect` prints values): `docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' dp2-api | cut -d= -f1 | grep POS_PILOT_RELEASE`.
  The same command on `dp2-worker` must print nothing.

An end-to-end download from the lab is proven only after a release can be registered (a later slice,
RT-1290 check V-7); this change alone cannot register one.

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
