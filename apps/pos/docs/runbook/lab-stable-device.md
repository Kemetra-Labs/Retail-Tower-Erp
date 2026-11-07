# Stable lab device and the per-release update drill (RT-1082 slice S3)

> **LAB ONLY.** This puts one **installed** POS on one lab device and updates it from the lab feed on
> lab-01 each time a `pos/vX.Y.Z` release is deployed. The installer is signed with a **lab test
> certificate** (publisher `Kemetra POS LAB TEST - NOT FOR PRODUCTION`). It is not a customer or pilot
> distribution path and must never reach a production terminal. The production path is RT-321 (cloud
> HSM, timestamped) and the staged channels are RT-234 and RT-322; none of them is started here.

Design: [`2026-11-03-pos-tag-release-lab-installer-design.md`](../superpowers/specs/2026-11-03-pos-tag-release-lab-installer-design.md).
Plan: [`2026-11-03-pos-tag-release-lab-installer.md`](../superpowers/plans/2026-11-03-pos-tag-release-lab-installer.md).
The one-off, Sandbox-only drill of the updater (tampered, unsigned, wrong publisher, open shift, older
version, blockmap fallback) stays in [`lab-nsis-installer.md`](lab-nsis-installer.md). This page is the
standing setup and the repeatable "release, deploy, update" loop.

## How the pieces fit

```text
version-bump PR -> main -> tag pos/vX.Y.Z
  -> release-pos.yml   build -> sign (release-pos-sign) -> manifest -> publish (release-pos, owner approval)
                       => GitHub release: installer, .blockmap, lab.yml, .sha256, release-manifest.json
  -> deploy-pos-lab.yml  preflight (GitHub only) -> live (aws-lab approval) -> SSM RT-PosLabFeedDeploy
                       => lab-01 feed directory: lab.yml (last), installer, blockmap
  -> lab device (installed POS, channel "lab") -> UpdateService -> downloaded -> installs at a safe point
```

GitHub Releases is only the immutable store. Devices read the feed on lab-01, never GitHub.

## Status of each prerequisite

Read this before starting; each row is an owner step or a decision that nothing in the repository can do.
State is as recorded on 2026-11-03 (Cairo) and must be re-checked, not assumed.

| Prerequisite | Owner | State on 2026-11-03 |
| :----------- | :---- | :------------------ |
| RT-717 authorization for each real tag and each live deploy | owner | per release |
| Written yes that exporting the lab leaf is acceptable (design C-1) | owner | not seen |
| `appId` `tech.smartdatapulse.pos` and `productName` `POS Pulse` confirmed final (RT-234 §11.2) | owner | not seen |
| `release-pos-sign` environment with its secrets and variable | owner | **absent** from the repository's environments |
| `release-pos` environment | owner | exists; reviewer and tag policy `pos/v*` read back on 2026-11-03, re-check |
| `aws-lab` environment, `AWS_ROLE_ARN`, `AWS_REGION` | owner | exists; the two variables are set, the role's trust policy is not verified |
| GitHub release immutability enabled for the repository (`deploy-pos-lab` refuses a release that is not immutable) | owner | not verified |
| Trust-policy entry for `deploy-pos-lab.yml@refs/heads/main` on the deploy role (deploy README, step 6) | owner | not verified |
| SSM document `RT-PosLabFeedDeploy`, IAM permission, feed host, Caddy route, public TLS | owner | not verified |

## Once: owner, on the build machine and in GitHub

Nothing here is done by Claude or by CI. Follow the design §8 and the `POS lab feed deploy` section of
`services/backend-core/deploy/README.md`; this is the order.

1. **Create the stable lab certificates.** From `apps/pos`:

   ```powershell
   .\scripts\lab\new-lab-release-cert.ps1 -PfxPath <new, empty path> -RootCerPath <new, empty path>
   ```

   It always creates a new pair in `Cert:\CurrentUser\My` (root about two years and non-exportable, leaf
   one year and exportable) and refuses to overwrite a file. It asks for the PFX password with
   `Read-Host -AsSecureString` and prints the root thumbprint (`POS_LAB_ROOT_SHA1`), the leaf thumbprint
   and the leaf's expiry date. Write the expiry date in the Jira issue: after it, new builds no longer
   verify (no timestamp is applied unless `RT772_LAB_TSA_URL` is set) and the leaf must be replaced.
