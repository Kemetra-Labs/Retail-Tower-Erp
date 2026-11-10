> **DRAFT for owner review (RT-1313). NOT a published policy. NOT committed. SignPath Foundation has NOT approved this project and no application has been submitted.**
> Redrafted from repository evidence at `main` `abe380747280b77d275ebf317b1db0ce1600a23d`. Do not add this to the README or a release page until the owner approves it. Do not add the SignPath attribution line until SignPath approves the project.
> Markers: `[OWNER: ...]` needs an owner input. `[UNVERIFIED: ...]` is not yet supported by evidence.

# POS Pulse code signing policy

## 1. Current status (what is true today)

| Item | Status |
|---|---|
| Public releases `pos/v0.1.0` to `pos/v0.1.3` | The installer `POS-Pulse-LAB-Setup-<version>.exe` is signed with a **LAB TEST certificate issued by a private, self-made lab root** ("Kemetra POS LAB TEST - NOT FOR PRODUCTION") and is labelled for lab use only. `pos/v0.1.2` and `pos/v0.1.3` also carry an **unsigned** `.zip` package. Each release has a `.sha256` file for the installer and a `release-manifest.json` (the zip digest is in the manifest). |
| Pilot installer | A pilot lane exists in the repository (`release-pos-pilot.yml`, signing with a self-signed pilot certificate, "CN=Kemetra POS PILOT", no updater). **No pilot release has been published.** No machine trusts that certificate by default. |
| Production signing | Not in place. Tracked separately (RT-321). |
| SignPath Foundation | **Proposed only. Not applied for, not approved, not in use.** No published binary carries a SignPath signature. |

## 2. Proposed signing by SignPath Foundation (not approved)

If the project is accepted by SignPath Foundation, the Windows installer would be signed with a certificate issued to SignPath Foundation, through SignPath.io. This section describes the intended rules; it takes effect only after approval.

> Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).
> *(This attribution must not be shown anywhere until the project is approved.)*

Consequences the project accepts if it applies:
* The certificate publisher would be "SignPath Foundation", not the project's own legal entity. The application's update trust pins a publisher name, so a change of certificate also changes what the updater trusts. That change is out of scope here and belongs to the production-signing work (RT-321).
* Only artifacts built from this repository's source on a verifiable build system are signed. Every release signing request needs manual approval.

## 3. Team roles

**Owner decision 2026-11-10 (RT-1313):** state plainly that one person, the project owner, holds all three roles for now. `[OWNER: give the name and GitHub account to publish, and confirm MFA on GitHub and SignPath.]` Do not imply a separate reviewer or approver exists.

`[OWNER: this section needs real names, GitHub accounts or teams, and confirmation that every member uses multi-factor authentication on both GitHub and SignPath. Nothing below is claimed to be true until then.]`

| Role | Meaning | Members |
|---|---|---|
| Authors | May change the source without additional review | `[OWNER]` |
| Reviewers | Review every change from non-authors (pull requests) | `[OWNER]` |
| Approvers | Approve each signing request for a release | `[OWNER]` |

If one person holds all three roles, this policy says so plainly. `[OWNER: before publishing, check the organization's account-security settings match what this section claims.]`

## 4. What is built and approved

* Windows packages are built by GitHub Actions on GitHub-hosted runners from a commit on `main`, from a version tag. The release workflows refuse a commit that is not on `main` and a tag that does not match `apps/pos/package.json`.
* Signing runs in a GitHub environment that holds the signing material and admits only release tags (`release-pos-sign` today). **As of 2026-11-10 that signing environment has no required reviewer.** The human approval gate is on the publish environment (`release-pos`, one required reviewer), which runs after signing. The pilot lane's environments (`release-pos-pilot`, `release-pos-pilot-sign`) are defined in the workflow but **do not exist in GitHub yet**.
* Build provenance is attested and a manifest with SHA-256 digests is published with each release.
* SignPath requires manual approval of every signing request. `[OWNER: decide how that approval is given (SignPath approver, or a required reviewer on the signing environment) and make the setting match before publishing this section.]`

## 4a. Third-party and unsigned content

The installer bundles Electron (a prebuilt Chromium and Node runtime), native modules compiled from upstream source (for example `better-sqlite3` and `argon2`), and JavaScript libraries inside the application archive. These are third-party open-source components built or obtained by this project, and they are **not** separately signed by their upstream projects as part of this release. `[OWNER/DECISION: SignPath requires that a project signs only its own source and may include unsigned upstream binaries. Confirm with SignPath which of the installer's files would be signed (for example the application executable and uninstaller) and which are included unsigned.]` Licence review of these components is in progress and not complete.

## 5. Privacy

See the [privacy policy](PRIVACY.md) `[after approval]`. The application contacts only the servers its operator configures, plus Descope for manager sign-in; error reports go to Backend-Core. Owner decision 2026-11-10: the project treats all destinations as operator-specified and will add an installation-time notice; no terminal-side opt-out is planned (see PRIVACY.md section 8). The installer does not show that notice yet. `[UNVERIFIED: do not state otherwise until the installer change ships.]`

## 6. Verifying a release

1. Download the installer and its `.sha256` file from the same GitHub release. Compare the digest (`Get-FileHash -Algorithm SHA256 <file>`).
2. Check the digest against `release-manifest.json` in the release.
3. Verify build provenance: `gh attestation verify <file> --repo Kemetra-Labs/Retail-Tower-Erp`.
4. Check the Windows signature: `Get-AuthenticodeSignature <file>`. For the current LAB installer the signer is the **LAB TEST** certificate and Windows will not trust it; that is expected. Do not run a LAB-signed installer on a production terminal.

## 7. Revocation and reporting a problem

Report a suspected security issue or a signed file you believe violates this policy privately through GitHub's private vulnerability reporting on the repository's Security tab (see [SECURITY.md](SECURITY.md)) or to `[OWNER: contact address]`. If SignPath certificates are ever used, the project will help SignPath investigate any complaint, will stop signing on request, and will publish a notice with the affected versions if a certificate or key is revoked or a release is withdrawn.

## 8. Future acknowledgement

If the project is approved, the project will accept SignPath Foundation's code of conduct and conditions (https://signpath.org/terms.html), will not work around its technical constraints, and understands that violation can lead to suspension of the subscription or revocation of the certificate. `[OWNER: this acknowledgement is made only by the owner, at application time.]`

## 9. Open items (remove before publishing)

1. Installer notice page: decided (operator-specified plus notice), but **not built**; needs its own issue before applying (blocker).
2. Real roles, names and MFA confirmation (blocker).
3. Reputation evidence for SignPath's review (timing decided by the owner).
4. Whether the LAB-only installer counts as "already released in the form to be signed" (SignPath's call).
5. Which installer files SignPath would sign.
6. Signing-environment approval: no required reviewer today, and the pilot environments do not exist yet. Make the settings match section 4 before publishing.
7. GitHub private vulnerability reporting is currently **not enabled** on the repository, so the reporting path in section 7 and in `SECURITY.md` is not usable until it is enabled or a contact address is given.
