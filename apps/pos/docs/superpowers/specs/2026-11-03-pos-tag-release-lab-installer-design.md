# POS tag-release to a stable lab installer, delivered like the other products — Design

| | |
|:--|:--|
| Date | 2026-11-03 |
| Work Mode | **Planning / Docs** — this document is the deliverable; nothing below is built yet |
| Jira | **No issue yet.** Every slice in §6 needs an RT issue before work starts (CLAUDE.md §8 and §14). Related: RT-321 (To Do) covers the NSIS target and a signed release workflow with a cloud HSM; this design is the lab-certificate interim of that path. RT-717 (In Progress) is the gated umbrella for real releases and states that creating issues is not authorization to release or deploy. The owner chose a new issue under RT-717 (§11). |
| Extends | `2026-10-09-rt-234-pos-delivery-update-design.md` (RT-234) and the shipped RT-772 updater |
| Baseline | `main` @ `683b0b56` |

## 1. Intent and why

The owner wants the POS to have **one stable, installed `.exe`** on a test device, and wants every new
POS version to reach that device **through the real auto-updater**, so that an update can be tried
exactly as a terminal will receive it. The release path should look like the other products: push a
`pos/vX.Y.Z` tag, get an immutable release, then run a manual, approval-gated deploy.

Today a POS version cannot be tried that way. The shipped config builds an unpacked folder, and the
installer exists only as hand-run lab scripts that sign with a certificate held on one laptop.

## 2. Verified current state

| Area | Fact (checked in this worktree) |
|:--|:--|
| Shipped build | `apps/pos/electron-builder.yml`: `win.target: dir`, unsigned, RT-164 fuses on, no `publish`. |
| Lab installer | `electron-builder.lab.yml` (extends the shipped file): per-user NSIS (`oneClick`, no elevation, `deleteAppDataOnUninstall: false`), `publisherName` = `Kemetra POS LAB TEST - NOT FOR PRODUCTION`, `sign` hook `scripts/lab/lab-sign.cjs`, one `generic` publish entry on `rt772-lab.test`, channel `lab`. Built by hand with `scripts/lab/build-lab-installer.ps1`. |
| Lab signing | Self-signed root and leaf, **non-exportable**, in `Cert:\CurrentUser\My` on the owner's build machine. `lab-sign.cjs` refuses any certificate without the lab marker. The CI drill (`pos-lab-update-drill.yml`) uses an *ephemeral* certificate, so nothing it builds is a stable artifact. |
| Updater | Shipped (RT-772): packaged-only, fail closed, installs only at a safe point. Inputs: `ELECTRON_UPDATE_FEED_URL` (origin), `POS_PULSE_UPDATE_CHANNEL` (`lab`/`canary`/`stable`), and the publisher pin baked into `app-update.yml`. The installer's relaunch does **not** inherit the process environment (lab runbook), so a real device needs both variables set persistently. |
| Release workflow | `.github/workflows/release-pos.yml`: `pos/vX.Y.Z` tag or dry-run dispatch; builds an **unsigned `dir` zip**; writes a manifest; its `publish` job **refuses** ("disabled until RT-717"). No `pos/v*` tag exists yet; `apps/pos/package.json` is `0.1.0`. |
| Reference path | Admin-Console: `release-admin-console.yml` publishes an attested, never-overwritten GitHub release behind a tag-only protected environment; `deploy-console-lab.yml` then verifies that release and deploys it to lab-01 through OIDC and an owner-created SSM document, behind the `aws-lab` approval. Backend-Core and ERP follow the same shape. |
| Repository | Public. Lab hosts: lab-01 runs Backend-Core and the Console hosting (caddy). |
| Lab certificates | Read from the owner's store on 2026-11-03 (metadata only): root `...LAB TEST - NOT FOR PRODUCTION ROOT` expires 2027-04-19 (180 days); leaf `...LAB TEST - NOT FOR PRODUCTION` expires 2027-01-19. Both non-exportable. `new-lab-signing-cert.ps1` clamps the leaf's expiry to the root's. |
| Signing hook | `lab-sign.cjs` runs inside electron-builder and signs the app exe, the uninstaller and the installer. `lab.yml` (`sha512`, size) and the `.blockmap` are computed over the **signed** installer, so signing after the build would break them. |

## 3. Goals, non-goals, anti-goals

**Goals**

- A `pos/vX.Y.Z` tag produces a **signed per-user NSIS installer**, its `.blockmap`, the `lab.yml`
  channel file, a manifest and a build-provenance attestation, published as an immutable GitHub release.
- A manual, approval-gated `deploy-pos-lab` workflow publishes one such release into a **lab update
  feed** on lab-01, with a stable HTTPS URL.