2. **Create `release-pos-sign`** with a deployment policy that admits exactly the tag pattern `pos/v*`.
   A required reviewer is optional there (design C-7). Set on it:
   - secret `POS_LAB_SIGN_PFX_BASE64`, from the PFX, without printing it:
     `[Convert]::ToBase64String([IO.File]::ReadAllBytes('<pfx path>')) | gh secret set POS_LAB_SIGN_PFX_BASE64 --env release-pos-sign`;
   - secret `POS_LAB_SIGN_PFX_PASSWORD`: `gh secret set POS_LAB_SIGN_PFX_PASSWORD --env release-pos-sign`
     with no `--body`, so `gh` prompts and the value stays out of the shell history;
   - **variable** (not a secret) `POS_LAB_ROOT_SHA1`, the root thumbprint.

   **Keep the PFX (encrypted, offline) and the exportable leaf until the first real `sign-release` run
   has succeeded.** The release-only signing path (parsing the PFX in memory, importing the leaf, the
   pinned-root check) is exercised only by a real tag, and a wrong base64 or password shows up there. The
   root is non-exportable and stays on this machine, so once the leaf and PFX are gone a replacement leaf
   can still be issued by hand under the same root (see "Rotation and clean-up"). A new root and a new
   device import are needed only if the root key is lost. After that first success, delete the leaf (`Remove-Item Cert:\CurrentUser\My\<leaf thumbprint> -DeleteKey`)
   and the PFX file. Never paste the PFX, its base64 or its password into Jira, Confluence, a log or this page.
3. **Check `release-pos`.** It must keep a required reviewer and the tag policy `pos/v*` only. The publish
   job refuses to run if either environment admits anything else.
4. **Repository and role.** GitHub release immutability must be on (the deploy preflight requires
   `isImmutable`), and `Kemetra-Labs/Retail-Tower-Erp/.github/workflows/deploy-pos-lab.yml@refs/heads/main`
   must be in the deploy role's trust policy (deploy README, step 6); without it the live job fails at
   "Assume the deploy role".
