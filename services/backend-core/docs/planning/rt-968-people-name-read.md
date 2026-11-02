# RT-968 — Tenant-scoped people-name read: decision record and draft contract

> **Status:** decision record + `[GATED]` draft contract (Work Mode: **Planning**, contract-first, Post-Pilot).
> **Jira holds the live status.** This file records the 2026-11-02 planning pass and is not a status tracker.
>
> **Authority.** The owner delegated decisions on 2026-11-02 to the captain session: take the recommended
> option wherever one exists. Decision D-1 is the RT-964 recommendation. Decisions D-2 to D-4 have no
> recommendation in the issue, so each takes the most privacy-conservative option that fits the existing
> contracts. They are marked **conservative default; owner may revisit**. No choice here discloses more
> than RT-968 option A describes.
>
> **Deliverables:** the draft contract `packages/contracts/openapi/console-people.openapi.yaml`
> (`1.0.0-draft`, `x-runtime-status: contract-only`) and its rate-limit class file
> `apps/api/test/console-rate-limit/classes/console-people.rate-limit.yaml`. The PR has no controller,
> service, migration, package, CI or Console change.
>
> **Sources:** Jira RT-968 (this item), RT-964 comment 14530 (origin plan), RT-967 (the Console item, which
> ships with an id fallback). `Kemetra-Labs/Retail-Tower-Erp` `origin/main` **`a43ad962`**, read-only
> inspection. Paths are relative to `services/backend-core/`.

---

## 1. The need

RT-964 found two gaps that the Console cannot close on the current contracts:

* **A store manager sees only UUIDs.** This covers who opened, closed and recorded a shift close, its
  approver, and who revoked or retired a device. The store manager is the main reviewer of cash
  variance, but `listMembers` is limited to owner and tenant_admin.
* **Every role sees UUIDs for staff who have left.** This affects audit, closes and device history.
  `listMembers` leaves out revoked memberships and deleted users. This is the forensic case, where
  names matter most.

## 2. Verified current state on `origin/main` (`a43ad962`)

| Fact | Evidence |
| --- | --- |
| `listMembers` (`GET /api/v1/tenants/{tenant_id}/members`) returns `user.{id, email, display_name}`, role and grants. It is limited to owner and tenant_admin and is rate-limited `cheapRead`. It is not audited (no `x-audit-action`). | `packages/contracts/openapi/tenants.openapi.yaml:124-145`, `:174-190`; `apps/api/src/tenants/tenants.controller.ts:187-188`; `apps/api/test/console-rate-limit/classes/tenants.rate-limit.yaml` |
| The members list filters out revoked memberships, soft-deleted memberships and soft-deleted users. | `apps/api/src/context/membership.repository.ts:522-548` |
| `users` has a nullable `display_name` and a nullable `deleted_at`. It has no RLS; access is gated in the application. | `packages/db/src/schema/users.ts:1-31` |
| `memberships` has both `revoked_at` and `deleted_at`. Revoke sets only `revoked_at` and **keeps the `store_access` rows**. Only a membership edit that changes the store-access kind replaces them. | `packages/db/src/schema/memberships.ts`; `apps/api/src/memberships/memberships.repository.ts:40-58`, `:170-190` |
| Shift closes and device history admit `store_manager` and say "user references are `users.id` values only; no name, e-mail…". | `packages/contracts/openapi/shift-closes.openapi.yaml:36-49`, `:88-96`; `packages/contracts/openapi/devices.openapi.yaml:434-436` |
| The operator-surface store scope: owner and tenant_admin get their membership's store authority and are never narrowed by the active store. store_manager gets the standard resolved scope, including active-store narrowing. | `apps/api/src/context/operator-store-scope.ts:19-36` |
| Read audit actions are classified in a code registry, and a drift guard checks it against live `GET` `@Auditable` routes. A contract-only operation adds its code when its runtime ships. | `apps/api/src/audit/audit-action-kinds.ts`; RT-1008 / RT-1053 precedent (`console_sales.by_store_read`) |
| Contract-only operations are registered only by `x-runtime-status: contract-only` and `x-runtime-note`. Each cookieAuth operation needs an entry in its contract's rate-limit class file and a documented console 429. | `apps/api/test/openapi/runtime-route-conformance.spec.ts:42-50`; `apps/api/test/console-rate-limit/console-rate-limit.ratchet.spec.ts:1-24`; `…/console-rate-limit.contract-sweep.spec.ts:1-11` |

## 3. Decisions

### D-1 — Option A: one people-name read

**Selected:** option A, under the owner's delegation of 2026-11-02 (captain session). This is the
recommended option (RT-964 c14530, RT-968).

`listPeopleNames`: `GET /api/v1/console/people?ids=<uuid,…>`, with 1 to 200 ids. The response is
`{ items: [{ user_id, display_name: string|null }] }`.

**Why.** Under option A, the shift-close, device and audit contracts keep their "`users.id` only" PII
statements. Names are disclosed in one place, under one authorization rule, one audit action and one
rate limit.

Option B would put `*_display_name` fields on each surface. It would reverse that PII statement three
times and repeat the authorization logic in three services. **Option B is rejected.**

### D-2 — What a store manager can see

**Selected:** store-scoped, under the delegation as the conservative default. The owner may revisit this.

| Caller | Resolves |
| --- | --- |
| owner, tenant_admin | Every person of the tenant. They already list current members, and this read adds only former staff, so they see nothing new. |
| store_manager | Only a person whose membership grants at least one store of the caller's operator-surface store scope. That is a membership with `store_access_kind = all`, or a `specific` membership with a `store_access` row for a store in the scope. The scope includes active-store narrowing, like the shift-close and device reads. |