- A lab device installed once from the first installer then takes each later version through the real
  `UpdateService`, and the run leaves checkable evidence.

**Non-goals**

- Production signing (RT-321, cloud HSM, RFC 3161), the `canary` and `stable` channels, staged rollout,
  and promotion (RT-234 §10). Only the `lab` channel is fed.
- Fleet version reporting and minimum-supported-version (RT-323, gated contract).
- Changing the updater's trust inputs or logic.

**Anti-goals (a failure even if it works)**

- Any build signed by this lab certificate that a production terminal could trust. The subject marker
  must keep making the lab pin unable to match a production certificate, and the reverse.
- Weakening the updater: fail-closed verification, the publisher pin, the safe-point gate and the
  schema-ahead guard stay as they are. The updater must not learn a "default origin" from the build.
- A feed that serves a `lab.yml` pointing at a file that is not there yet, or a version lower than the
  current one (RT-234 P-3, roll-forward only).
- A private key in the repository, in logs, or readable by pull-request code.

## 4. Decisions

Owner decisions, 2026-11-03:

| ID | Decision |
|:--|:--|
| D-1 | The goal is an **installer** (NSIS `.exe`), not the unpacked `dir` build. |
| D-2 | The first stable build is signed with the **lab test certificate**, tried on a lab device. |
| D-3 | Signing in CI uses a **persistent lab certificate held as a GitHub environment secret**. |
| D-4 | The feed lives on **lab-01**, deployed the same way as `deploy-console-lab.yml`. |
| D-5 | Versions are released by **tag and deployed like the other products**. |

My calls (the owner can overrule; marked so they are not read as agreed):

| ID | Call |
|:--|:--|
| C-1 | **Only the leaf's key goes in CI.** The lab root key stays non-exportable on the owner's machine and signs the leaf; only the leaf with its key, plus the root's **public** certificate (a password-protected PFX, leaf + chain; §8 step 1), becomes the secret. A leaked secret then cannot mint new certificates, and rotation is a new leaf under the same root, so devices keep trusting it. This deviates from RT-234 §5.1 and the lab runbook ("no `.pfx`") **for the lab channel only**; production stays on the cloud-HSM path. |
| C-2 | **A new lab root and leaf pair for this stable channel**, with the same subject names so the baked publisher pin is unchanged: root about two years, leaf about one. The existing 180-day pair (root expires 2027-04-19) cannot back a one-year leaf, and the stable device is new, so trusting a new public root costs one import. The existing drill pair is left alone. No timestamp unless the owner sets `RT772_LAB_TSA_URL`; the signature stops verifying when the leaf expires, which is the accepted lab trade-off. |
| C-6 | **Signing placement.** `win-unpacked` is built in a secret-free job (Electron fuses are applied there). A signing job in the `release-pos-sign` environment downloads it and runs electron-builder with `--prepackaged` and the `lab-sign.cjs` hook, after `npm ci --ignore-scripts`, so no package install script runs beside the secret. The installer, `lab.yml` and `.blockmap` are produced after signing. If `--prepackaged` does not sign the app exe, the fallback is signing inside that same job, with the same `--ignore-scripts` rule; the acceptance in §9 decides, not the mechanism. |
| C-7 | **Two environments.** `release-pos-sign` holds the leaf secrets and admits only `pos/v*` tags; the existing `release-pos` runs publish and cannot read them. Both require the owner as reviewer (RT-234 §5.2), so a release takes two approvals. The owner may drop the reviewer on `release-pos-sign`, since publish still gates. |
| C-8 | The baked `publish.url` stays a non-resolving `.test` placeholder: a marker, never the real origin. The device origin comes only from `ELECTRON_UPDATE_FEED_URL`. |
| C-9 | `RT-PosLabFeedDeploy.yaml` is committed under `services/backend-core/deploy/lab/ssm/` as source, like `RT-ConsoleLabDeploy.yaml`; the owner applies it. The deploy role is reused, with the new document name added by the owner. |
| C-3 | The **tag must equal `apps/pos/package.json` version** or the release fails at `resolve`. The version inside the installer and `lab.yml` is what electron-updater compares, so the tag cannot disagree with it. A release therefore needs a version-bump PR before the tag. |
| C-4 | GitHub Releases is the **immutable release store**, not the update feed. RT-234 P-2 rejects GitHub Releases as the feed, and still stands. |
| C-5 | The feed keeps the current and one previous installer with their blockmaps. After `lab.yml` is swapped, older files are pruned. The "not higher" refusal reads the version in the `lab.yml` the feed serves now. |

## 5. Flow

