# POS tag-release to a stable lab installer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `pos/vX.Y.Z` tag on `main` produces a lab-signed per-user NSIS installer as an immutable GitHub release, and a manual, approval-gated workflow puts it on a lab feed on lab-01 that an installed POS updates itself from.

**Architecture:** `release-pos.yml` keeps building `win-unpacked` secret-free, then a Windows signing job runs `electron-builder --prepackaged` with the existing `electron-builder.lab.yml` and `lab-sign.cjs` hook, verifies the result, and hands the installer, `.blockmap` and `lab.yml` to the manifest and publish jobs (publish modelled on `release-admin-console.yml`). `deploy-pos-lab.yml` (modelled on `deploy-console-lab.yml`) verifies a published release and runs one owner-created SSM document that writes the feed on lab-01, `lab.yml` last.

**Tech Stack:** GitHub Actions, PowerShell 5.1/7 on `windows-latest`, electron-builder (already pinned in `apps/pos`), signtool, bash + `gh` + `jq` on `ubuntu-24.04`, AWS SSM (owner-applied), Python `unittest`, Vitest, Jest.

**Spec:** `apps/pos/docs/superpowers/specs/2026-11-03-pos-tag-release-lab-installer-design.md`

## Global Constraints

- Work starts only under a Jira issue under RT-717 (the owner creates it); each slice S1, S2, S3 is its own PR. RT-717 authorization is required before any real tag, release or deploy.
- Every file under `.github/**` is policy class: the `required` gate prints a policy-approval line (mode `observe`).
- Lab publisher pin, unchanged: `Kemetra POS LAB TEST - NOT FOR PRODUCTION` (leaf CN). The marker `LAB TEST - NOT FOR PRODUCTION` and the check in `lab-sign-lib.cjs` stay.
- Frozen update identity: `appId: tech.smartdatapulse.pos`, `productName: POS Pulse`. RT-164 fuses inherited, never restated.
- `electron-builder.yml` (shipped, `dir` target) is not changed. `electron-builder.lab.yml` is reused as is: its `publish.url` stays the `.test` placeholder (C-8).
- Release tag pattern `^pos/v[0-9]+\.[0-9]+\.[0-9]+$`; the version must equal `apps/pos/package.json` `version` (C-3).
- Secrets exist only in environment `release-pos-sign`: `POS_LAB_SIGN_PFX_BASE64`, `POS_LAB_SIGN_PFX_PASSWORD`; environment variable `POS_LAB_ROOT_SHA1` (public root thumbprint, not a secret). `release-pos` (publish) reads no secret.
- No package dependency, lockfile, migration or updater-source change. `apps/pos/src/main/update/**` is untouched.
- Public Actions log: only fixed, non-secret lines; never echo a PFX, password or raw SSM output.
- Actions pinned by full SHA, using the SHAs the root workflows already use.
- Feed keeps the current and one previous version (C-5); roll-forward only.

## Review Focus

1. A tag pushed on a commit whose `package.json` was not bumped: `resolve` fails before any build, naming both versions. (Task 3)
2. The tag is moved after the build: publish refuses (tag no longer points at the built SHA). (Task 3)
3. A deploy is interrupted after the installer is written but before `lab.yml`: devices keep reading the old, consistent `lab.yml`, and the next deploy succeeds. (Task 4)
4. The same or a lower version is deployed again: the document refuses and the feed is unchanged. (Task 4)
5. The lab leaf in the secret is expired, near expiry, or not the lab subject: `sign-release` fails before signing, so no unsigned or wrongly signed release is published. (Task 2)

---

## Slice S1 — release-pos builds, signs and publishes (one PR)

### Task 1: Owner script for the stable lab root and exportable leaf

**Files:**
- Create: `apps/pos/scripts/lab/new-lab-release-cert.ps1`
- Test: `apps/pos/scripts/__tests__/lab-release-cert.test.ts`

**Interfaces:**
- Produces: a PFX at `-PfxPath` (leaf + chain, password from `Read-Host -AsSecureString`), a public root `.cer` at `-RootCerPath`, and two printed lines `POS_LAB_ROOT_SHA1 = <40 hex>` and `leaf expires <yyyy-MM-dd>`. Root subject `CN=Kemetra POS LAB TEST - NOT FOR PRODUCTION RELEASE ROOT` (distinct from the 180-day drill root, so `new-lab-signing-cert.ps1` never reuses it); leaf subject `CN=Kemetra POS LAB TEST - NOT FOR PRODUCTION`.

