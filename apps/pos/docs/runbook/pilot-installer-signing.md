# Runbook — Pilot-signed installer: owner setup, release, rotation, revocation

How the **pilot-signed** per-user installer is produced, and what the owner does once and per release.
**Authority:** Jira RT-1294 (Work Mode: Implementation), from the RT-1290 planning note (Confluence page
"RT-1290 POS pilot authenticated download…", slice P4). If this runbook and `main` disagree, `main` wins and the
runbook is corrected. No secret, key, password or thumbprint belongs in this file.

## 1. What this is, and what it is not

- A CI path (`.github/workflows/release-pos-pilot.yml`, tag `pos-pilot/vX.Y.Z`) that builds the same fused,
  smoke-tested `win-unpacked` package as the lab release, signs it with a **self-signed pilot leaf**
  (`CN=Kemetra POS PILOT`), timestamps the signature, and publishes an **attested** release holding exactly:
  `POS-Pulse-Setup-X.Y.Z.exe`, its `.sha256` and `release-manifest.json` (`"signing": "pilot"`).
- **Not publicly trusted.** Windows does not trust this certificate by default, so the signature validates only on
  a device where the certificate was **explicitly admitted** (a separate, owner-approved step, RT-1290 P-6;
  nothing here does it). SmartScreen may still warn; that is observed on a clean device during verification, not
  assumed.
- **Not a commercial release** and not the lab installer. The lab installer (`pos/vX.Y.Z`, `LAB TEST` subject)
  must never reach a pilot device; the pilot installer never appears in a lab release.
- **No auto-update.** The installer ships no `resources/app-update.yml`, so the updater refuses to run
  (`publisher_not_pinned`). A new version reaches a terminal by installing the new pilot installer over the old
  one, followed by the readiness check in `pilot-terminal-provisioning.md` §6.

## 2. One-time owner setup

1. **Create the certificate** on your own machine (Windows PowerShell 5.1, not on CI):

   ```powershell
   .\apps\pos\scripts\pilot\new-pilot-release-cert.ps1 -PfxPath <new file> -CerPath <new file>
   ```

   It asks for a PFX password (never written to disk), creates a **leaf only** (CA false, Code Signing only,
   RSA 3072, SHA-256, 365 days by default), writes the password-protected PFX and the public `.cer`, and prints
   the SHA-1 thumbprint. It imports nothing into any trust store. The key is created exportable so that you can
   make the PFX (AES-256 encrypted, read back before the script ends): once the PFX is safely stored (a password
   manager), the secrets are set **and the first real release has succeeded** (section 6 says why), **delete the
   leaf and its key** from your machine and delete the working copy of the PFX:

   ```powershell
   Remove-Item Cert:\CurrentUser\My\<thumbprint> -DeleteKey
   ```

   (A plain `Remove-Item` can leave the key container on disk; `-DeleteKey` removes it.)

2. **Create the GitHub environment `release-pos-pilot-sign`** (Settings → Environments): deployment policy
   "selected branches and tags" with exactly the **tag** pattern `pos-pilot/v*`, and a **required reviewer (you):
   mandatory, not optional.** A tag names a commit, and that commit's copy of the workflow is what runs, so the
   tag pattern alone cannot keep the PFX from a workflow someone edited; your approval on this environment is what
   does. The publish job also refuses to run unless this reviewer exists.
   - Secret `POS_PILOT_SIGN_PFX_BASE64`: the PFX file as plain base64, with no PEM header lines. Produce it with
     `[Convert]::ToBase64String([IO.File]::ReadAllBytes('<pfx>'))` (not `certutil -encode`, whose header lines
     make the run fail).
   - Secret `POS_PILOT_SIGN_PFX_PASSWORD`: the PFX password.
   - Variable `POS_PILOT_LEAF_SHA1`: the thumbprint printed in step 1 (public).
3. **Create the GitHub environment `release-pos-pilot`**: a **required reviewer** (you) and exactly the tag
   pattern `pos-pilot/v*`. The publish job refuses to run if either environment is missing or admits anything else.
   That check runs after signing, so it is an alarm, not the control: **look at both environments yourself
   before the first tag.**
4. **Protect the tags.** Add a repository tag ruleset (Settings → Rules) for `pos-pilot/*` that restricts creation,
   update and deletion to you. Without it, anyone who can push a tag can start a run that waits on your approval,
   and a moved or deleted tag changes what a published release points at.
5. **Confirm the identity is final** before the first signed installer: `appId` `tech.smartdatapulse.pos` and
   `productName` `POS Pulse` (RT-234 §11.2).
6. **Run a dry run** (Actions → release-pos-pilot → Run workflow, `dry_run` true, on `main`). It signs with an
   ephemeral certificate, reads no secret and publishes nothing. It proves the build, the signature checks, the
   timestamp endpoint and the silent install and uninstall, and that the installed app has no `app-update.yml`.

## 3. Releasing a pilot installer

