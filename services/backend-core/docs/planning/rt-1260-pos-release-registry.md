# RT-1260 — POS release registry and authenticated latest-release resolver: design

> **Status:** design note (Work Mode: **Planning**). **Jira holds the live status.** This file records the
> 2026-11-07 planning pass and is not a status tracker.
>
> This change is this note only. It has **no production code, no migration, no file under
> `packages/contracts/openapi/`, no workflow and no package change**. The OpenAPI in Appendix A is a **draft**
> kept in this note. Each part is applied only by the implementation work in §10, under that work's own
> `[GATED]` approval.
>
> **Release horizon:** Post-Pilot (D-6). Nothing here is a V1 pilot blocker.
>
> **Sources:**
> - Jira RT-1260 (this item) and its owner decisions, [comment 15843](https://rahmaqanater.atlassian.net/browse/RT-1260?focusedCommentId=15843)
>   (2026-11-07).
> - RT-234 design, `apps/pos/docs/superpowers/specs/2026-10-09-rt-234-pos-delivery-update-design.md` (§5 signing,
>   §9 fleet visibility, §10 channels and promotion).
> - POS lab installer design, `apps/pos/docs/superpowers/specs/2026-11-03-pos-tag-release-lab-installer-design.md`.
> - `packages/contracts/openapi/pos-device-health.openapi.yaml` (RT-327: version policy, auth, errors, audit,
>   revision rule), `devices.openapi.yaml` (pairing codes), `console-device-builds.openapi.yaml` (RT-719).
> - `packages/db/drizzle/0068_pos_device_health.sql` (`pos_version_policy`), `contracts-compat/pos-supported.yaml`,
>   `apps/pos/electron-builder.yml`, `.github/workflows/release-pos.yml`, `.github/release/manifest.py`.
> - Related Jira: RT-1006 (origin), RT-327 / RT-329 (version policy, reused), RT-321, RT-322, RT-717, RT-1001,
>   RT-1082, RT-1261.
> - Monorepo `Kemetra-Labs/Retail-Tower-Erp` `origin/main` **`e520cd2`**, read-only. No runtime was exercised.

---

## 1. The need

A customer cannot reach a trusted POS installer from any official surface today. One permanent download link
needs three things on the Backend-Core side, and this note fixes each of them:

1. a **registry** of promoted releases (§4);
2. an **eligibility rule** that picks the one release a customer may get (§5);
3. an **authenticated resolver** that returns that release and a short-lived download URL (§3).

The Console page, the S3 bucket, production signing and the promotion workflow are later work that this
contract anchors (§10).

## 2. What `main` has today (`e520cd2`)

| Area | Fact | Consequence |
| --- | --- | --- |
| Backend-Core | No release, artifact or download endpoint; no registry table. `pos_version_policy` (migration `0068`) holds `latest/recommended/min_supported_version` per channel `lab` / `canary` / `stable`, platform-level, set by `platformSetPosVersionPolicy`. | The registry is new. The version policy is reused unchanged. |
| Console | No Devices → Download POS screen, no download or installer code in `apps/admin-console/src`. | The page is later work (§10, S3). |
| POS build | `apps/pos/electron-builder.yml` builds only a `dir` target. No NSIS, no `publisherName`. The lab installer config (`electron-builder.lab.yml`) pins the publisher `Kemetra POS LAB TEST - NOT FOR PRODUCTION`. | No production installer and no production publisher exist yet. |
| Release workflow | `release-pos.yml` (lab only) runs on a `pos/vX.Y.Z` tag, writes `release-manifest.json` with `.github/release/manifest.py`, attests and publishes an immutable GitHub release. The signing class appears only as free text: `--note "signing=lab test certificate (RT-321 production signing not used)"`. | D-4 needs a **structured** `signing` field in the manifest (§6, §10 S2). |
| Published installers | `pos/v0.1.0`, `pos/v0.1.1`: lab-signed. | They must never be returned. §6 makes that impossible by construction. |
| Production signing | Not purchased (RT-321 comment 13254, restated in RT-322). The production certificate subject is unknown. | The production publisher pin has no value yet. The resolver fails closed until it has one (§6.4). |
| AWS access from Backend-Core | No `@aws-sdk/*` dependency in `apps/api`. | Presigning needs a new dependency and S3 read credentials (§10 S1, owner step). |
| Machine identity for a GitHub workflow | Backend-Core verifies no GitHub OIDC token and has no platform machine credential. | The registry writer's credential is **open** (§8, D-5a). |

## 3. The resolver

### 3.1 Request

`GET /api/v1/pos-releases/latest`, operation `consoleGetLatestPosRelease`. No body, no query parameter.

- **Channel.** The resolver serves the `stable` channel only. A new terminal is installed from it; `lab` and
  `canary` terminals are provisioned by Kemetra (RT-234 §10) and never use this page. A `channel` parameter is not
  offered; adding one later is an additive contract change. *This is a design choice of this note, for owner
  review; it is not an owner decision.*
- **Tenant.** The active tenant of the session. A release is platform-level, so the tenant only decides who may ask.

### 3.2 Authorization (D-3)

The same principal and guards as the pairing-code routes (`apps/api/src/devices/pairing-codes.controller.ts`):

- the human `cookieAuth` session (`dp2_session`), `SessionOnlyAdminGuard` → `TenantContextGuard` → `RolesGuard`;
- `@Roles("owner", "tenant_admin", "store_manager")`: the roles that can issue pairing codes;
- no entitlement check until RT-1001 exists (D-3). The later check is an extra predicate after the role, not a
  change to this one.

A `store_manager` is store-scoped on the pairing routes. The installer is the same for every store, so the
resolver checks the role only, not a store scope.

| Caller | Outcome |
| --- | --- |
| No session, an invalid or expired cookie, a bearer token, a POS `device` token or an operator envelope | **401** `unauthorized`. Non-disclosing; nothing is presigned, no audit row. |
| Signed in, no active tenant | **401** `unauthorized`: `TenantContextGuard` refuses a session without `activeTenantId` before the handler runs (`apps/api/src/context/tenant-context.guard.ts`). No route-specific guard is proposed. |
| Signed in, no active membership in that tenant | **404** `not_found` (the same guard, FR-ISO-4). |
| Signed in, role not `owner` / `tenant_admin` / `store_manager` | **404** `not_found` (as the devices surface: the non-disclosing 404, no 403), identical to the row above. No URL, no audit row. |
| Signed in with an allowed role | **200** with `available: true` and the release (§3.3), or `available: false` (§3.4). |
| Platform admin (`users.is_platform_admin`) with a live membership in the active tenant | Admitted whatever the membership role: `RolesGuard` lets a platform admin through (`apps/api/src/auth/roles.guard.ts`). **200** as above. |
| Platform admin with no membership, with an `active` RT-414 support session for exactly that tenant | Admitted by `TenantContextGuard`'s support-session gate. **200** as above. |
| Platform admin with no membership and no live, unexpired session for that tenant | **403** `support_session_required` or `support_session_expired` from the RT-414 gate. Not a 404: the reused guard refuses before the role check. No URL, no audit row of this route. (`support_session_read_only` cannot occur here: the gate applies it only to unsafe methods on a suspended tenant, and this route is a `GET`.) |

Every RT-414 gate decision, admitted or refused, writes one `platform.cross_tenant.accessed` row
(`support-session.gate.ts`); the resolver's own `pos.release.download_link_issued` row (§3.6) is separate.

No route-specific guard is proposed: the resolver reuses the pairing routes' guard chain, and this matrix is that
chain's behaviour. D-3 names the tenant roles that may download; platform admins reach every tenant route the
same way, under RT-414.

### 3.3 What the customer sees (200, `available: true`)

Exactly these fields and nothing else (`additionalProperties: false`):

| Field | Meaning |
| --- | --- |
| `version` | The release version, equal to the channel's `recommended_version`. |
| `sha256` | The installer's SHA-256 (64 lower-case hex), from the registry row. The page shows it so the customer can check the file. |
| `sizeBytes` | The installer size in bytes, from the registry row. |
| `fileName` | The file name to save, e.g. `POS-Pulse-Setup-1.4.0.exe`. Derived from the version on the server; never a stored URL. |
| `expectedPublisher` | The Authenticode publisher the customer should see in Windows: the configured production publisher pin, which the row is required to equal (§6). |
| `downloadUrl` | An S3 presigned `GET` URL for the installer object (D-1). |
| `expiresAt` | When `downloadUrl` stops working (server clock). |

Not returned: the registry id, the tag, the attestation reference, the bucket, the object key, `approved_by`, the
policy revision, other versions, or the reason a release is unavailable.

**The URL.** Presigned `GetObject` on the private bucket (D-1), signed by Backend-Core at request time, with:

- a lifetime of **300 seconds** by default, configurable to at most **900 seconds**; the contract fixes the
  maximum, not the default;
- `response-content-disposition: attachment; filename="<fileName>"`;
- `VersionId` = the row's `artifact_version_id`, so the URL serves exactly the object version whose digest and
  publisher the promotion workflow verified (§4.1). A later write to the same key, by anyone with bucket write
  access, creates a new version that this URL never serves;
- no other override. The bucket name and the region are server configuration. The object key and version come
  from the registry row only (§4); a request can never choose either.

The response carries `Cache-Control: no-store`. A presigned URL is a bearer capability for 5 minutes: it is never
logged, never written to an audit row and never sent to Sentry or Datadog.

### 3.4 No eligible release (200, `available: false`)

`{ "available": false }` and no other key. This is the answer when §5 selects nothing, for any reason. The
customer sees one message ("No POS release is available yet"); the page never learns why. The reason is recorded
server-side only, in a metric with a bounded `reason` label (§3.6).

A 200 is used, not a 404, because the 404 already means "not allowed" (§3.2) and the page must tell the two apart
without the reason leaking.

### 3.5 Errors

The canonical envelope `{ error: { code, message, request_id } }`, as RT-327.

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | Any query parameter is present (the route takes none). Checked after the guards. |
| 401 | `unauthorized` | §3.2, including a session with no active tenant. |
| 403 | `support_session_required` / `support_session_expired` | A platform admin without membership or a live RT-414 support session (§3.2). |
| 404 | `not_found` | §3.2. Non-disclosing. |
| 429 | `rate_limited` | The RT-574 console limit. Class `read` is proposed; the class file is `apps/api/test/console-rate-limit/classes/pos-releases.rate-limit.yaml` (§9). |
| 500 | `system_failure` | Unexpected error, including a presign failure. A presign failure is never `available: false`: that would hide a broken bucket or credential as "no release". |

### 3.6 Audit and metrics

- **One audit row per 200 with `available: true`:** `pos.release.download_link_issued`, tenant-scoped (the active
  tenant), actor the session user, metadata allowlist `releaseId`, `version`. No URL, no key, no email. Reading a
  release grants a time-limited download, so it is recorded, as `consoleListPairingCodes` records
  `pairing_codes.listed`. *Proposal of this note, for owner review.*
- **No audit row** for 401, 404, 400, 429, 500 or `available: false`.
- **One metric counter** `pos_release_resolve_total{outcome}` with `outcome` in `issued`, `none_no_policy`,
  `none_no_row`, `none_not_approved`, `none_not_production`, `none_publisher_mismatch`, `none_pin_unset`,
  `none_below_minimum`, `none_not_activated`. No version, tenant or user label.

## 4. The registry

### 4.1 Table `pos_release_registry` (draft; the migration is §10 S1)

One row per promoted release. Platform-level, like `pos_version_policy`: not tenant data, no `tenant_id`.

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` PK | UUIDv7. |
| `tag` | `text` NOT NULL UNIQUE | `^pos/v` + the version. CHECK `tag = 'pos/v' \|\| version`. The `pos/v*` pattern is unchanged (D-4). |
| `version` | `text` NOT NULL UNIQUE | The contract's `AppVersion` pattern (semver, no build metadata, 5..32). |
| `sha256` | `text` NOT NULL UNIQUE | CHECK `^[0-9a-f]{64}$`. The digest of the signed installer. |
| `size_bytes` | `bigint` NOT NULL | CHECK `> 0 AND <= 2147483648` (2 GiB). |
| `publisher` | `text` NOT NULL | The Authenticode subject read from the signed installer at promotion. CHECK length 1..200 and CHECK `publisher NOT ILIKE '%NOT FOR PRODUCTION%' AND publisher NOT ILIKE '%LAB TEST%'` (§6.2). |
| `signing_class` | `pos_signing_class` NOT NULL | Enum `lab`, `production` (the manifest vocabulary, §6.1). CHECK `signing_class = 'production'` (§6.2). |
| `attestation_ref` | `text` NOT NULL | The GitHub attestation URL or id of the installer digest. CHECK pattern `^https://github\.com/Kemetra-Labs/Retail-Tower-Erp/attestations/[0-9]+$`. |
| `source_sha` | `text` NOT NULL | The commit the tag points at. CHECK `^[0-9a-f]{40}$`. |
| `artifact_key` | `text` NOT NULL UNIQUE | The S3 object key, not a URL. CHECK `artifact_key = 'pos/releases/' \|\| version \|\| '/POS-Pulse-Setup-' \|\| version \|\| '.exe'`. The bucket is configuration (§3.3). |
| `artifact_version_id` | `text` NOT NULL | The S3 `VersionId` of the object the workflow uploaded and verified (sha256 and Authenticode publisher over those exact bytes). CHECK length 1..1024. Every presigned URL names it (§3.3), so a replaced object is never served under this row's digest. Requires bucket versioning (§9). |
| `approved` | `boolean` NOT NULL | `true` at insert (the approval happened in the promotion environment, §8). Set to `false` only by a withdrawal. |
| `approved_at` | `timestamptz` NOT NULL | The approval instant reported by the workflow, checked against the server clock (not in the future, not more than 24 h old). |
| `approved_by` | `text` NOT NULL | The GitHub login of the environment reviewer who approved. CHECK `^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$`. A login, never an email. |
| `promotion_run_url` | `text` NOT NULL | The workflow run that wrote the row. CHECK `^https://github\.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/[0-9]+(/attempts/[0-9]+)?$`. |
| `registered_at` | `timestamptz` NOT NULL DEFAULT `now()` | Server clock. |
| `withdrawn_at` | `timestamptz` NULL | Set with `approved = false`. CHECK `approved = (withdrawn_at IS NULL)`. |
| `withdrawn_by` | `text` NULL | GitHub login, same pattern. CHECK `(withdrawn_at IS NULL) = (withdrawn_by IS NULL)`. |
| `activated_at` | `timestamptz` NULL | Set once by `platformActivatePosRelease` (§8.3, E7); server clock. Never cleared: withdrawal (`approved = false`) is what stops a release. |
| `activated_by_user_id` | `uuid` NULL | The platform admin who activated it (a user id, never an email). CHECK `(activated_at IS NULL) = (activated_by_user_id IS NULL)`. |

**Immutability.** No column except `approved`, `withdrawn_at`, `withdrawn_by` and, once, `activated_at` /
`activated_by_user_id` ever changes, and a withdrawn
row is never re-approved: a fix ships a higher version (RT-234 P-3, roll-forward only). A BEFORE UPDATE trigger
refuses any other change and refuses `approved` going from `false` to `true`. No DELETE: no policy, no grant.

**RLS.** ENABLE + FORCE. SELECT open to every context (the resolver runs in a tenant context; the registry is
global and holds no tenant or personal data, as `pos_version_policy`). INSERT and UPDATE require the promotion
writer's GUC (`app.pos_release_writer = 'true'`), set only by the registry-write routes (§8); the activation
UPDATE requires `app.is_platform_admin = 'true'` and may touch only the two activation columns.

**Data lifecycle (§XIV).** BUSINESS-class release metadata: versions, digests, a certificate subject, GitHub
logins of the approvers and URLs. No customer data, no secret. Kept for the life of the system: it is the record
of what Kemetra shipped.

### 4.2 Audit per write

Platform-scoped rows (`tenant_id` null, readable through `listPlatformAuditEvents`), written **in the same
transaction** as the change, as `pos.release_policy.changed` (RT-327):

| Write | Action | Metadata allowlist |
| --- | --- | --- |
| Register | `pos.release.registered` | `releaseId`, `tag`, `version`, `sha256`, `sizeBytes`, `publisher`, `signingClass`, `attestationRef`, `sourceSha`, `approvedBy`, `approvedAt`, `promotionRunUrl`, `artifactVersionId` |
| Register replay (same row, §8) | none | — |
| Withdraw | `pos.release.withdrawn` | `releaseId`, `version`, `withdrawnBy`, `promotionRunUrl` |
| Withdraw replay (already withdrawn) | none | — |
| Activate (platform admin, §8.3) | `pos.release.activated` | `releaseId`, `version`; actor the platform admin |
| Activate replay (already activated) | none | — |

The actor is the promotion principal (§8). How the audit row names a non-user actor depends on D-5a and on the
`audit_events` actor columns; **Needs verification** in S1.

## 5. The eligibility rule

Inputs: the `stable` policy row and the registry. Server configuration: `POS_RELEASE_PRODUCTION_PUBLISHER` (the
pin), `POS_RELEASE_BUCKET`, `POS_RELEASE_URL_TTL_SECONDS`.

The resolver returns a release **only if every condition holds**, evaluated in one query, in this order:

1. **E1** the `stable` channel has a policy (`pos_version_policy` row exists);
2. **E2** a registry row exists with `version = recommended_version`;
3. **E3** that row has `approved = true`;
4. **E4** that row has `signing_class = 'production'`;
5. **E5** the pin is configured and non-empty, and the row's `publisher` equals it exactly;
6. **E6** `version >= min_supported_version` in semantic-version precedence;
7. **E7** that row has been **explicitly activated**: `activated_at IS NOT NULL` (§4.1, §8.3
   `platformActivatePosRelease`).

E7 closes the pre-selected case: a platform admin may set `recommended_version` to a version that is not yet
registered (§5.1). Without E7, registering that version later would make it downloadable with no second action.
Activation is a separate, release-specific platform-admin action on the registry row itself, audited as
`pos.release.activated`. It is serialized by construction: a row can only be activated after it exists, and the
activation names the row by id, so no clock or transaction-time ordering is involved. An unrelated policy edit
(for example only `minSupportedGraceUntil`) never activates anything. The download therefore needs three
deliberate acts, in any order between the last two: registration (promotion workflow), activation (platform
admin) and recommendation (platform admin, RT-327). *E7 and the activation action are proposals of this note,
for owner review. The alternative, that any effective policy change activates a pre-selected release, would
need explicit owner agreement and is not proposed.*

Otherwise the answer is `available: false` (§3.4), with the first failing condition as the metric `reason`
(E7: `none_not_activated`).

E4 and E6 are already implied by other rules (§6.2 makes E4 always true for a stored row; RT-327 keeps
`min <= recommended`). They stay in the predicate so that each rule holds on its own, and a later change to one
layer does not open the resolver.

**No fallback.** If the recommended version is not eligible, nothing else is offered: not `latest_version`, not
the newest approved row, not an older approved release. An older release could be below a minimum raised later,
or a release the owner chose not to recommend. Changing which release customers get is a policy change
(`platformSetPosVersionPolicy`), which is audited.

### 5.1 Outcome per rule (AC1)

| Case | Registry write (§8) | Resolver (§5) |
| --- | --- | --- |
| **Lab installer** (manifest `signing=lab`, or lab publisher) | Refused, 422 `release_not_production`, nothing written. A direct SQL insert fails the CHECKs (§6.2). | Cannot match: no lab row can exist (E4), and its publisher can never equal the production pin (E5). `available: false`. |
| **Unapproved release** (no row; or row withdrawn) | Without an approved promotion run the workflow never calls the write (§8); a call without the promotion credential is 401. A withdrawn row stays `approved = false` for good. | E2 or E3 fails: `available: false`. Recommending an unregistered version is not refused by the policy write (that would couple RT-327 to this table); the resolver returns nothing, and registering that version later still returns nothing until a platform admin activates that row (E7). |
| **Release below `min_supported_version`** | Accepted: the registry records what was shipped, not what is current. | Cannot be returned: only `recommended_version` is considered, the policy keeps `min <= recommended` (RT-327 422 `version_order_invalid`), and E6 checks it again. `available: false` if ever reached. |
| **Unauthenticated caller** | 401 on both write routes. | 401, no URL, no audit row (§3.2). |
| **Unauthorized caller** | A valid credential without the promotion claims (D-5a): 403 `forbidden`; a Console session of any user, including a platform admin: 401 (the write routes take no cookie). | 404 `not_found`, identical for a role outside the list and for no active membership; a session with no active tenant is 401; a platform admin without membership or a live support session is 403 `support_session_required` / `support_session_expired` (§3.2). |
| **Production pin not configured** (today: no production certificate, RT-321) | 503 `publisher_pin_unset`: nothing can be registered. | E5 fails: `available: false` for everyone. |

## 6. Lab versus production, by construction (D-4)

Owner decision D-4: the manifest gains `signing=production`, **and** the resolver also requires the production
publisher pin. The `pos/v*` tag pattern stays.

### 6.1 The manifest field

`release-manifest.json` gains a structured top-level field `signing` with values `lab` or `production`, set by the
signing job from the certificate it actually used, never from a workflow input. `release-pos.yml` writes
`"signing": "lab"` (it stays lab-only). The future production signing job (RT-321) writes `"production"`. This is
a `.github/release/manifest.py` change, `[GATED .github]`, in §10 S2.

### 6.2 Four independent layers

A lab build would have to pass **all** of these to reach a customer. Each one alone refuses it:

| Layer | Mechanism | What a lab build hits |
| --- | --- | --- |
| L1 Promotion workflow | Verifies the attestation and digests, reads `signing` from the attested manifest and the Authenticode subject from the installer itself; refuses `signing != production` or a subject that differs from the pin. | Refused before any write. |
| L2 Registry write API | Refuses `signingClass != production` and `publisher != POS_RELEASE_PRODUCTION_PUBLISHER` with 422 `release_not_production`; refuses everything with 503 while the pin is unset. | 422, nothing written. |
| L3 Database | `CHECK (signing_class = 'production')` and `CHECK (publisher NOT ILIKE '%NOT FOR PRODUCTION%' AND publisher NOT ILIKE '%LAB TEST%')` on `pos_release_registry`. | The INSERT fails, whoever runs it. |
| L4 Resolver predicate | E4 and E5 in the same `SELECT` as the version match. | No row selected; `available: false`. |

L3 and L4 are the "by construction" part: they do not depend on the workflow or the API being correct. L3 makes
a lab row unrepresentable in the table. L4 makes even a mis-stored row unreturnable unless it carries the exact
production subject, which a lab certificate cannot have (the lab subject is fixed by `lab-sign.cjs`, which
refuses any certificate without the lab marker). The L3 marker CHECK is only a backstop: L4 holds even for a
future lab subject without the marker, because the lab subject still differs from the production pin.

### 6.3 Required test (AC4)

A later implementation **must** carry this db-integration test, by this name, and keep it in the `api`
db-integration suite:

`apps/api/test/pos-releases/pos-release-registry.lab-never-resolvable.spec.ts`

It must prove, against a real Postgres with the migration applied:

1. A direct SQL `INSERT` of a row with `signing_class = 'lab'` fails with a CHECK violation (L3).
2. A direct SQL `INSERT` with `publisher = 'Kemetra POS LAB TEST - NOT FOR PRODUCTION'` and
   `signing_class = 'production'` fails with a CHECK violation (L3).
3. The register route refuses a lab manifest body with 422 `release_not_production` and writes no row and no
   audit row (L2).
4. With an approved production row whose `publisher` differs from the configured pin (inserted as the writer
   role with the pin changed afterwards), activated, and the `stable` policy recommending that version, the
   resolver returns
   `{ available: false }` and presigns nothing (L4, E5).
5. With the pin unset, the resolver returns `{ available: false }` for an otherwise eligible row (E5).
6. A control: an approved, activated production row with the pinned publisher at the recommended version
   returns `available: true` with that row's `sha256` and a URL naming its
   `artifact_version_id`, so cases 4 and 5 do not pass vacuously.

A unit test of the predicate alone does not satisfy AC4: case 1 and 2 need the real CHECKs.

### 6.4 Today

There is no production certificate (RT-321) and so no pin value. The resolver therefore returns
`available: false` to everyone, and the write API refuses every registration with 503. That is the intended
fail-closed state, not a defect.

## 7. Customer flow (for the later Console page)

1. A user with an allowed role opens Devices → Download POS. The page calls `consoleGetLatestPosRelease`.
2. `available: true`: the page shows the version, the size, the SHA-256 and "Publisher: `<expectedPublisher>`",
   and a Download button that opens `downloadUrl`. On a 403 from S3 (the URL expired) it calls the resolver again;
   it never stores the URL.
3. `available: false`: "No POS release is available yet. Contact Kemetra support."
4. The customer runs the installer; Windows shows the publisher; it must equal the page's `expectedPublisher`.

The page never builds a URL, never names a bucket and never calls S3 except through `downloadUrl`.

## 8. The registry writer (D-5) and RT-234 §10

### 8.1 Owner decision

D-5: an **owner-run GitHub promotion workflow behind an approval environment**. It verifies the attestation and
the digests, then writes the registry row. There is no Console action that writes the registry.

### 8.2 Alignment with RT-234 §10

RT-234 §10 sets four stages (`lab` → `canary` → `stable` with `stagingPercentage` → GA), says "Each promotion is a
deliberate, recorded action (manual workflow with approval). Nothing promotes automatically", and "A failed stage
stops promotion". D-5 is **the same mechanism applied to one more target**, and it aligns as follows:

| RT-234 §10 rule | How D-5 meets it |
| --- | --- |
| Promotion is a manual workflow with approval | The promotion workflow is `workflow_dispatch` only, in a protected environment with a required reviewer (the owner). |
| Each promotion is recorded | The row records `approved_by`, `approved_at` and `promotion_run_url`, and writes `pos.release.registered` (§4.2). |
| Nothing promotes automatically | Registering a release does not make it downloadable. It also needs a platform admin to activate that registry row (`pos.release.activated`, E7) and the `stable` `recommended_version` to name it (RT-327): separately audited actions, even when the version was recommended before it was registered. |
| A failed stage stops promotion | A release is registered for customer download only after it has passed the RT-234 §10 exit criteria for `stable`. The workflow cannot check those criteria itself (they are Sentry, sync and soak signals); the reviewer attests them by approving. *The exact gate (a checklist in the approval, or a link to the RT-234 §12 drill result) is open for S2.* |
| Withdrawal / halt (RT-234 §8) | `pos.release.withdrawn` sets `approved = false`; the resolver stops returning it at once. Recovery is a higher version (roll-forward, P-3). |

One difference to note: RT-234 §10 promotes by publishing channel files (`stable.yml`) to the update origin, for
installed terminals. This registry is for **new installs** only; it does not feed the updater. The two must name
the same artifact. S2 should therefore register the release and publish `stable.yml` from the same verified
artifact in one run, so the customer download and the update feed cannot drift. *Whether they are one workflow
or two is open for S2; RT-322 and RT-324 own the feed.*

### 8.3 Write operations (draft, Appendix A)

- `POST /api/v1/platform/pos-releases`, `platformRegisterPosRelease`. Body: `tag`, `version`, `sha256`,
  `sizeBytes`, `publisher`, `signingClass`, `attestationRef`, `sourceSha`, `approvedBy`, `approvedAt`,
  `promotionRunUrl`, `artifactVersionId`. `artifact_key` is derived on the server from the version. Requires `Idempotency-Key`
  (`x-idempotency: required`).
  - A body equal to an existing row (same `tag`, `version`, `sha256`, every field) is a 200 with that row and
    writes nothing (safe retry).
  - The same `tag`, `version`, `sha256` or object key with any other value is 409 `release_conflict`. A release is
    never overwritten.
  - 422 `release_not_production` (§6.2 L2); 422 `tag_version_mismatch` when `tag` is not `pos/v` + `version`;
    422 `approval_invalid` when `approvedAt` is in the future or more than
    24 h old; 503 `publisher_pin_unset`.
  - Backend-Core does **not** re-verify the attestation or download the object. That is the workflow's job (D-5).
    Backend-Core checks shape, the production rules and conflicts only. *Whether Backend-Core should also check
    that the object exists with that size (a `HeadObject`) is open for S1.*
- `POST /api/v1/platform/pos-releases/{releaseId}/withdraw`, `platformWithdrawPosRelease`. Body: `withdrawnBy`,
  `promotionRunUrl`. Idempotent: withdrawing a withdrawn row is a 200 that writes nothing.
- `POST /api/v1/platform/pos-releases/{releaseId}/activate`, `platformActivatePosRelease` (E7). **Not** the
  promotion workflow: the `cookieAuth` session of a platform admin with a trusted `Origin`, exactly as
  `platformSetPosVersionPolicy` (RT-327; 401 for any other credential, 403 `forbidden` / `origin_rejected`). No
  body. Sets `activated_at` / `activated_by_user_id` and writes `pos.release.activated`. Already activated: a 200
  that writes nothing. A withdrawn row: 409 `release_withdrawn`, nothing written. Absent id: 404. It does not
  depend on D-5a.

### 8.4 D-5a — the workflow's credential (**open, blocks the write routes**)

D-5 fixes *who* writes, not *how the workflow authenticates* to Backend-Core. Backend-Core has no machine
credential that fits (§2). Two options, for the owner:

- **(a) GitHub OIDC.** The workflow requests an `id_token` for audience `retail-tower-backend-core`; Backend-Core
  verifies it against GitHub's JWKS and requires `repository = Kemetra-Labs/Retail-Tower-Erp`,
  `environment = <promotion environment>`, `ref = refs/heads/main`, and the workflow path. No stored secret; a new
  trust anchor and a JWKS fetch from Backend-Core (new egress to `token.actions.githubusercontent.com`).
- **(b) A platform machine token** held as a secret of the promotion environment only, hashed in Backend-Core
  like the device tokens, scope `pos_release_writer`, rotated on a schedule. No new egress; a long-lived secret.

Until D-5a is decided, the two write routes stay `x-runtime-status: contract-only` and S2 cannot run. The draft
contract models the scheme as an HTTP bearer named `promotionWriter` and states only what both options share.
The resolver (§3) does not depend on D-5a.

## 9. Files a later implementation would touch

| Work | Files |
| --- | --- |
| Contract (`[GATED]`) | new `packages/contracts/openapi/pos-releases.openapi.yaml` (from Appendix A); `apps/api/test/console-rate-limit/classes/pos-releases.rate-limit.yaml`; a contract spec `apps/api/test/pos-releases/pos-releases.contract.spec.ts`; `changelog.d/RT-<n>-pos-releases-contract.md`. |
| Migration (`[GATED]`) | `packages/db/drizzle/00NN_pos_release_registry.sql` + `.down.sql` (table, enum, CHECKs, trigger, RLS); the Drizzle schema in `packages/db/src/`. |
| Runtime | `apps/api/src/pos-releases/` (module, console controller, platform controller, service, presigner port and S3 adapter, writer guard); `apps/api/src/app.module.ts`; config schema for `POS_RELEASE_*`; `apps/api/package.json` + `pnpm-lock.yaml` for `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (`[GATED]`). |
| Tests | `apps/api/test/pos-releases/pos-release-registry.lab-never-resolvable.spec.ts` (§6.3), resolver authz (the §3.2 matrix: 401 / 403 support session / 404 / 200, platform admin member and via support session), eligibility E1–E7 (including a version recommended before registration staying unavailable until the row is activated, and a grace-only policy edit not activating it), activation authz and replay, register idempotency and conflicts, withdraw, audit rows, presign TTL bound and no URL in logs. |
| Release tooling (`[GATED .github]`) | `.github/release/manifest.py` + `test_manifest.py` (structured `signing`); `release-pos.yml` writes `signing: lab`; new `.github/workflows/promote-pos.yml`. |
| Console | `apps/admin-console/src/` Devices → Download POS page and its API client; the Console contract PIN bump. |
| Infrastructure (owner) | Private S3 bucket (block public access, SSE, **versioning required**: the resolver presigns a `VersionId`; S3 Object Lock is optional defence in depth), a read-only IAM grant for the Backend-Core runtime on `pos/releases/*`, a write grant for the promotion workflow. |

## 10. Proposed implementation split (AC5)

Proposed only. No issue is created by this item (AC5).

| # | Slice | Product | Depends on | Existing owner issue |
| --- | --- | --- | --- | --- |
| S1 | Registry + resolver: contract (resolver served, write routes `contract-only`), migration, runtime, §6.3 test | Backend-Core | RT-1260 merged | **None found.** A new Implementation issue is needed. Title search (download, installer, registry, resolver, promotion, production signing) found only RT-1260, RT-1261 and RT-1082, none of which owns this. |
| S2 | Promotion workflow (D-5), structured manifest `signing` (D-4), the write routes' runtime | Repo-wide `.github` + Backend-Core | S1; **D-5a**; production signing (RT-321) to register a real row | Partly **RT-321** (production signing, `[GATED .github]`) and **RT-717** (independent product releases); the workflow itself has no owner. The owner decides whether it is a new issue or an RT-321 scope addition. |
| S3 | Console Devices → Download POS page (§7) | Admin-Console | S1 contract | **None found.** RT-1006 is the origin assessment, not an implementation owner. |
| S4 | S3 bucket and IAM (D-1) | Infrastructure (owner steps) | — | **RT-717** covers lab release infrastructure; the production bucket has no owner. |
| S5 | Entitlement check on the resolver | Backend-Core | RT-1001 | **RT-1001** (Planning). |

S1 and S3 can ship before production signing: the resolver then answers `available: false` (§6.4), and the page
shows its empty state. Nothing becomes downloadable until S2 and RT-321 are done and a platform admin recommends a
registered release.

## 11. Owner decisions (AC3)

| ID | Question | Owner answer | Source | Effect here |
| --- | --- | --- | --- | --- |
| D-1 | Artifact hosting | A private S3 bucket in the existing AWS account. The resolver returns a short-lived presigned URL; nothing is publicly listable. CloudFront may come later. | [c15843](https://rahmaqanater.atlassian.net/browse/RT-1260?focusedCommentId=15843) | §3.3, §4.1 `artifact_key`, S4. Decided. |
| D-2 | Pilot delivery | The V1 pilot uses a **controlled hand-off** of one approved build by Kemetra, not this page. **Which build** is the approved pilot package, and how it is signed, is **out of scope here**: it belongs to RT-1006 and RT-914. | [c15843](https://rahmaqanater.atlassian.net/browse/RT-1260?focusedCommentId=15843) | Nothing in this design serves the pilot. Recorded as out of scope. |
| D-3 | Download authentication | Any signed-in Console user whose role can pair devices for that tenant. No entitlement check until RT-1001. | [c15843](https://rahmaqanater.atlassian.net/browse/RT-1260?focusedCommentId=15843) | §3.2. Decided. |
| D-4 | Lab vs production | Manifest `signing=production` **and** the production publisher pin. `pos/v*` unchanged. | [c15843](https://rahmaqanater.atlassian.net/browse/RT-1260?focusedCommentId=15843) | §6. Decided. The pin's **value** waits on RT-321 (§6.4). |
| D-5 | Registry writer | Owner-run GitHub promotion workflow behind an approval environment; verifies attestation and digests, then writes the row. | [c15843](https://rahmaqanater.atlassian.net/browse/RT-1260?focusedCommentId=15843) | §8. Decided. Aligned with RT-234 §10 in §8.2. |
| D-5a | The workflow's credential to Backend-Core | **Open.** Options in §8.4. | — | **Blocks** the write routes' runtime and S2. Does not block the resolver or S1's contract and migration. |
| D-6 | Gate placement | **Pre-commercial (Post-Pilot).** Not a V1 pilot blocker. | [c15843](https://rahmaqanater.atlassian.net/browse/RT-1260?focusedCommentId=15843) | Release horizon of every slice in §10. |

Proposals of this note that are **not** owner decisions and stay open for review: the `stable`-only channel
(§3.1), the 300 s / 900 s URL lifetime (§3.3), the audit row per issued link (§3.6), the no-fallback rule (§5), the explicit release activation (E7, `platformActivatePosRelease`, §8.3),
whether S2 also publishes `stable.yml` (§8.2), the RT-234 exit-criteria gate in the approval (§8.2), and a
`HeadObject` check on register (§8.3).

## 12. Risks and what was not verified

- **No production publisher exists.** Everything customer-facing waits on RT-321, which has no commercial
  certificate purchase planned. The design is complete but inert until then (§6.4).
- **The audit actor for a machine principal** is not verified against `audit_events` (§4.2).
- **The resolver and the update feed could drift** if S2 does not publish both from one artifact (§8.2).
- **A presigned URL is a bearer capability** for its lifetime; anyone the customer forwards it to can download the
  installer in that window. The installer is not secret, so the risk is accepted by D-1's design; the audit row
  records who obtained each link.
- **Not verified:** any runtime behaviour, S3 presign behaviour, the GitHub attestation URL format used in the
  CHECK (taken from the GitHub UI form, to be confirmed in S2), and the RLS GUC name.
- **The draft OpenAPI** is validated only with `oasdiff validate` (§13); it was not run through the api Jest
  contract specs, which need the workspace installed.

## 13. Validation of the draft contract

The project's contract tooling is the pinned **oasdiff 1.32.1** (`bc/oasdiff`, `bc/contracts-compat`, and
`contracts/check` in the root workflows). There is no Redocly or Spectral configuration in the repository.

The appendix was extracted to a scratch file and checked with the same pinned, checksum-verified oasdiff:

```bash
awk '/^<!-- draft-openapi:begin -->$/{f=1;next} /^<!-- draft-openapi:end -->$/{f=0} f' \
  docs/planning/rt-1260-pos-release-registry.md | sed '1d;$d' > /tmp/pos-releases.draft.yaml
oasdiff validate /tmp/pos-releases.draft.yaml
```

Results on 2026-11-07 (oasdiff 1.32.1, archive sha256 `7c8939fc…a1ee7f` verified):

| Check | Result |
| --- | --- |
| `oasdiff validate` on the extracted draft | `No findings detected`, exit 0. |
| Negative control: a dangling `$ref` | Refused (`map key "DoesNotExist" not found`). |
| Negative control: an invalid security scheme `type` | Refused. |
| Negative control: a duplicate `operationId` | **Not detected** by `oasdiff validate`. Checked separately: the draft's four operationIds are unique within the draft and do not appear in any file under `packages/contracts/openapi/`; none of its paths exists there either. |
| `oasdiff breaking --composed --fail-on WARN` with the repo's `severity-levels.txt`, current contracts vs current contracts + the draft | `No breaking changes to report`, exit 0. |

Not run: the api Jest contract specs (they need the pnpm workspace installed; the container has Node 22 and the
workspace asks for Node ≥ 24). S1 adds the draft's contract spec there. The draft is not placed under
`packages/contracts/openapi/`, so `bc/oasdiff` does not see it.

## 14. Acceptance-criteria trace (RT-1260)

| AC | Where |
| --- | --- |
| 1. Note covers every in-scope item; outcome per rule for lab, unapproved, below-minimum, unauthenticated, unauthorized | Scope items 1–6: §3, Appendix A, §4, §5, §6, §9–§10. Outcomes: §5.1. |
| 2. Draft contract validates with the existing contract lint and follows `pos-device-health.openapi.yaml` | Appendix A (same auth schemes, error envelope, `x-audit-action`, `revision`-style conflict, `Cache-Control: no-store`, 429 shape); §13. |
| 3. Owner decision for each of D-1…D-6, or open and blocking | §11. D-5a is open and its blocked parts are named. |
| 4. Lab build not returnable by construction; named test | §6.2 (L3, L4); §6.3. |
| 5. Implementation split mapped to existing owner issues, none created | §10. |

---

## Appendix A — Draft OpenAPI (not a contract of record)

Draft for S1. It becomes `packages/contracts/openapi/pos-releases.openapi.yaml` only through S1's `[GATED]`
contract PR, which may change it.

<!-- draft-openapi:begin -->
```yaml
openapi: 3.1.0
info:
  title: Data-Pulse-2 — POS Release Registry and Latest-Release Resolver API
  version: "0.1.0-draft"
  description: >
    DRAFT (Jira RT-1260, Planning; design note
    `docs/planning/rt-1260-pos-release-registry.md`). Not a contract of
    record. Four operations, three principals:

      1. `consoleGetLatestPosRelease` — a signed-in Console user whose role
         can pair devices (owner, tenant_admin, store_manager; D-3) gets the
         one eligible `stable` release and a short-lived presigned download
         URL (D-1), or `available: false`.
      2. `platformRegisterPosRelease` / `platformWithdrawPosRelease` — the
         owner-run promotion workflow (D-5) writes and withdraws registry
         rows. Its credential is OPEN (D-5a); both stay contract-only until
         it is decided.
      3. `platformActivatePosRelease` — a platform admin explicitly
         activates one registered release (E7); registration alone never
         makes a release downloadable.


    **Eligibility.** A release is returned only if the `stable` channel has
    a version policy (RT-327), a registry row exists for its
    `recommended_version`, the row is approved, its signing class is
    `production`, its publisher equals the configured production publisher
    pin, its version is not below `min_supported_version`, and the row has
    been explicitly activated by a platform admin. Otherwise
    the reply is `available: false`, with no reason. There is no fallback
    to another version.


    **Lab builds.** A lab-signed release can never be registered (422, and
    database CHECKs) and can never be resolved (the publisher pin). Until a
    production publisher pin is configured, registration is 503 and the
    resolver answers `available: false`.


    **Audit (RT-135).** `pos.release.download_link_issued` (tenant-scoped)
    per issued link; `pos.release.registered` and `pos.release.withdrawn`
    (platform-scoped) per effective write, in the same transaction. No URL,
    key, token or email in any row.


    **Error envelope.** The canonical `{ error: { code, message, request_id } }`
    shape. Closed codes per operation are listed on each response.

servers:
  - url: https://api.example.com

tags:
  - name: pos-releases
    description: Console read of the latest approved production POS release (RT-1260).
  - name: pos-release-registry
    description: Promotion-workflow writes to the POS release registry (RT-1260, D-5).

paths:
  /api/v1/pos-releases/latest:
    get:
      summary: Get the latest approved production POS release and a short-lived download URL.
      operationId: consoleGetLatestPosRelease
      tags: [pos-releases]
      x-audit-action: pos.release.download_link_issued
      security:
        - cookieAuth: []
      description: >
        The `stable` channel's recommended release when it is eligible (see
        the info description), with a presigned S3 GET URL valid until
        `expiresAt` (at most 900 seconds). Otherwise `available: false`. The
        route takes no query parameter. A role outside owner, tenant_admin,
        store_manager, and no active membership, are the non-disclosing
        404; a session with no active tenant is 401 (`TenantContextGuard`). An issued link writes one
        `pos.release.download_link_issued` row; nothing else does.
      responses:
        "200":
          description: "The eligible release, or `available: false`."
          headers:
            Cache-Control:
              $ref: "#/components/headers/CacheControlNoStore"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/LatestPosRelease"
        "400":
          $ref: "#/components/responses/ReadValidationFailure"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/SupportSessionRefused"
        "404":
          $ref: "#/components/responses/NotFound"
        "429":
          $ref: "#/components/responses/TooManyRequests"
        "500":
          $ref: "#/components/responses/SystemFailure"

  /api/v1/platform/pos-releases:
    post:
      summary: Register an approved production POS release (promotion workflow only).
      operationId: platformRegisterPosRelease
      tags: [pos-release-registry]
      x-audit-action: pos.release.registered
      x-idempotency: required
      x-runtime-status: contract-only
      x-runtime-note: >
        Blocked on owner decision D-5a (the promotion workflow's credential).
      security:
        - promotionWriter: []
      description: >
        Writes one immutable registry row. The workflow has already verified
        the attestation and the digests (D-5); Backend-Core checks the shape,
        the production rules and conflicts. A body equal to an existing row
        is a 200 that writes nothing. The same tag, version, sha256 or object
        key with any other value is 409. A lab release is 422. With no
        production publisher pin configured, every request is 503.
      parameters:
        - $ref: "#/components/parameters/IdempotencyKey"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/PosReleaseRegistration"
      responses:
        "200":
          description: The row already existed with exactly these values; nothing was written.
          headers:
            Cache-Control:
              $ref: "#/components/headers/CacheControlNoStore"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PosRelease"
        "201":
          description: The row was written and `pos.release.registered` recorded.
          headers:
            Cache-Control:
              $ref: "#/components/headers/CacheControlNoStore"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PosRelease"
        "400":
          $ref: "#/components/responses/WriteValidationFailure"
        "401":
          $ref: "#/components/responses/WriterUnauthorized"
        "403":
          $ref: "#/components/responses/WriterForbidden"
        "409":
          $ref: "#/components/responses/ReleaseConflict"
        "422":
          $ref: "#/components/responses/ReleaseRefused"
        "500":
          $ref: "#/components/responses/SystemFailure"
        "503":
          $ref: "#/components/responses/PublisherPinUnset"

  /api/v1/platform/pos-releases/{releaseId}/withdraw:
    post:
      summary: Withdraw a registered POS release (promotion workflow only).
      operationId: platformWithdrawPosRelease
      tags: [pos-release-registry]
      x-audit-action: pos.release.withdrawn
      x-runtime-status: contract-only
      x-runtime-note: >
        Blocked on owner decision D-5a (the promotion workflow's credential).
      security:
        - promotionWriter: []
      description: >
        Sets `approved` to false for good; the resolver stops returning the
        release at once. A withdrawn release is never re-approved: a fix
        ships a higher version. Withdrawing a withdrawn release is a 200
        that writes nothing.
      parameters:
        - $ref: "#/components/parameters/ReleaseIdPath"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/PosReleaseWithdrawal"
      responses:
        "200":
          description: The release is withdrawn (now, or already).
          headers:
            Cache-Control:
              $ref: "#/components/headers/CacheControlNoStore"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PosRelease"
        "400":
          $ref: "#/components/responses/WriteValidationFailure"
        "401":
          $ref: "#/components/responses/WriterUnauthorized"
        "403":
          $ref: "#/components/responses/WriterForbidden"
        "404":
          $ref: "#/components/responses/ReleaseNotFound"
        "500":
          $ref: "#/components/responses/SystemFailure"

  /api/v1/platform/pos-releases/{releaseId}/activate:
    post:
      summary: Activate a registered POS release for customer download (platform admins only).
      operationId: platformActivatePosRelease
      tags: [pos-release-registry]
      x-audit-action: pos.release.activated
      security:
        - platformSession: []
      description: >
        The release-specific activation (E7). Registration alone never makes
        a release downloadable; it also needs this action and the `stable`
        `recommended_version` to name it. Sets `activatedAt` and
        `activatedByUserId` and writes `pos.release.activated`. Already
        activated: a 200 that writes nothing. A withdrawn release is 409
        `release_withdrawn`. No body.
      parameters:
        - $ref: "#/components/parameters/ReleaseIdPath"
      responses:
        "200":
          description: The release is activated (now, or already).
          headers:
            Cache-Control:
              $ref: "#/components/headers/CacheControlNoStore"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PosRelease"
        "400":
          $ref: "#/components/responses/WriteValidationFailure"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/PlatformWriteForbidden"
        "404":
          $ref: "#/components/responses/ReleaseNotFound"
        "409":
          $ref: "#/components/responses/ReleaseWithdrawn"
        "429":
          $ref: "#/components/responses/TooManyRequests"
        "500":
          $ref: "#/components/responses/SystemFailure"

components:
  securitySchemes:
    cookieAuth:
      type: apiKey
      in: cookie
      name: dp2_session
      description: >
        The human dashboard session cookie (httpOnly `dp2_session`), verified
        by `SessionOnlyAdminGuard` → `TenantContextGuard` → `RolesGuard` with
        `@Roles("owner", "tenant_admin", "store_manager")`, as the pairing-code
        routes (D-3). A platform admin passes the role check; without a
        membership it needs an RT-414 support session (403 otherwise). A machine bearer, a POS `device` token or an
        `operatorAuthorization` envelope is 401. 401 semantics are owned by
        028 (G10).
    platformSession:
      type: apiKey
      in: cookie
      name: dp2_session
      description: >
        The same `dp2_session` cookie, for a platform admin
        (`users.is_platform_admin`), as `platformSetPosVersionPolicy`
        (RT-327): platform-scope, no active tenant needed, a trusted `Origin`
        required (RT-430). Any other signed-in user is 403 `forbidden`.
    promotionWriter:
      type: http
      scheme: bearer
      description: >
        DRAFT, OPEN (D-5a). The credential of the owner-run promotion
        workflow, usable only from its protected approval environment: either
        a GitHub OIDC token (audience `retail-tower-backend-core`, repository,
        environment, ref and workflow claims pinned) or a hashed platform
        machine token held only by that environment. A Console session cookie
        is never accepted here.

  headers:
    CacheControlNoStore:
      description: >
        `no-store` on every 2xx: the body carries a presigned URL or registry
        state, so no shared or browser cache keeps it.
      schema:
        type: string
        const: no-store
    ConsoleRetryAfter:
      description: >
        Whole seconds the caller should wait before retrying, sent on every
        console 429 (RT-574 D5), 1 to 3600.
      required: true
      schema:
        type: integer
        minimum: 1
        maximum: 3600

  parameters:
    IdempotencyKey:
      name: Idempotency-Key
      in: header
      required: true
      description: >
        A client-chosen key per registration attempt; a retry of the same
        attempt reuses it.
      schema:
        type: string
        minLength: 16
        maxLength: 128
        pattern: '^[A-Za-z0-9._:-]+$'
    ReleaseIdPath:
      name: releaseId
      in: path
      required: true
      description: The registry row id.
      schema:
        type: string
        format: uuid

  schemas:
    AppVersion:
      type: string
      minLength: 5
      maxLength: 32
      pattern: '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
      description: >
        A semantic version without build metadata, at most 32 characters; the
        same schema as `AppVersion` in `pos-device-health.openapi.yaml`.
    Sha256Hex:
      type: string
      pattern: '^[0-9a-f]{64}$'
      description: A SHA-256 digest, 64 lower-case hexadecimal characters.
    Publisher:
      type: string
      minLength: 1
      maxLength: 200
      description: An Authenticode certificate subject (the publisher Windows shows).
    SigningClass:
      type: string
      enum: [lab, production]
      description: >
        The release manifest's structured `signing` field (D-4). Only
        `production` is ever accepted or stored; `lab` is listed so that a lab
        manifest is refused as 422 `release_not_production`, not as 400.
    GitHubLogin:
      type: string
      minLength: 1
      maxLength: 39
      pattern: '^[A-Za-z0-9](-?[A-Za-z0-9])*$'
      description: A GitHub login, never an email.
    S3VersionId:
      type: string
      minLength: 1
      maxLength: 1024
      description: >
        The S3 `VersionId` of the uploaded object whose sha256 and publisher
        the promotion workflow verified. Every presigned URL names it.
    PromotionRunUrl:
      type: string
      maxLength: 200
      pattern: '^https://github\.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/[0-9]+(/attempts/[0-9]+)?$'

    LatestPosRelease:
      description: >
        Either the eligible release with its download URL, or
        `available: false` with no other key and no reason.
      oneOf:
        - $ref: "#/components/schemas/PosReleaseDownload"
        - $ref: "#/components/schemas/PosReleaseUnavailable"
    PosReleaseDownload:
      type: object
      additionalProperties: false
      required: [available, version, sha256, sizeBytes, fileName, expectedPublisher, downloadUrl, expiresAt]
      properties:
        available:
          type: boolean
          const: true
        version:
          $ref: "#/components/schemas/AppVersion"
        sha256:
          $ref: "#/components/schemas/Sha256Hex"
        sizeBytes:
          type: integer
          minimum: 1
          maximum: 2147483648
        fileName:
          type: string
          maxLength: 80
          pattern: '^POS-Pulse-Setup-[0-9A-Za-z.-]{5,32}\.exe$'
          description: The name to save the installer under, derived from the version.
        expectedPublisher:
          $ref: "#/components/schemas/Publisher"
        downloadUrl:
          type: string
          format: uri
          maxLength: 4096
          description: >
            A presigned S3 GET URL (D-1). A bearer capability until
            `expiresAt`: never log, store or forward it.
        expiresAt:
          type: string
          format: date-time
          description: Server clock; at most 900 seconds after the response.
    PosReleaseUnavailable:
      type: object
      additionalProperties: false
      required: [available]
      properties:
        available:
          type: boolean
          const: false

    PosReleaseRegistration:
      type: object
      additionalProperties: false
      required:
        - tag
        - version
        - sha256
        - sizeBytes
        - publisher
        - signingClass
        - attestationRef
        - sourceSha
        - approvedBy
        - approvedAt
        - promotionRunUrl
        - artifactVersionId
      properties:
        tag:
          type: string
          maxLength: 37
          pattern: '^pos/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
          description: Must equal `pos/v` followed by `version` (422 otherwise).
        version:
          $ref: "#/components/schemas/AppVersion"
        sha256:
          $ref: "#/components/schemas/Sha256Hex"
        sizeBytes:
          type: integer
          minimum: 1
          maximum: 2147483648
        publisher:
          $ref: "#/components/schemas/Publisher"
        signingClass:
          $ref: "#/components/schemas/SigningClass"
        attestationRef:
          type: string
          maxLength: 200
          pattern: '^https://github\.com/Kemetra-Labs/Retail-Tower-Erp/attestations/[0-9]+$'
        sourceSha:
          type: string
          pattern: '^[0-9a-f]{40}$'
        approvedBy:
          $ref: "#/components/schemas/GitHubLogin"
        approvedAt:
          type: string
          format: date-time
          description: Not in the future and at most 24 hours old (422 `approval_invalid`).
        promotionRunUrl:
          $ref: "#/components/schemas/PromotionRunUrl"
        artifactVersionId:
          $ref: "#/components/schemas/S3VersionId"

    PosReleaseWithdrawal:
      type: object
      additionalProperties: false
      required: [withdrawnBy, promotionRunUrl]
      properties:
        withdrawnBy:
          $ref: "#/components/schemas/GitHubLogin"
        promotionRunUrl:
          $ref: "#/components/schemas/PromotionRunUrl"

    PosRelease:
      type: object
      additionalProperties: false
      required:
        - releaseId
        - tag
        - version
        - sha256
        - sizeBytes
        - publisher
        - signingClass
        - attestationRef
        - sourceSha
        - approved
        - approvedBy
        - approvedAt
        - promotionRunUrl
        - artifactVersionId
        - registeredAt
        - withdrawnAt
        - withdrawnBy
        - activatedAt
        - activatedByUserId
      description: One registry row, as the promotion workflow sees it. Never returned to the Console.
      properties:
        releaseId:
          type: string
          format: uuid
        tag:
          type: string
        version:
          $ref: "#/components/schemas/AppVersion"
        sha256:
          $ref: "#/components/schemas/Sha256Hex"
        sizeBytes:
          type: integer
          minimum: 1
        publisher:
          $ref: "#/components/schemas/Publisher"
        signingClass:
          type: string
          const: production
        attestationRef:
          type: string
        sourceSha:
          type: string
        approved:
          type: boolean
        approvedBy:
          $ref: "#/components/schemas/GitHubLogin"
        approvedAt:
          type: string
          format: date-time
        promotionRunUrl:
          $ref: "#/components/schemas/PromotionRunUrl"
        artifactVersionId:
          $ref: "#/components/schemas/S3VersionId"
        registeredAt:
          type: string
          format: date-time
        withdrawnAt:
          type: [string, "null"]
          format: date-time
        withdrawnBy:
          oneOf:
            - $ref: "#/components/schemas/GitHubLogin"
            - type: "null"
        activatedAt:
          type: [string, "null"]
          format: date-time
        activatedByUserId:
          type: [string, "null"]
          format: uuid

    Error:
      type: object
      required: [error]
      description: >
        Canonical error envelope. Out-of-scope refusals are non-disclosing
        (§II, §XII): they never name the cause.
      properties:
        error:
          type: object
          required: [code, message]
          properties:
            code:
              type: string
              description: Stable machine-readable error code.
            message:
              type: string
              description: Human-readable summary. No sensitive data, no cause enumeration.
            request_id:
              type: string
              format: uuid
              description: Server-side correlation id; the cause is recorded server-side.

  responses:
    ReadValidationFailure:
      description: >
        validation_error (400): any query parameter. Checked after the guards.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    WriteValidationFailure:
      description: >
        validation_error (400): a body that is not a JSON object, an unknown
        or missing key, a value outside its pattern or bound, a malformed
        path id, or a missing or malformed `Idempotency-Key`. Nothing is
        written.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    Unauthorized:
      description: >
        Unauthenticated (401): a missing or invalid session cookie, a session
        with no active tenant (`TenantContextGuard`), or a non-cookie
        credential. Non-disclosing. No URL is issued.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    NotFound:
      description: >
        not_found (404), non-disclosing: identical for a role outside
        `owner` / `tenant_admin` / `store_manager` and for no active
        membership in the active tenant. No URL is issued.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    SupportSessionRefused:
      description: >
        403 from the reused `TenantContextGuard` (RT-414): a platform admin
        with no live membership in the active tenant and no `active` support
        session for it. `error.code` one of `support_session_required`,
        `support_session_expired` (`support_session_read_only` applies only
        to unsafe methods, never to this GET). A platform admin who is a
        member, or who holds such a session, is admitted whatever the role.
        Every gate decision writes `platform.cross_tenant.accessed`. No URL
        is issued.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    WriterUnauthorized:
      description: >
        401 `unauthorized`: a missing, malformed, expired or unverifiable
        promotion credential, or any other credential (including a Console
        session cookie). Nothing is written.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    WriterForbidden:
      description: >
        403 `forbidden`: a verified credential whose claims or scope are not
        the promotion workflow's (D-5a). Nothing is written.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    ReleaseConflict:
      description: >
        release_conflict (409): the tag, version, sha256 or object key
        already belongs to a row with different values. A release is never
        overwritten. Nothing is written.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    ReleaseRefused:
      description: >
        422, `error.code` one of: `release_not_production` (`signingClass`
        is not `production`, or `publisher` is not the configured production
        publisher pin), `tag_version_mismatch` (`tag` is not `pos/v` +
        `version`), `approval_invalid` (`approvedAt` in the future or more
        than 24 hours old). Nothing is written and no audit row.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    ReleaseNotFound:
      description: >
        not_found (404): no registry row has this id.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    ReleaseWithdrawn:
      description: >
        release_withdrawn (409): the release was withdrawn and can never be
        activated again; ship a higher version. Nothing is written.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    PlatformWriteForbidden:
      description: >
        403, `error.code` one of: `forbidden` (a signed-in user who is not a
        platform admin) or `origin_rejected` (RT-430: the `Origin` header is
        missing, or is neither the API's own origin nor listed in
        `ALLOWED_ORIGINS`). Nothing is written.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    PublisherPinUnset:
      description: >
        publisher_pin_unset (503): no production publisher pin is configured,
        so no release can be registered. Nothing is written.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    SystemFailure:
      description: >
        system_failure (500): unexpected server error, including a presign
        failure; the cause is recorded server-side under `request_id`.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    TooManyRequests:
      description: >
        429 `rate_limited` (RT-574): the caller's per-user budget for this
        class of operation is spent. Non-disclosing message; `request_id`
        equals the `X-Request-Id` response header. Honour `Retry-After`.
      headers:
        Retry-After:
          $ref: "#/components/headers/ConsoleRetryAfter"
        Cache-Control:
          description: Always `no-store` on a 429.
          required: true
          schema:
            type: string
            enum: [no-store]
        X-Request-Id:
          description: The request id, equal to `error.request_id` in the body.
          required: true
          schema:
            type: string
            format: uuid
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
```
<!-- draft-openapi:end -->