- [ ] **Step 1: Write the failing static test** `lab-release-cert.test.ts`, reading the script text like `lab-nsis-config.test.ts` does:
  - `it('creates a non-exportable release root and an exportable leaf under it')`: matches `-Subject "CN=Kemetra POS \$marker RELEASE ROOT"`, `KeyExportPolicy NonExportable` on the root call, `KeyExportPolicy Exportable` only on the leaf call, `-Signer $root`.
  - `it('defaults to a two-year root and a one-year leaf, never past the root')`: `[int]$RootDays = 730`, `[int]$LeafDays = 365`, and the leaf `NotAfter` clamp to `$root.NotAfter`.
  - `it('never writes a password or imports into a trust store')`: no `ConvertTo-SecureString -AsPlainText`, no `Cert:\\LocalMachine\\Root`, no `Cert:\\CurrentUser\\Root`, password only via `Read-Host -AsSecureString`.
  - `it('exports the PFX with its chain and the root public only')`: `Export-PfxCertificate` with `-ChainOption BuildChain`; `Export-Certificate -Cert $root`.
- [ ] **Step 2: Run** `cd apps/pos && npx vitest run scripts/__tests__/lab-release-cert.test.ts` — Expected: FAIL (file missing).
- [ ] **Step 3: Write `new-lab-release-cert.ps1`** with params `-PfxPath` (required), `-RootCerPath` (required), `-RootDays 730`, `-LeafDays 365`; same `New-SelfSignedCertificate` options as `new-lab-signing-cert.ps1` (RSA 3072, SHA256, CA basic constraint on the root). Always create new certificates (no reuse). Print the two lines and a reminder that only the PFX goes to `release-pos-sign` and only the `.cer` goes to the device.
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(pos): owner script for the stable lab release certificate` (stage the two files only).

### Task 2: CI script that signs, verifies and checks the installer

**Files:**
- Create: `apps/pos/scripts/lab/ci/release-lab-installer.ps1`
- Test: `apps/pos/scripts/__tests__/release-lab-installer.test.ts`

**Interfaces:**
- Consumes: `win-unpacked` directory (from the build job), `electron-builder.lab.yml`, `scripts/lab/lab-sign.cjs`, `scripts/lab/new-lab-signing-cert.ps1` (dry-run only).
- Produces: `release-lab-installer.ps1 -Mode <release|dry-run> -Unpacked <dir> -Version <X.Y.Z> -Out <dir>` writes exactly `POS-Pulse-LAB-Setup-<Version>.exe`, `POS-Pulse-LAB-Setup-<Version>.exe.blockmap`, `lab.yml` into `-Out`, exit 0; any failed check exits non-zero. `-Cleanup` removes every certificate it added (state file under `$env:RUNNER_TEMP`). Release mode reads `POS_LAB_SIGN_PFX_BASE64`, `POS_LAB_SIGN_PFX_PASSWORD`, `POS_LAB_ROOT_SHA1` from the environment.

- [ ] **Step 1: Write the failing static test** `release-lab-installer.test.ts`:
  - `it('builds the installer from the prepackaged app with the lab config, never publishing')`: matches `electron-builder`, `--prepackaged`, `--config electron-builder.lab.yml`, `--publish never`; does not match `extraMetadata`.
  - `it('imports the leaf non-exportable and never exports a key')`: *(as shipped, see Ruling 6 in the SDD ledger)* the PFX is parsed in memory only (no file, no `Import-PfxCertificate`); only the leaf, the single certificate with a private key, is added to `CurrentUser\My` through `X509Store` with a persisted non-exportable key; no `Export-PfxCertificate`.
  - `it('refuses a leaf that is not the lab subject or expires within 30 days')`: matches `LAB TEST - NOT FOR PRODUCTION` subject check and `AddDays(30)` against `NotAfter`, both before the electron-builder call.
  - `it('trusts only the pinned public root, only for verification, and removes it')`: root imported into `Cert:\LocalMachine\Root` only after its thumbprint equals `$env:POS_LAB_ROOT_SHA1`; `-Cleanup` removes it.
  - `it('uses an ephemeral certificate in dry-run and reads no signing variable')`: dry-run branch calls `new-lab-signing-cert.ps1 -LeafDays 2 -RootDays 3` and references no `POS_LAB_SIGN_` name.
  - `it('clears every production signing variable')`: `CSC_LINK`, `CSC_KEY_PASSWORD`, `CSC_NAME`, `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` removed, as in `build-lab-installer.ps1`.
  - `it('checks signatures, the channel file and the installed files')`: matches `Get-AuthenticodeSignature`, a CN equality against `Kemetra POS LAB TEST - NOT FOR PRODUCTION`, `SHA512`, `/S` silent install, `Uninstall POS Pulse.exe`, `POS Pulse.exe`.
- [ ] **Step 2: Run** `cd apps/pos && npx vitest run scripts/__tests__/release-lab-installer.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write `release-lab-installer.ps1`.** Order: clear CSC vars → certificate (release, as shipped: parse the PFX in memory, refuse unless it holds the root whose thumbprint is `POS_LAB_ROOT_SHA1` (subject `...RELEASE ROOT`), check the leaf subject and `NotAfter`, add only the leaf to `CurrentUser\My` via `X509Store`, trust the root from its public bytes in `LocalMachine\Root`; dry-run: `new-lab-signing-cert.ps1`, trust its exported root the way `run-lab-spike.ps1` does) → set `RT772_LAB_CERT_SHA1` → `npx electron-builder --win nsis --config electron-builder.lab.yml --prepackaged $Unpacked --publish never -c.directories.output=$Out` → verify (below) → keep only the three files in `-Out`.
  Verification, each a hard failure:
  - installer: `Status -eq 'Valid'` and signer CN `-ceq` the pin;
  - `lab.yml`: `version` equals `-Version`; `path` equals the installer name; `sha512` equals the base64 SHA-512 of the installer bytes; `size` equals its length;
  - installed files: silent per-user install (`/S`), then `POS Pulse.exe` and `Uninstall POS Pulse.exe` under `$env:LOCALAPPDATA\Programs\POS Pulse` are `Valid` with the pin; then run the uninstaller silently.
  If `POS Pulse.exe` is not signed (electron-builder did not sign the prepackaged exe), sign it in place with `lab-sign.cjs`'s `buildSigntoolArgs` before the electron-builder call and say so in a comment; that is the C-6 fallback.
