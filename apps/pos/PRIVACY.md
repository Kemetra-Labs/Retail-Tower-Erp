> **DRAFT for owner review (RT-1313). NOT a published policy. NOT committed. Do not link from the README or any release surface until the owner approves it and a separate docs-only PR is authorized.**
> Redrafted from repository evidence at `main` `abe380747280b77d275ebf317b1db0ce1600a23d` (static source review; no runtime network capture has been run). The three earlier offline drafts were not available and were not used.
> Markers: `[OWNER: ...]` needs an owner input. `[UNVERIFIED: ...]` is a statement the evidence does not yet support: resolve it or keep it as a blocker before publishing. Delete this banner only when every marker is resolved.

# POS Pulse privacy policy

POS Pulse is the Windows cashier terminal of Retail Tower OS, used at pharmacy branches. It is installed and operated by a business (the **operator**: the pharmacy or its IT provider), not by us on the operator's behalf. This document says what the application stores on the terminal, which network destinations it contacts, and what controls exist. It describes the application code in this repository. It does not describe any operator's own backend deployment or internal policies.

## 1. Who is responsible

* The application is developed by `[OWNER: legal name of the project/organization]` (the repository owner, Kemetra-Labs).
* The **operator** decides which Backend-Core server, identity project and update server a terminal uses, and is responsible for the data held on those systems and for notices to its own staff and customers.
* Contact for privacy questions or data requests: `[OWNER: contact address]`. Security reports: see [SECURITY.md](SECURITY.md). `[UNVERIFIED: GitHub private vulnerability reporting, which SECURITY.md relies on, is not enabled on the repository as of 2026-11-10; enable it or give a contact address before publishing.]`

## 2. This program's network behavior, in one paragraph

By default the application contacts only the servers the operator configured at provisioning (Backend-Core, the identity provider project and, if configured, an update server). No advertising or analytics SDK appears in its dependency list. Error reports are sent to Backend-Core, which forwards them onward (section 5). `[UNVERIFIED: Chromium/Electron background traffic of the packaged build has not been captured at runtime.]`

## 3. Data stored on the terminal

Stored under the Windows user's application data folder (SQLite database, log files, a telemetry queue):

| Data | Notes |
|---|---|
| Sales, carts, payments and tender lines, returns, voids, shift and cash-up records, receipts and print/drawer events | Operational business records, kept so the terminal can sell offline and sync later. |
| Product catalogue and barcodes; tenant name and logo; branch address | Read down from Backend-Core. |
| Staff identifiers and display names (cashiers, managers) | Needed to attribute every sale to a named operator. |
| Cashier and manager PIN records | Argon2id hash and per-record salt; not the PIN itself (the manager store reuses the same hashing). |
| Device token | Stored with Electron `safeStorage` (Windows DPAPI). |
| Audit events and sync queues (outboxes) | Records of actions awaiting upload to Backend-Core. |
| Application logs | Daily files, kept 14 days, with sensitive keys redacted. |
| Database backups | Before a database upgrade the app copies the whole database into a `backups` folder and keeps the latest 3 copies. These hold sales data and are **not** removed on uninstall. |
| Queued error reports | Up to 30 reports for up to 7 days, only when error reporting is active; deleted when the terminal is re-paired. |

**Free-text fields.** Sale lines can carry a per-line note, and sync records and references can carry free text. The application does not look inside these. If staff type personal data into them, it is stored and synced like any other sale data. `[OWNER: decide whether to advise operators not to enter personal data in notes.]`

**Card data.** The project's documentation states that card details are not captured and that card payments use an external terminal. `[UNVERIFIED: not independently re-proven for this document.]`

**Retention on the terminal.** No automatic deletion of sales, audit or sync records was found in the source (this search was not exhaustive for every table). Uninstalling the application **keeps** the local database, outbox and secrets on purpose, so unsynced sales are never lost. To remove local data, the operator deletes the application data folder (which also holds the database backups) after confirming all records have synced. `[OWNER: confirm this is the supported removal procedure and document the exact folder.]`

## 4. Where data is sent