**Why.**

* This is the minimum disclosure that still closes the gap. Everyone who acts on a store manager's
  closes and devices holds a grant on that store. Owners and tenant admins with an `all` grant also
  count.
* It follows the store-scope rule that the same role already gets on those surfaces.
* The alternative, every tenant member, would show a store manager the names of staff at stores they
  cannot see at all.
* **Empty scope (RT-1063, captain decision 2026-11-02 under the owner's delegation).** A store manager
  whose resolved scope holds no store resolves nobody, members with an `all` grant included: an `all`
  grant cannot grant "a store of the caller's scope" when that scope is empty. This is fail-closed and
  the least disclosure.

**Known limit.** Suppose a person's grant on the store was later removed by a membership edit (the
edit replaces `store_access`). That person no longer resolves for the store manager, and the Console
shows the id. RT-967's id fallback already covers this, so no history table is added.

### D-3 — Revoked and deleted users

**Selected:** revoked memberships resolve, and deleted users are present without a name. This was
chosen under the delegation as the conservative default. The owner may revisit it.

* A **person of the tenant** has a `memberships` row in the session tenant with `deleted_at` null,
  revoked or not.
* A **revoked membership** resolves to its `display_name`. Option A requires this, because it is the
  forensic case.
* A **soft-deleted user** (`users.deleted_at` set) is present with `display_name: null`. The Console
  then knows the id was a person of the tenant, but a deleted user's name is not disclosed. That
  respects the deletion, as §XIV data minimisation requires.
* A **soft-deleted membership row** (`memberships.deleted_at` set) does not count, so the id is absent.
* A **null or blank `display_name`** returns null. The server never substitutes the e-mail or another
  value.

### D-4 — Rate-limit class and audit

**Selected:** `cheapRead`, and the read is audited as a `read` kind. This was chosen under the
delegation as the conservative default. The owner may revisit it.

* **Rate limit: `cheapRead`.** This is the class of `listMembers`, the comparable people read. The
  read is one indexed lookup, bounded at 200 ids. The ids are random UUIDs, so a tighter class would
  add no protection against enumeration. It would only throttle a Console screen that resolves a page
  of history.
* **Audit: yes, one `people.names_read` event per authorized request that returns 200, whatever the number of ids.**
  * The metadata holds only `requested_count` and `resolved_count`, never ids or names.
  * Refusals are not audited.
  * The action joins the read registry (`audit-action-kinds.ts`) when the runtime ships.
  * This is the most conservative choice. `listMembers` is not audited, but this read can reveal
    former staff, and the comparable console reads (`shift_closes.read`, `devices.read`) are audited.

## 4. Contract summary

The full text is in `packages/contracts/openapi/console-people.openapi.yaml`.

| Aspect | Contract |
| --- | --- |
| Operation | `GET /api/v1/console/people`, `listPeopleNames`, `x-runtime-status: contract-only`, `x-audit-action: people.names_read` |
| Auth | `cookieAuth` (`dp2_session`) only, through `SessionOnlyAdminGuard` → `TenantContextGuard` → `RolesGuard`. The tenant comes from the session, and the request has no tenant parameter. |
| Roles | owner, tenant_admin, store_manager. Any other role gets a non-disclosing 404 for any input. |
| Parameter | `ids`, comma-separated (`style: form, explode: false`), 1 to 200 canonical UUIDs. The raw value is at most 7,399 characters. Count and length are checked before any element is parsed (RT-1051). Repeated ids are answered once. |
| 200 | `{ items: [{ user_id, display_name }] }`, by `user_id` ascending. `additionalProperties: false`. Sent with `Cache-Control: no-store`. |
| Absent | Unknown ids, another tenant's users, soft-deleted memberships, and people outside a store manager's scope. Absence never says which of these applies. |
| Errors | 400 `validation_error`, 401, 404, 429 `rate_limited` (with `Retry-After`, `Cache-Control: no-store` and `X-Request-Id`), 500. All use the canonical `{ error: { code, message, request_id } }` envelope. |
| PII | Display names only. No e-mail, role, membership id, store grants, revoked or deleted state, or platform-admin flag. |

## 5. Follow-up implementation items (proposed; not created here)

1. **Backend-Core — `listPeopleNames` runtime** (Implementation, parent RT-5, relates RT-968).
   * Controller, service and one query, run under `runWithTenantContext` so membership RLS applies.
   * The D-2 store filter for store managers is built on `callerStoreScope`.
   * Bounded parsing of `ids`.
   * The audit interceptor, plus a `people.names_read` entry in `audit-action-kinds.ts`.
   * Tests:
     * contract tests;
     * isolation (cross-tenant ids absent, store-manager scope);
     * revoked and deleted cases;
     * 400 bounds;
     * 404 roles.
   * It removes only the `x-runtime-status` and `x-runtime-note` markers. No migration is expected:
     the existing indexes on `memberships(tenant_id, user_id)` and `store_access` serve the lookup.
     The runtime item confirms this.
2. **Admin-Console — people-name consumer** (Implementation, parent RT-5, relates RT-967).
   * A shared people directory over `listPeopleNames`. It is keyed by tenant and batches the ids on a
     screen (≤ 200 per call).
   * It replaces the RT-967 id fallback for store managers and former staff on:
     * audit;
     * the shift-close opened, closed and recorded by fields and the approver;
     * device revoked and retired by.
   * The name sits beside the id, never in place of it. Lookups never raise an error banner.
   * It is regenerated from the contract once the runtime is on `main`.

## 6. Out of scope

* The server implementation.
* Migrations.
* The Console consumer.
* Any change to `listMembers`, `shift-closes`, `devices` or `audit` contracts.