- [ ] **Step 4: Run** the test — Expected: PASS. Then `npx vitest run scripts/__tests__/lab-nsis-config.test.ts` — Expected: PASS (shipped and lab configs unchanged).
- [ ] **Step 5: Commit** `feat(pos): CI script to sign and verify the lab installer from win-unpacked`.

### Task 3: release-pos.yml — version gate, signing jobs, publish

**Files:**
- Modify: `.github/workflows/release-pos.yml`
- Create: `.github/release/test_pos_release_workflow.py`

**Interfaces:**
- Consumes: `release-lab-installer.ps1` (Task 2), `.github/release/manifest.py` (repeatable `--artifact NAME=FILE`).
- Produces: release `pos/vX.Y.Z` with exactly `POS-Pulse-LAB-Setup-X.Y.Z.exe`, `.exe.blockmap`, `lab.yml`, `POS-Pulse-LAB-Setup-X.Y.Z.exe.sha256`, `release-manifest.json`; manifest artifact names `pos-installer`, `pos-blockmap`, `pos-channel`; a build-provenance attestation on the installer. Task 5 reads these names.

- [ ] **Step 1: Write the failing test** `test_pos_release_workflow.py`, reusing the helpers of `test_console_lab_workflow.py` (`read`, `job`, `step_script`, `triggers`, `run_step`, `HAVE_BASH`):
  - `test_triggers_are_tag_push_and_dispatch_only`: `triggers(text) == ["push", "workflow_dispatch"]`, tags `["pos/v*"]`.
  - `test_every_action_is_pinned_by_sha` and `test_permissions_empty_at_the_top` (as in the Console test).
  - `test_resolve_refuses_a_tag_that_differs_from_package_json` (skip without bash): run the `Resolve SHA, mode and tag` script with `REF=refs/tags/pos/v0.2.0`, a temp `apps/pos/package.json` at `0.1.0` → non-zero and stderr contains `0.2.0` and `0.1.0`; with `0.2.0` it passes the version check.
  - `test_only_sign_release_mentions_secrets`: `secrets.` appears only in job `sign-release`; `sign-release` has `environment: release-pos-sign` and `if: needs.resolve.outputs.mode == 'release'`.
  - `test_sign_dry_run_has_no_environment_and_no_secret`: job `sign-dry-run` has no `environment:` and no `secrets`, `if: needs.resolve.outputs.mode == 'dry-run'`.
  - `test_secret_job_installs_without_scripts`: `sign-release` runs `npm ci --ignore-scripts` and no plain `npm ci`; it always runs `release-lab-installer.ps1 -Cleanup` (`if: always()`).
  - `test_publish_is_protected_and_runs_no_repository_code`: `publish` has `environment: release-pos`, no `actions/checkout`, the protection step requires the policy list `[{"name":"pos/v*","type":"tag"}]`, refuses an existing release, re-checks the tag commit, and lists exactly the five assets.
  - `test_publish_attests_the_installer`: `actions/attest-build-provenance` with `subject-path` ending `POS-Pulse-LAB-Setup-*.exe`.