| Destination | What is sent | Who chose it |
|---|---|---|
| **Backend-Core** (the operator's server) | Pairing and device calls; catalogue and branding requests; sales, shift, return, void and voucher records; audit events; health checks; error-report and error-reporting-config requests. Authenticated with the device token. `[UNVERIFIED: exact per-record field lists were not audited for this document.]` | Operator |
| **Descope** (`api.descope.com`, a third-party identity provider) | A manager or administrator's sign-in identifier and password, sent directly from the terminal to Descope, with the operator's Descope project id. The server address is fixed in the application. The password is not logged or stored by the application. Staff sign-in by cashier PIN does not use Descope. `[UNVERIFIED: confirm the PIN path makes no Descope call.]` | Operator chooses the project; the host is built in |
| **Update server** (only if the operator sets one, https only) | An update check. The application installs an update only if it carries the pinned publisher's signature. | Operator |
| **Sentry** (error reports) | See section 5. | Operator and the project |

The terminal's web content cannot load remote resources (it is restricted to its own files), and no remote fonts, images or scripts were found.

## 5. Error reporting (Sentry)

* In a packaged production build, error reports go **only** to Backend-Core, which forwards them to the project's Sentry account. The terminal holds no Sentry key. In lab and development builds an operator-supplied key can send reports directly to Sentry's EU ingest.
* Each report is rebuilt from a short allowlist (error type, a masked and truncated message, stack frames with local paths shortened, release and build identifiers). Request data, user data, breadcrumbs, screenshots, the computer name, and extra context are dropped. Tokens, e-mail addresses, phone numbers and URL query strings in messages are masked. Backend-Core adds pseudonymous references for tenant, store and terminal.
* **Control.** Error reporting is switched on or off centrally by the Backend-Core operator. There is no switch on the terminal or in the installer. This is a deliberate position (section 8, owner decision 2026-11-10): error reports go only to the operator's own Backend-Core.
* What Sentry or Backend-Core keeps, and for how long, is governed by their own settings. `[OWNER: state Backend-Core and Sentry retention, or link to the operator's terms.]`

## 6. Operational processing and optional processing

* **Operational (needed to sell and keep records):** everything in sections 3 and 4 except error reporting.
* **Diagnostic:** error reporting and health checks, described above.
* **Not present:** advertising, analytics or usage tracking SDKs; sale data sold or shared with advertisers. `[UNVERIFIED: this follows from the dependency list and the destination sweep; it is not a runtime-verified claim.]`

## 7. Your choices and rights

Data about customers or staff is held by the operator, not by the application's authors. Requests to access, correct or delete it go to the operator `[OWNER: operator contact placeholder for deployments you run]`. For a deployment run by `[OWNER: legal name]`, write to `[OWNER: contact address]`. `[OWNER: add the retention periods and the legal basis that apply.]`

## 8. Installer notice and open items (remove before publishing)

**Owner decision recorded 2026-11-10 (RT-1313): option (a), "operator-specified, plus an installer notice".**

The position this policy takes: every destination the application contacts is one the operator chooses and provisions (Backend-Core address, Descope project, update server), so the transfers are to systems specified by the person installing or operating it, and the application sends nothing elsewhere. The Descope server address is built into the application and Backend-Core forwards error reports onward, so this policy says both plainly (sections 4 and 5) instead of relying on the wording alone. SignPath decides whether it accepts this reading.

What option (a) still requires before anything is submitted:
1. **An installer notice does not exist yet.** The installer is a one-click per-user NSIS installer with no notice page. Showing this policy during installation is a code and packaging change (a separate, authorized issue, not RT-1313). Until it ships, do not state that the installer shows a privacy notice.
2. **No terminal-side opt-out is added** under this option. Do not describe any opt-out other than the operator's central switch for error reporting (section 5).
3. **Provisioning wording:** the operator-specified claim holds only if a terminal cannot be pointed at a destination the operator did not choose. `[UNVERIFIED: confirm the only configuration sources are the operator's environment at provisioning.]`
4. **Server-side retention and the data-subject contact** are owner inputs.

## 9. Changes

This policy is versioned in the repository. Material changes are noted in the git history of `apps/pos/PRIVACY.md`. Last reviewed: `[OWNER: date after approval]`.

## 10. Third-party components

The application's `NOTICE` file covers the vendored icon set; the licences of the bundled libraries are recorded in the package lockfile, and a complete licence review is not finished. Electron includes Chromium, which has its own privacy behavior. `[UNVERIFIED: Chromium/Electron default background requests were not captured; this policy makes no claim about them.]` The privacy policies of Descope and Sentry apply to data sent to them.