1. On `main`, `apps/pos/package.json` carries the version to release.
2. The owner authorizes the tag (RT-717 per-tag authorization), then pushes `pos-pilot/vX.Y.Z` on that `main`
   SHA. The tag must equal the `package.json` version and its SHA must be on `main`, or `resolve` refuses.
3. The workflow builds, signs (in `release-pos-pilot-sign`), writes the manifest, then waits for your approval
   on `release-pos-pilot`. Approving publishes the release; it never overwrites an existing one.
4. Verify before using the file (any machine with `gh`):

   ```powershell
   gh release download pos-pilot/vX.Y.Z --repo Kemetra-Labs/Retail-Tower-Erp
   gh attestation verify POS-Pulse-Setup-X.Y.Z.exe --repo Kemetra-Labs/Retail-Tower-Erp `
     --signer-workflow Kemetra-Labs/Retail-Tower-Erp/.github/workflows/release-pos-pilot.yml `
     --source-ref refs/tags/pos-pilot/vX.Y.Z
   ```

   The attestation must verify and the SHA-256 of the file must equal the `.sha256` asset and the manifest digest.
   Uploading to S3 and registering the release are later steps (RT-1292 follow-ups), not part of this workflow.

## 4. Expiry and rotation

- The leaf is valid for 365 days by default. Every pilot signature is **timestamped**, so an installer signed while
  the leaf was valid stays valid after the leaf expires; a **new** installer needs a valid leaf. `release` refuses
  a leaf that expires in under 30 days.
- To rotate, repeat §2 step 1 and replace the two secrets and the variable. A leaf-only design means the new
  leaf has a **new thumbprint**, so every admitted device must be re-admitted before it will validate a new installer.

## 5. Revocation (suspected key compromise)

There is no CRL or OCSP for a private leaf. Revocation is manual and complete only when all of these are done:

1. Delete the secrets `POS_PILOT_SIGN_PFX_BASE64` and `POS_PILOT_SIGN_PFX_PASSWORD` from the environment.
2. **Remove the certificate from every admitted device** (hand or script); an installed POS keeps running, but
   nothing signed by that key validates again.
3. Withdraw the release row in the pilot registry, so the Console stops offering it (RT-1292 follow-ups), and
   **delete the published GitHub release and its assets**: they stay downloadable from GitHub otherwise.
4. Create a new leaf (§4) and release a new version.

### Accepted risk

The signing job runs `npx electron-builder` and its dependency tree as the same user that holds the persisted pilot
key in `CurrentUser\My`. "Non-exportable" is a soft flag for a software key, so code in that process tree (a
compromised dependency) could sign other files or extract the key. `npm ci --ignore-scripts` removes install-time
scripts only. The controls are the required reviewer on `release-pos-pilot-sign`, the `pos-pilot/*` tag ruleset
and the lockfile; a leaked key is handled by the revocation steps above. The same exposure exists in the lab lane.

## 6. Troubleshooting a failed run

| Symptom | Where to look |
| :-- | :-- |
| `POS_PILOT_TSA_URL must be an https URL` | The signing step sets `https://timestamp.sectigo.com`; a changed value must still be https. |
| signtool timestamp failure | The timestamp server was unreachable; re-run the failed job. A pilot signature is never left untimestamped. |
| `the PFX leaf … is not the pinned one` | `POS_PILOT_LEAF_SHA1` does not equal the PFX's certificate; fix the variable or re-export. |
| `has resources\app-update.yml` | A build baked an update configuration; the pilot installer must ship none. Find what wrote it. |
| `publish` says an environment is unprotected | Fix the tag pattern or the reviewer on the named environment (§2 steps 2 and 3). Signing may already have run: check the run before approving anything. |
| `this script writes to the certificate stores and runs on a GitHub-hosted runner only` | The signing script was started somewhere other than a GitHub-hosted runner; it refuses so that no key or trusted certificate is left behind. |
| `pilot certificate cleanup failed` | The runner could not remove a certificate. A hosted runner is discarded anyway; do not reuse the runner. |
| `has no Basic Constraints extension` | The leaf was not made by `new-pilot-release-cert.ps1`; create a new one. |

**Needs verification on the first dry run (not assumed):** that the signing hook also signs the uninstaller for
the pilot config as it does for the lab config, and that `signtool` accepts the Sectigo https endpoint with
SHA-256.

**Needs verification on the first real release (the dry run reads no PFX):** the release path imports the PFX
twice on the runner, once in memory and once with a persisted key. The PFX is AES-256 / SHA-256 encrypted (not the
legacy TripleDES default) and the certificate script reads it back with `Get-PfxData` before it finishes, but the
runner's own .NET import of an AES PFX is first exercised by the first release. If it fails there, nothing was
signed or published: re-export the PFX with `Export-PfxCertificate` without `-CryptoAlgorithmOption` while the key
still exists on your machine (so do not delete it before the first successful release), or create a new leaf.