- [ ] **Step 2: Run** `python -m unittest discover -s .github/release -p test_pos_release_workflow.py -v` — Expected: FAIL.
- [ ] **Step 3: Modify `release-pos.yml`.**
  - `resolve`: add sparse checkout of `apps/pos/package.json` and, in release mode, fail unless `${TAG#pos/v}` equals its `version`.
  - `build`: unchanged steps; upload `dist-electron/win-unpacked` (the zip stays) as artifact `pos-unpacked-<mode>-<run_id>`.
  - New `sign-dry-run` and `sign-release` jobs on `windows-latest`: checkout the release SHA, setup Node from `.nvmrc`, `npm ci --ignore-scripts` in `apps/pos`, download `pos-unpacked-…`, run `release-lab-installer.ps1 -Mode <mode>`, cleanup `if: always()`, upload `pos-installer-<mode>-<run_id>`. `sign-release` maps the two secrets and `vars.POS_LAB_ROOT_SHA1` to env only on that step.
  - `manifest`: needs the sign job of its mode (as shipped: `if: !cancelled() &&` explicit `needs.<job>.result == 'success'` checks for the sign job of its own mode), records the three files with the names above, and the note `signing=lab test certificate (RT-321 production signing not used)`.
  - `publish`: replace the refusal with the `release-admin-console.yml` publish steps, adapted to the `pos/v*` pattern, the five assets and title `POS Pulse <tag> (LAB)`; notes say the installer is lab-signed and not for production terminals.
  - Header comment updated to the new job graph.
- [ ] **Step 4: Run** the test — Expected: PASS. Then `cd tools/project-graph && python -m pgraph privileges --repo ../..` — Expected: no problems.
- [ ] **Step 5: Dry-run proof — after merge, on main** (`resolve` refuses any SHA not on main, so a branch dispatch cannot reach the build): `gh workflow run release-pos.yml --ref main -f dry_run=true`. Expected: `sign-dry-run` green with the three files, no publish. Record the run URL in Jira. Until then the Windows signing, install and uninstall path is proven only by static tests.
- [ ] **Step 6: Commit** `feat(release): sign and publish the POS lab installer on pos/v* tags`.

## Slice S2 — deploy-pos-lab (one PR, Jira must authorize the Backend-Core deploy area)

### Task 4: SSM document RT-PosLabFeedDeploy

**Files:**
- Create: `services/backend-core/deploy/lab/ssm/RT-PosLabFeedDeploy.yaml`
- Modify: `services/backend-core/apps/api/test/deploy/lab-ssm-documents.spec.ts`
- Modify: `services/backend-core/deploy/README.md` (owner section "POS lab feed deploy")

**Interfaces:**
- Consumes: release assets from Task 3.
- Produces: parameters (all `interpolationType: ENV_VAR`): `ReleaseTag` `^pos/v[0-9]+\.[0-9]+\.[0-9]+$`, `Version` `^[0-9]+\.[0-9]+\.[0-9]+$`, `InstallerDigest`, `BlockmapDigest`, `ChannelDigest` each `^sha256:[0-9a-f]{64}$`. Host config file `/etc/rt-deploy/pos-feed.env` (owner-created, with `FEED_DIR` and `FEED_ORIGIN`; *as shipped:* `FEED_DIR` and `FEED_URL`, the feed URL as Caddy on lab-01 serves it, since the value carries a path). Output lines: `RT_GATE <name> <pass|fail>`, `RT_FAIL reason=<token>` (*as shipped:* `RT_FAIL gate=<gate> reason=<token>`, the shared `stop` format), `RT_PRIOR version=<X.Y.Z|none>`, `RT_TARGET version=<X.Y.Z>`, `RT_SWAP channel=lab.yml` (*as shipped:* `from=<X.Y.Z|none> to=<X.Y.Z>` added), `RT_REVERT`, `RT_PRUNE kept=<n>` (*as shipped:* `removed=<n>` added), `RT_DONE release=<tag>`. Task 5 parses these.