```
version-bump PR merged to main
        |
   git tag pos/vX.Y.Z  (on main)
        v
release-pos.yml  (windows runner, environment-free until publish)
   resolve  -> SHA on main, tag == package.json version
   build    -> win-unpacked (fuses applied), secret-free
   sign     -> `release-pos-sign` environment (tag-only): electron-builder --prepackaged with the
               lab leaf -> signed NSIS installer + .blockmap + lab.yml; then verify the signature
               and the publisher pin on app exe, uninstaller and installer; fail if not valid
   manifest -> release-manifest.json, SHA256SUMS
   publish  -> attest, immutable GitHub release pos/vX.Y.Z (never overwrites)
        |
deploy-pos-lab.yml  (manual, dry-run by default, aws-lab approval for live)
   preflight -> release verified: commit on main, digests, attestation, lab.yml sha512 == installer
   live      -> OIDC -> SSM document RT-PosLabFeedDeploy on lab-01
                  installer + blockmap first, lab.yml last; refuse a version not higher than the feed's
        |
https://<lab feed origin>/<path>/lab.yml   <- lab device (channel lab, safe point) updates itself
```

## 6. Slices

Each slice is its own Jira issue and PR, in this order. A slice that touches a path in the policy class
(`.github/**`) is a policy change and goes through the `required` gate's policy-approval rules.

**S1 — release-pos builds, signs and publishes the installer** (repo: `.github/workflows/release-pos.yml`,
`apps/pos/electron-builder*.yml`, `apps/pos/scripts/`, tests)

- Build the NSIS installer with a release config that reuses the lab config's identity, fuses, per-user
  install and publisher marker, and the `lab-sign.cjs` hook, so signing is not reimplemented.
- Sign as C-6 describes: import the leaf into the runner's certificate store non-exportable, sign,
  then **always remove it**. The signing job is the only job that can read the secret; build jobs
  read none.
- Verify the signature and the pin on the produced installer (a Windows step), and fail the release on
  anything but a valid signature with the lab publisher. Keep the RT-830 fuse readback and native-load
  smoke from the current workflow.
- Bake `resources/app-update.yml`. electron-builder writes it only when it packs the app itself, so with
  `--prepackaged` it is missing, and the updater refuses to run without the publisher pin it holds. Before
  packaging, the sign step writes exactly what electron-builder bakes for the lab config's `generic`
  provider: `url` and `channel` from `electron-builder.lab.yml`, `updaterCacheDirName`, and
  `publisherName` as a list holding only the lab publisher. The file sits outside `app.asar`, so fuses and
  asar integrity are unaffected. The installed copy is then checked to carry exactly that pin.
- Turn `publish` on for `pos/v*`, modelled line for line on `release-admin-console.yml` (protected
  environment check, package-vs-manifest check, attestation, never overwrite, tag-still-points-at-SHA).
  Assets: installer, `.blockmap`, `lab.yml`, `.sha256`, manifest.
- The dry-run signs with an ephemeral lab certificate, runs the same verification, reads no secret and
  publishes nothing.

**S2 — deploy-pos-lab** (repo: `.github/workflows/deploy-pos-lab.yml`; Backend-Core deploy area:
`services/backend-core/deploy/lab/ssm/RT-PosLabFeedDeploy.yaml`, caddy route)

- Same preflight as `deploy-console-lab.yml`, plus a check that `lab.yml`'s `sha512` and size match the
  installer. Shared concurrency group `deploy-aws-lab`.
- The SSM document re-checks digests on the host, writes installer and blockmap, then `lab.yml` last
  (atomic rename), refuses a version not higher than the one the feed serves, and reports strict
  `RT_*` lines only. It is the security boundary, as for the Console.
- **Cross-repo-area work:** the SSM document and caddy route live in the Backend-Core deploy area. The
  S2 Jira issue must authorize that explicitly (CLAUDE.md §8); otherwise stop at the workflow and hand
  the document to its owner.

**S3 — device provisioning and update drill runbook** (docs only: `docs/runbook/lab-nsis-installer.md`
or a sibling)

- One-time on the lab device: install the first signed installer, import the **public** lab root, set
  `ELECTRON_UPDATE_FEED_URL` and `POS_PULSE_UPDATE_CHANNEL=lab` persistently for the Windows user.
- Per update: tag, release, deploy, then read the `update:state` lines for `checking`, `downloading`,
  `downloaded`, `installing`, and confirm the new `app.getVersion()` and that `userData` survived.
- Negative cases stay those of the existing lab drill (tampered, unsigned, wrong publisher, open shift,
  older version).

## 7. Constraints