5. **Feed side on lab-01**, per the deploy README: the Caddy route (static files, HTTP `Range`, no SPA
   fallback, publicly trusted TLS), the root-owned feed directory and parent, `/etc/rt-deploy/pos-feed.env`
   with `FEED_DIR` and `FEED_URL`, the SSM document `RT-PosLabFeedDeploy`, and the deploy role's IAM
   permission. The Caddy route is a durable-configuration decision: a route added by hand is replaced by the
   next `RT-BackendLabDeploy`, and a committed one needs its own Jira authorization (README, "open owner
   decision"). Record the feed URL for the device step below. **The host name and path are an open
   owner decision**; this page uses `<FEED_URL>` for the full URL the device is given (host and path, the
   directory that holds `lab.yml`, without `lab.yml` itself).

## Once: the lab device

Use a disposable or dedicated lab Windows device and **one Windows user** for the whole life of the
device: the per-user install, `userData` (`%APPDATA%\pos-pulse`) and the persistent variables below all
belong to that user. Do not use a machine that holds a real pilot profile.

**Do this section only after the first release has been tagged, published and deployed to the feed**
("Per release", steps 1 to 6, for version N). With an empty feed the updater goes `checking` then `error`,
which is not a fault of the device.

1. **Trust the public root only.** Import the `.cer` from step 1 into that user's *Trusted Root
   Certification Authorities*. This is a system-trust change made by the device owner. Never import
   the PFX, never trust the root on the build machine, and never put the root's private key on the device or in CI.
   The TLS certificate of the feed is publicly trusted, so no TLS trust step is needed.
2. **Set the device's inputs persistently.** The installer's relaunch does not inherit the process
   environment (see "Gotchas" in `lab-nsis-installer.md`), so set these as user variables:

   ```powershell
   setx ELECTRON_UPDATE_FEED_URL "<FEED_URL>"
   setx POS_PULSE_UPDATE_CHANNEL lab
   setx VITE_API_BASE_URL "<BACKEND_URL>"
   setx DESCOPE_PROJECT_ID "<lab Descope project id>"
   setx POS_PULSE_FEATURE_CART true
   setx POS_PULSE_FEATURE_PRODUCT_SEARCH true
   setx POS_PULSE_FEATURE_PAYMENTS true
   setx POS_PULSE_FEATURE_SALE_FINALIZATION true
   setx POS_PULSE_FEATURE_SHIFT_CASHUP true
   ```

   `setx` writes the user environment for **new** processes only: sign out and sign in again before
   installing. The origin must be `https://`; the updater refuses anything else (`origin_not_https`).

   The packaged app has no built-in backend or identity provider (RT-1082, 2026-11-04 lab run):
   - Without `VITE_API_BASE_URL` it calls the non-routable default `https://example.invalid`. Pairing then
     fails at once with «لا يوجد اتصال», and the log shows `backend:request outcome=transport_error` and
     `pairing_attempt outcome=network_error`. `<BACKEND_URL>` is the Backend-Core origin, without a path;
     `<BACKEND_URL>/api/v1/health/live` must answer 200.
   - Without `DESCOPE_PROJECT_ID`, every manager or admin sign-in is refused with the generic error, and
     the log shows `operator.sign_in.refused category=invalid_input stage=identity_provider`. The project
     id is public, not a secret. Cashier PIN sign-in does not need it.
   - Every sale feature except returns is off in a packaged app. With `POS_PULSE_FEATURE_CART` unset, a signed-in
     manager sees «سلة البيع غير مفعّلة على هذا الجهاز بعد.». The five `true` variables above are the set for a cash
     test sale (source: `src/main/app/feature-flags.ts`). `PAYMENTS` needs `SALE_FINALIZATION`; with `PAYMENTS` on and it
     off, the app refuses to sell. `RETURNS` is on by default for managers and admins since RT-1180
     (`POS_PULSE_FEATURE_RETURNS=false` turns it off). `SALE_VOID`, `CARD_TENDER` and `VOUCHER_TENDER` stay off unless
     a drill needs them.
3. **Install the first release.** The device needs `gh` (signed in) and a copy of
   `apps/pos/scripts/lab/verify-lab-signature.ps1`; if it has neither, run the download and the checks on
   the build machine and carry the installer, its `.sha256` and the script across. Verify before running:

   ```powershell
   gh release download pos/v<N> --repo Kemetra-Labs/Retail-Tower-Erp --dir <empty dir>
   (Get-FileHash <dir>\POS-Pulse-LAB-Setup-<N>.exe -Algorithm SHA256).Hash   # compare with the .sha256 asset
   gh attestation verify <dir>\POS-Pulse-LAB-Setup-<N>.exe --repo Kemetra-Labs/Retail-Tower-Erp `
     --signer-workflow Kemetra-Labs/Retail-Tower-Erp/.github/workflows/release-pos.yml `
     --source-ref refs/tags/pos/v<N>
   .\verify-lab-signature.ps1 -InstallerPath <dir>\POS-Pulse-LAB-Setup-<N>.exe -ExpectedSha256 <sha256>
   ```

   Expected: matching hash, a verified attestation from `release-pos.yml` for that tag (the two flags are
   the same ones the deploy preflight uses), and `RESULT: PASS` on this device (it would be `FAIL` on a
   machine that does not trust the root). Then run the installer. It installs per user, without UAC,
   under `%LOCALAPPDATA%\Programs\pos-pulse` (the executable is `POS Pulse.exe`), and launches the app.
   If `%APPDATA%\pos-pulse` already holds data from development runs, the installed app uses it; move it
   aside first for a clean device.
4. **Pair and make data.** Pair the terminal against the lab Backend-Core, sign in, open and close a
   shift if needed and make a test sale so the database and outbox hold rows. The store needs at least
   one cashier admitted in the Admin Console first: on an empty store the log shows
   `operator.roster.fetched count=0` and there is no one to sell as. Record the row counts; the
   update must not change them. Take them the same way every time and write the method down (for example
   the sales-history screen plus a read-only copy of `%APPDATA%\pos-pulse` opened with a SQLite tool;
   `sqlite3` is not installed by default).
5. **Confirm the updater is on.** The feed holds version N, the version just installed. Launch the
   installed app, then read the newest `%APPDATA%\pos-pulse\logs\main-*.log`. Expected, in the **current
   session** only:
   - `update:enabled` with `channel: "lab"` and `pinned` 1 (the number of publisher pins baked in);
   - `update:state` moving `idle` to `checking` and back to `idle` (the feed is on the same version).

   Close and relaunch the app once more. There must be **no** `update:disabled reason=no_origin` line. If
   there is one, the user variables were not set for this Windows user or the sign-out and sign-in was
   skipped.

If `update:disabled` appears with another reason, or `update:refused` or `update:error`, stop and take
the log lines to Jira; do not work around the refusal.

## Per release

Each real tag and each live deploy needs its own RT-717 authorization written in the Jira issue first.
Times in evidence are Cairo local time, for example `2026-11-04 14:20 (Cairo)`.

1. **Bump and merge.** A PR changes `apps/pos/package.json` `version` to the new `X.Y.Z` and merges to
   `main`. The release refuses a tag whose version differs from `package.json`, and a tag that is not on
   `main`.
2. **Dry-run first.** Dispatch `release-pos` from `main` with `dry_run` left `true`. It builds, signs with
   an ephemeral certificate, writes the manifest and publishes nothing. Expected: green, and the run
   summary shows the manifest. This proves the build and the dry-run signing path only. It does **not**
   exercise the release-only path (the stored PFX, the pinned root check), which the real tag runs for the
   first time. Dispatch it only while `main` still equals the commit you will tag; it builds `main`'s head.
3. **Tag.** On the merge commit:

   ```bash
   git fetch origin
   git tag pos/vX.Y.Z <merge commit sha>
   git push origin pos/vX.Y.Z
   ```

   Tags are never moved or deleted afterwards. A bad release is fixed by a higher version.
4. **Approve.** `sign-release` runs behind `release-pos-sign` (the only job that reads the PFX; approve it
   there too if that environment has a reviewer) and `publish` behind `release-pos`; the `release-pos`
   reviewer approves the publish. Expected: a GitHub
   release `pos/vX.Y.Z` with exactly six assets: `POS-Pulse-LAB-Setup-X.Y.Z.exe`, its `.blockmap`,
   `lab.yml`, the `.sha256`, `release-manifest.json` and `POS-Pulse-X.Y.Z-win-x64.zip`, plus a
   build-provenance attestation. The zip is the unsigned pilot package (RT-1261); it never goes to the lab
   feed or a lab device. Releases made before RT-1261 (`pos/v0.1.0`, `pos/v0.1.1`) hold only the first five.
   Verify the attestation as in the device step above.
5. **Deploy dry-run.** Dispatch `deploy-pos-lab` from `main` with `pos_release` `pos/vX.Y.Z`, `jira_key`
   `RT-…` and `dry_run` `true`. It verifies the release (assets, digests, attestation, `lab.yml` against
   the installer), reads back `aws-lab`, uploads the planned ledger `pos-lab-planned-<run id>` and changes
   nothing. Expected: green.
6. **Deploy live.** Dispatch again with `dry_run` `false`; the `aws-lab` reviewer approves. Expected: the
   live job's log and step summary carry `RT_PRIOR`, `RT_TARGET`, every `RT_GATE ... pass` and `RT_DONE`,
   and the `pos-lab-live-<run id>` artifact (`ledger.json`) records the outcome as `deployed` only when
   `RT_DONE` was reached; any other end records `failed`. `RT_REVERT` (and the ledger's `revert` entries)
   appear only when a rollback ran, that is a failure after the swap and before the smoke passed (a failed
   smoke included); a failure before the swap, or in the prune after a good smoke, can leave `revert` empty. A second
   deploy of the same or a lower version is refused (`version-not-higher`) and leaves the feed unchanged;
   a failed smoke puts the previous `lab.yml` back (`RT_REVERT`), but the failed release's installer and
   `.blockmap` stay in the feed until a later successful prune. After a successful smoke, the feed keeps
   this version and the previous one only, so a device two or more versions behind has no old `.blockmap`
   to diff against and takes a full download.
7. **Update the device.** With the device on version N and the feed on N+1:
   1. Know when the update can install. The updater decides at two moments only: right after a download
      completes, and when a shift is closed. It installs at the first of them where the gate is clear
      (no open shift, no open cart, no payment or return in flight, no print in progress; an input that
      cannot be read blocks as `unreadable`) **and** either the shift was just closed or nobody is signed
      in. So an update downloaded while an operator is signed in waits in `update_pending`, possibly with
      no blocker named, and installs at the next shift close or at an app start that downloads before
      sign-in. Clearing a cart or a payment does not by itself trigger an install.
   2. To drive the drill, either (a) with a shift open, let the update download (`update_pending` with
      blocker `open_shift`), then close the shift; or (b) with **no shift open** (close it first: an open
      shift blocks the install at app start too), quit and relaunch the app and stay on the sign-in screen
      until the download completes. The updater checks at start and then every 6 hours. In the
      newest `main-*.log`, read the **current session only** (logs accumulate across launches, so a count
      over the whole file reports earlier lines). Expected `update:state` order:
      `checking`, `downloading` (with `version` N+1), `downloaded`, `update_pending` if it has to wait, then
      `installing` (its `detail` names the trigger, `app_start` or `shift_close`).
   3. After the installer relaunches the app, read the installed version: `POS Pulse` in *Installed apps*
      and the `app_version` field on every line of the new session's `main-*.log`. It must be N+1.
   4. Check that `userData` survived: the same row counts as before (sales, outbox, shifts), the pairing
      and the operator sign-in state still valid, no re-pairing prompt, and no
      `update:disabled reason=no_origin` after the relaunch.
8. **Differential download.** The Caddy feed serves HTTP `Range`, so a differential download using the
   `.blockmap` is expected to work. Record which path was taken: launch the packaged app from PowerShell
   with its console piped to a file (for example
   `& "$env:LOCALAPPDATA\Programs\pos-pulse\POS Pulse.exe" 2>&1 | Tee-Object <log>`), because the
   updater's own logger is not routed into `main-*.log`. If the console shows the fallback line, note its
   cause; the full download is checked the same way (`sha512`, then the pinned publisher) and the
   fallback itself stays proven by the Sandbox drill in `lab-nsis-installer.md`.

## What a failure looks like

| Seen on the device | Meaning | First thing to check |
| :----------------- | :------ | :------------------- |
| `update:disabled reason=no_origin` | the app has no feed origin | user variables, sign-out and sign-in, same Windows user |
| `update:refused` `origin_not_https` | origin is not `https://` | the value of `ELECTRON_UPDATE_FEED_URL` |
| `update:refused` `publisher_not_pinned` | the build has no baked publisher pin | the installer is the lab-signed one from `release-pos` |
| `verify_failed` | the download or its signature was refused | `sha512` against `lab.yml`; publisher is not `Kemetra POS LAB TEST - NOT FOR PRODUCTION`; root not trusted |
| `verify_unavailable` | PowerShell could not verify; never installs | PowerShell is blocked for the user |
| `update:state` stays on `checking` or goes to `error` | feed unreachable or `lab.yml` unreadable | the Caddy route; `/lab.yml` falling through to a console page means the route is gone |
| `update_pending` with a blocker | working as designed | the blocker named; it installs at the next shift close or a pre-sign-in app start once clear |
| `update_pending` with no blocker | working as designed: an operator is signed in | close the shift, or (no shift open) relaunch and stay on the sign-in screen |
| no `downloading` and no error after a deploy | the feed is not newer | `RT_PRIOR` and `RT_TARGET` in the live deploy's step summary; `lab.yml` version on the feed |

Do not disable signature verification, edit the baked `app-update.yml` or trust the root anywhere but
the lab device to make an update go through.

## Rotation and clean-up

- **Leaf expiry.** After the date printed in "Once, step 1", a build signed by that leaf no longer
  verifies. `new-lab-release-cert.ps1` always creates a **new root and a new leaf** (it has no option to
  reuse the existing root), so today a rotation means: run it again, import the new public root on every
  device, set the two secrets and a new `POS_LAB_ROOT_SHA1` on `release-pos-sign`, and release a higher
  version. Re-issuing only a leaf under the existing root (so devices keep their trust) is possible by
  hand with `New-SelfSignedCertificate -Signer`, using the non-exportable root in `Cert:\CurrentUser\My`
  on the owner's machine, but nothing scripts it; it would be a separate Jira follow-up
  (a `-RootThumbprint` option).
- **Root expiry** (about two years): the same as above; the new root's public certificate is imported on
  each device.
- **Retire the device.** Uninstall the app; `userData` is not deleted (`deleteAppDataOnUninstall: false`),
  so delete `%APPDATA%\pos-pulse` yourself, remove the root from the user's trusted roots and clear the two
  user variables (`[Environment]::SetEnvironmentVariable('ELECTRON_UPDATE_FEED_URL', $null, 'User')` and
  the same for `POS_PULSE_UPDATE_CHANNEL`).
- **Retire the channel.** Remove both secrets and the variable from `release-pos-sign`, and the feed route
  on lab-01. Published releases stay (immutable).

## Evidence to leave

On the Jira issue (RT-1082 or its successor), for each release:

- tag, release URL, the `main` commit and the run URLs of `release-pos` and `deploy-pos-lab` (planned
  and live), with times in Cairo local time;
- the attestation verification output and the installer's SHA-256;
- from the live deploy job: the step-summary lines `RT_PRIOR`, `RT_TARGET`, each `RT_GATE ... pass` and
  `RT_DONE`, and the `pos-lab-live-<run id>` ledger outcome;
- from the device: the `update:state` lines of the current session, the installed version before and
  after, the row counts before and after, and whether the download was differential or full.

Secrets, the PFX, its base64 or password, pairing codes and the full device token never go in the
evidence.

On Confluence, the Lab and Bench Runbook page (RETAIL, id 18874418): the procedure that worked, each
gotcha met and any failure with its first failing boundary, after the first device drill and after any
change to the procedure. The Jira comment does not replace this.

## Not covered here

The production signed updater, `canary` and `stable` channels, staged rollout and promotion (RT-321,
RT-322, RT-234 §10), fleet reporting and the minimum-supported version (RT-323), and the signed-update
drill on the rt9 lab (RT-324). None of them is changed by this page.