- [ ] **Step 1: Write the failing tests** in `lab-ssm-documents.spec.ts`, a `describe("RT-PosLabFeedDeploy")` using the existing `load`, `bashWorks` helpers:
  - `it("has exactly the five strict ENV_VAR parameters")` with the patterns above.
  - `it("never interpolates a parameter into shell text")`: no `{{` in the command.
  - `it("checks all three digests before writing the feed")`: the three `sha256sum` checks appear before the first write into `$FEED_DIR`.
  - `it("writes installer and blockmap before lab.yml, each via a temp name and mv in the same directory")`: index of the `mv` to `lab.yml` is after both other `mv`s; temp names are under `$FEED_DIR` (*as shipped:* the staging directory is a root-only `mktemp -d` in `FEED_DIR`'s parent, checked to be on the same file system, so partial files are never served).
  - `it("refuses a version that is not higher than the served one")`: a `sort -V` comparison against the `version:` read from the served `lab.yml`, ending in `RT_FAIL reason=not_higher` (*as shipped:* `RT_FAIL gate=version reason=version-not-higher`).
  - `it("keeps the current and one previous version")`: prune runs after the swap and keeps two installer versions (*as shipped:* after G-Smoke passes, so a revert never points at a pruned file).
  - `it("prints only RT_ lines on stdout and is valid bash")` (as the Console case).
- [ ] **Step 2: Run** `cd services/backend-core/apps/api && npx jest test/deploy/lab-ssm-documents.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Write the document**, structured like `RT-ConsoleLabDeploy.yaml` (root-only log under `/var/log/rt-deploy`, wrapper heredoc). Order: G-Host (config file present, `FEED_DIR` exists and is root-owned, origin answers) → read prior version → refuse not-higher → fetch the three assets from `https://github.com/Kemetra-Labs/Retail-Tower-Erp/releases/download/<tag>/` into a temp dir under `FEED_DIR` → digest checks → `lab.yml` `version` equals `Version` and its `sha512` matches the installer → `mv` installer, blockmap, then `lab.yml` → prune → G-Smoke (the origin's `lab.yml` has `ChannelDigest`) → `RT_DONE`. On a failed G-Smoke, restore the previous `lab.yml` (kept as `lab.yml.prev` before the swap). *As shipped:* G-Smoke runs before prune and also checks the served installer and blockmap digests; the previous `lab.yml` is kept in staging until G-Smoke passes and only then becomes `lab.yml.prev`, so a failed run keeps the N-1 channel file; `lab.yml`'s `sha512` and `size` are checked at every occurrence (top level and `files[]`); the document timeout is 1500 s, above the 1200 s sum of its curl limits.
- [ ] **Step 4: Run** the tests — Expected: PASS.
- [ ] **Step 5: Write the README section**: the owner creates the document from this file, adds `RT-PosLabFeedDeploy` to the deploy role's allowed documents, creates `/etc/rt-deploy/pos-feed.env`, the feed directory and the caddy route with a publicly trusted certificate. *As shipped:* lab-01's Caddy is the `dp2-caddy` container of the Backend-Core release (its `Caddyfile` bind-mounted from the release, only `/srv/console` mounted), so a hand-added route does not survive a Backend-Core deploy; the README records the two durable options as an open owner decision.
- [ ] **Step 6: Commit** `feat(backend-core): SSM document for the POS lab update feed`.

### Task 5: deploy-pos-lab.yml

**Files:**
- Create: `.github/workflows/deploy-pos-lab.yml`
- Create: `.github/release/test_pos_lab_workflow.py`

**Interfaces:**
- Consumes: release assets and manifest names (Task 3), document parameters and output lines (Task 4), `.github/release/ssm-run.sh` as the Console workflow uses it (*as shipped:* `deploy-console-lab.yml` does not use it and its label allowlist has no `pos`, so the send and poll are inline, as in `deploy-console-lab.yml`).
- Produces: dispatch inputs `pos_release` (`pos/vX.Y.Z`), `jira_key` (`RT-<n>`), `dry_run` (default `true`); ledgers `pos-lab-planned-<run_id>` and `pos-lab-live-<run_id>` with outcome `deployed|failed`.

- [ ] **Step 1: Write the failing test**, mirroring the `DeployConsoleLab` cases for this file: pinned actions, empty top permissions, dispatch only, inputs never expanded in `run:`, `dry_run` default `true`, concurrency group `deploy-aws-lab`, main only in both jobs, environment `aws-lab` and `id-token: write` only on `live`, live only after preflight and never on a dry-run, preflight runs no repository code, attestation verified with `--signer-workflow` `.github/workflows/release-pos.yml` for the tag, node by tags `Host=lab-01`, only `RT-PosLabFeedDeploy` sent with exactly the five parameters, strict `RT_` regex. Plus:
  - `test_preflight_checks_lab_yml_against_the_installer` (skip without bash): run the `Check lab.yml against the installer` step on a temp installer and a matching `lab.yml` → 0; with a wrong `sha512`, size or version → non-zero.
- [ ] **Step 2: Run** `python -m unittest discover -s .github/release -p test_pos_lab_workflow.py -v` — Expected: FAIL.
- [ ] **Step 3: Write the workflow** by copying the structure of `deploy-console-lab.yml` and removing the pin rule and Backend-Core release input. The preflight lab.yml check computes `openssl dgst -sha512 -binary | base64 -w0` and reads `version`, `path`, `sha512`, `size` from `lab.yml` with `yq` (*as shipped:* no `yq`; `size` exists only inside `files[]`, so every occurrence of each key is read with `sed` and must match, the reading of S1's `Assert-ChannelFile`. The blockmap and `lab.yml` digests come from `release-manifest.json`, checked with S1 publish's predicate, since only the installer has a `.sha256` and an attestation).
- [ ] **Step 4: Run** the test — Expected: PASS. Then `python -m unittest discover -s .github/release` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(release): approval-gated deploy of a POS release to the lab feed`.

## Slice S3 — device provisioning and the update drill (docs PR)

### Task 6: Runbook for the stable lab device

**Files:**
- Create: `apps/pos/docs/runbook/lab-stable-device.md`
- Modify: `apps/pos/docs/runbook/lab-nsis-installer.md` (one line in "Next" linking it)

- [ ] **Step 1: Write the runbook** with these sections, Cairo times in examples:
  - *Once (owner):* run `new-lab-release-cert.ps1`; set the two secrets and `POS_LAB_ROOT_SHA1` on `release-pos-sign`; protect `release-pos-sign` and `release-pos` (owner reviewer, tag policy `pos/v*`); apply the S2 owner steps.
  - *Once (device):* import the public root into the Windows user's Trusted Root store; `setx ELECTRON_UPDATE_FEED_URL "<origin>/<path>"` and `setx POS_PULSE_UPDATE_CHANNEL lab`; sign out and in; install the first release's installer; confirm `update:state` reaches `idle`, and that no `update:disabled reason=no_origin` line appears after a relaunch.
  - *Per release:* version-bump PR, merge, `git tag pos/vX.Y.Z <sha>` and push; approve `sign-release` and `publish`; `deploy-pos-lab` dry-run, then live with `aws-lab` approval; on the device, close the shift and read the current session's `update:state` lines (`checking`, `downloading`, `downloaded`, `installing`), then `app.getVersion()` and that the DB row counts survived.
  - *Differential download:* record whether the update used the `.blockmap` (caddy serves HTTP Range) or fell back to a full download.
  - *Evidence:* what to post on the Jira issue; what to add to the Confluence lab runbook page (RETAIL 18874418).
- [ ] **Step 2: Check links and commands**: every script, workflow and variable name in the runbook exists in Tasks 1–5 (grep each).
- [ ] **Step 3: Commit** `docs(pos): stable lab device and per-release update drill`.

## Order and proof

S1 (Tasks 1–3) → owner steps for certificates and environments → first real tag `pos/v0.1.1` after a bump PR → S2 (Tasks 4–5) → owner steps for SSM, IAM, caddy → S3 (Task 6) → first device install and one N → N+1 update. Each PR runs `pr-review` (quick mode, fresh subagent) before it opens.