- `appId` `tech.smartdatapulse.pos` and `productName` `POS Pulse` are the update identity and install
  location. **The owner must confirm they are final before the first signed installer** (RT-234 §11.2);
  they are unchanged here.
- The lab publisher marker `Kemetra POS LAB TEST - NOT FOR PRODUCTION` stays. The marker check in
  `lab-sign.cjs` stays.
- Electron fuses are inherited, never restated or loosened.
- No new runtime dependency. CI-only tooling is allowed but each addition is called out in its PR.
- Terminals on the unpacked `dir` build cannot auto-update into NSIS: the first installed build is a
  manual install per terminal that keeps `userData` and the same Windows user (RT-234 §11.3).
- Times in evidence and runbooks are Cairo local time.

## 8. Owner steps (not for Claude)

Claude does not create certificates, set secrets, change environments or run SSM Run Command without
the owner's explicit yes and a Jira scope.

1. Create the new lab root (two years, non-exportable) and a one-year leaf under it (C-2) with
   `apps/pos/scripts/lab/new-lab-release-cert.ps1`. It exports a password-protected PFX that holds the
   leaf with its key **and the root's public certificate** (leaf + chain; CI refuses a PFX without the
   pinned root), checks that the PFX really contains both, and exports the public root `.cer`.
   On `release-pos-sign`, set:
   - secret `POS_LAB_SIGN_PFX_BASE64`: the base64 of the PFX file. This writes it straight into the
     secret without printing it: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('<pfx path>')) | gh secret set POS_LAB_SIGN_PFX_BASE64 --env release-pos-sign`
     (or `... | Set-Clipboard` to paste it in the GitHub UI). A trailing newline is harmless; base64
     decoding ignores whitespace.
   - secret `POS_LAB_SIGN_PFX_PASSWORD`: the PFX password.
   - environment **variable** (not a secret) `POS_LAB_ROOT_SHA1`: the root's SHA-1 thumbprint, which
     the script prints.

   Never print or commit the PFX or its password. Once both secrets are stored, delete the exportable
   leaf and its key from the owner's `Cert:\CurrentUser\My` (`Remove-Item Cert:\CurrentUser\My\<leaf thumbprint> -DeleteKey`;
   the script prints the thumbprint) and the PFX file. Import only the **public** root on the lab device.
2. Give `release-pos` a required reviewer and a deployment policy that admits exactly the tag pattern
   `pos/v*`. Give `release-pos-sign` a deployment policy that admits exactly `pos/v*` too; a required
   reviewer there is optional (C-7). The publish job reads both environments and refuses otherwise, as
   for the Console.
3. Create the SSM document, its IAM permission for the deploy role, and the caddy route and TLS for the
   lab feed origin on lab-01.
4. Provision the lab device (import the public root, set the two variables).

## 9. Acceptance

- A `pos/vX.Y.Z` tag on `main` yields a release with the five assets, an attestation that verifies
  against `release-pos.yml` for that tag, and a lab-signature check recorded in the run.
- A tag that is not on `main`, or does not equal the `package.json` version, fails at `resolve`.
- The dry-run dispatch builds and publishes nothing and needs no secret.
- `deploy-pos-lab` dry-run changes nothing and prints the planned ledger; live deploys only after the
  `aws-lab` approval, and a second deploy of the same or a lower version is refused.
- Lab device on N, feed at N+1: the device ends on N+1, logs the update states, keeps its database and
  secrets, and installs only at a safe point. Tampered, unsigned and wrong-publisher feeds are refused.
- In the released installer the app exe, the uninstaller and the installer all verify as valid with the
  lab publisher, and `lab.yml`'s `sha512` and size equal those of the final signed installer.
- With the caddy feed, a differential download is expected to work (it serves HTTP Range); S3 records
  whether it did, and the full-download fallback stays proven by the existing drill.
- The updater source and its tests are unchanged by S1 to S3.

## 10. Left to the builder

Exact job and step structure, the runner certificate-store mechanics, naming of the feed path and
files inside the SSM document, and the test layout, provided §3 and §7 hold.

## 11. Open

- Decided 2026-11-03: the device reaches the feed **over the internet through a publicly trusted TLS
  certificate**, served by caddy on lab-01 like the Console, so S3 needs no TLS-trust step. The host
  name and path are still the owner's to choose with the caddy route.
- Decided 2026-11-03: the work is a **new Jira issue under RT-717**, beside RT-321 (the production,
  cloud-HSM path). The issue is not created yet. The owner authorization RT-717 requires before any
  release or deploy action is also still to come; nothing here is authorized by this document.
- Whether the leaf may be exported at all under the owner's key-custody rules is the owner's to
  confirm in writing before S1 (C-1 narrows the exposure but does not remove it).
