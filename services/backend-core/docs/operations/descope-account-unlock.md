# Unlock a locked Descope account (RT-1263)

Manager and admin passwords live in Descope (project `telling-ochre-bose`). Descope
locks an account after repeated wrong passwords. Anyone who knows a loginId can do
this on purpose: the project id is public and Descope's password sign-in API accepts
it as the bearer, so the attempts never pass through Backend-Core (RT-943 item 1,
auth review F-002).

Never print, paste or commit a password or the Management key. Do every write below
from the Descope console or with the key held only on the operator's machine.

## The settings (read 2026-11-07, project default)

| Setting | Value | Effect |
| --- | --- | --- |
| Temporary lock | after 3 failed attempts, for 5 minutes | the user cannot sign in until it expires |
| Hard lock | after 5 failed attempts | Descope disables the user until an admin activates it |

Read with the Descope MCP `GetPasswordSettings` (RT-943 comment 15850). A tenant can
override these; re-read them if a tenant policy is ever set.

Backend-Core has its own limits for Admin sign-in (`apps/api/src/auth/rate-limit.ts`):
failed attempts per email and client IP (5) and per email (20), each per 15 minutes,
and every attempt per client IP (30 per hour, all users together). The two
failure limits are looser than Descope's, so for a Descope-linked user the Descope
lock comes first. The per-IP limit is not: a busy shared address, such as a store
network, can reach it without any account being locked.

## 1. Tell a lock from a wrong password

POS and Admin show the same generic refusal for a lock and a wrong password: they
never say "locked".

- **Backend-Core limit first (Admin only).** A `429 Too Many Requests` with a
  `Retry-After` header is a Backend-Core limit, not a Descope lock and not a wrong
  password: wait for `Retry-After` seconds. A `503` with `Retry-After` means the
  limiter itself is unavailable. Neither needs a Descope action.
- **Descope console → Users:** a hard-locked user shows as disabled. The user record
  returned by the Management API carries `lockReason` (disabled by brute-force
  protection) and, while a temporary lock lasts, `tempLockExpiration`. To list
  locked users, search with the `lockReasons` or `tempLockReasons` filters
  ([Search Users](https://docs.descope.com/api/management/users/search-users)).
- **Descope audit:** look for `UserTemporaryPasswordLock` (a temporary lock) and the
  failed password sign-ins before it, with their source IPs.

If the user is neither limited, disabled nor temporarily locked, rule out the
Backend-Core side before calling it a wrong password. The same generic refusal also
covers a Backend-Core user that is missing or deleted, a user with no ACTIVE
`descope` identity link, and a Descope token whose subject is not the one on the
link:

- **POS:** Backend-Core logs the cause, keyed by request id, as
  `pos-operator sign-in refused` with a `refusal` field (for example
  `identity_token_invalid`, `user_unmapped`, `membership_missing`, `device_invalid`).
- **Admin:** sign-in logs no cause. Check that the user exists, is not deleted, and
  has an ACTIVE `descope` link whose subject is the Descope user id.

Even then a wrong password is the likely cause, not a certain one: a Descope token
that fails Backend-Core's verification (signature, issuer, audience, expiry or age
cap, for example after a configuration change or while the Descope key set cannot be
fetched) gives the same refusal. On POS it shows as `identity_token_invalid`; Admin
logs nothing, so if several Descope-linked users fail at once, check the API's
`DESCOPE_*` settings and its reach to `api.descope.com` before resetting anyone's
password. A user who knows the current password can change it from Admin. A user
who has forgotten it cannot recover it through Backend-Core yet: the legacy reset
does nothing for a Descope-linked user (RT-1262), and provider-backed recovery is
RT-937 item 3. Until then a Descope admin sets a new password (step 3, "Set a new
password").

## 2. Clear the lock

**Temporary lock:** wait for `tempLockExpiration` (5 minutes). Do not change anything.
If it locks again straight away, someone is still sending attempts: go to step 3
before unlocking.

**Hard lock (owner or a Descope console admin):**

1. Confirm the user was disabled by brute-force protection (`lockReason` set), not
   by an admin on purpose (offboarding). Never re-enable a deliberately disabled user.
2. Activate the user:
   - console: **Users → the user → Modify user status → Activate**
     ([User management](https://docs.descope.com/management/user-management)); or
   - Management API: `POST https://api.descope.com/v1/mgmt/user/update/status` with
     `{"loginId": "<login id>", "status": "enabled"}`
     ([Update User Status](https://docs.descope.com/api/management/users/update-user-status)).
     Authorize it with `Authorization: Bearer <project id>:<management key>`, the
     same form Backend-Core uses (`apps/api/src/auth/descope-auth.client.ts`). Keep
     the key on the operator's machine; never paste it into chat or a ticket.
3. Ask the user to sign in once on POS or Admin and confirm it works.

**Not verified:** whether a Descope password reset or a new password clears a lock
on its own. Do not rely on it; activate the user as above. Backend-Core's legacy
password reset does nothing for a Descope-linked user (RT-1262).

A Backend-Core Admin limit (section above) is separate: it clears when its window
ends (15 minutes for the failure limits, one hour for the per-IP limit). It does
not disable anything in Descope.

## 3. After the unlock

- Read the Descope audit for the failed attempts: how many, from which IPs, over what
  time. Attempts from an address the store does not use mean the account is being
  targeted.
- If it was targeted, or the user may have shared the password, set a new password
  and tell the owner.

**Set a new password.** The best path is the user changing it from Admin while they
know the current one: Backend-Core then also revokes the user's other Admin
sessions (RT-937 D-C). Otherwise a Descope admin sets it in the console, or with the
Management API `POST https://api.descope.com/v1/mgmt/user/password/set/active` with
`{"loginId": "<login id>", "password": "<new password>"}` and the bearer above (the
call Backend-Core's invite flow uses). Give the password to the user out of band,
and have them change it from Admin at their next sign-in.

**End the old sessions.** A password set in the Descope console or through the
Management API does not end sessions Backend-Core already issued: an Admin session
lives until its 24-hour absolute expiry, and a POS operator token until its age cap
(8.5 hours by default). If someone else may have signed in:

Do step 1 first. The password change lives on the Admin account page, which a user
with no active membership cannot reach (Admin shows its no-access screen), so a
revocation done first blocks step 1.

1. **Contain (works for the last owner too).** A Descope admin sets a new password
   (above). The user, or the owner with the user present, signs in with it and
   changes the password once on the Admin account page. That change revokes every
   other Admin session of the user (RT-937 D-C). Backend-Core has no other route that
   ends another user's Admin sessions.

   Step 1 does **not** end POS access. POS operator routes verify the Descope session
   JWT locally, so a JWT someone already holds stays usable until its `exp` (8-hour
   session TTL) or the age cap (`DESCOPE_JWT_MAX_TOKEN_AGE_SECONDS`, default 8.5
   hours), whichever comes first, while the user's membership is active. To cut that
   sooner, use step 2. For the last owner, who cannot be revoked, POS exposure ends
   only when that window has passed.
2. **Cut tenant access, only if step 1 cannot happen soon, or to end POS access
   at once.** The user's membership is revoked (`DELETE /api/v1/memberships/<id>`)
   by an owner or a tenant admin; an owner's membership only by another owner or a
   platform admin (a tenant admin gets 403). A membership covers one tenant only: a
   user who belongs to several tenants keeps access, on POS and Admin, in every
   tenant where a membership is still active. Revoke the membership in each tenant
   the user belongs to. Do not rely on the tenant list the user's Admin sign-in
   shows: it lists active tenants only, so a membership in a suspended or pending
   tenant is missing from it, and it comes back into force if that tenant is
   reactivated. Have a platform admin list every unrevoked membership of the user
   across all tenant statuses (a read-only query is enough), revoke each one, and
   keep a suspended tenant suspended until its membership is revoked.

   A suspended (or pending) tenant is already contained while it stays that way: a
   membership there reads exactly like a revoked one, so the user has no access to
   it (RT-669). The membership often cannot be revoked there, though: a platform
   admin's support session is read-only in a suspended tenant, and the DELETE needs
   an owner, a tenant admin or a platform admin who can write in that tenant. In
   that case record the membership on the incident and do not reactivate the tenant
   until step 1 is done and the step 3 wait has passed; then revoke the membership
   right after reactivation if it is still needed. If the tenant must be reactivated
   sooner, escalate to the owner first.
   An open Admin session stays valid, but every tenant-scoped request is refused,
   because `TenantContextGuard` checks for an active membership on each request
   (FR-CTX-2). POS operator routes check it on every call too (RT-943 item 2).
   Limits:
   - the last active owner of a tenant cannot be revoked
     (`memberships/membership-hierarchy.ts`, "A tenant must keep at least one active
     owner"): use step 1;
   - a platform admin is not bound by tenant membership: use step 1;
   - the session can still reach routes that are not tenant-scoped (for example its
     own sign-out) until it expires.
3. **If step 2 already happened:** set the new password (above), then wait before
   restoring any membership, counted from the password set:
   - POS: the full configured age cap (`DESCOPE_JWT_MAX_TOKEN_AGE_SECONDS`, default
     8.5 hours) plus a few minutes, because the verifier allows 5 seconds of clock
     tolerance on `exp` and on the age cap and server clocks can drift;
   - Admin: the 24-hour absolute session expiry plus a few minutes, because an old
     Admin session regains tenant access as soon as a membership is restored, before
     the user has changed the password.

   So wait at least 24 hours plus a margin. Only then are the old POS tokens and
   Admin sessions unusable. Then re-invite the user so they hold a membership
   again, and have them change the password on the
   account page at their first sign-in (step 1). The other sessions stay valid until
   that change, or until their 24-hour expiry.

**Needs verification:** a platform admin with no membership and no support session
is sent to the platform area, not the account page, so step 1 may not be reachable
for them from the UI. Confirm on the lab before relying on it, and escalate to the
owner in that case.

Not observed on a live system: these steps follow from the code at the time of
writing. An open session after a membership revocation and after an Admin password
change has not yet been checked on the lab.
- Record the event (date, account, cause, action) on the pilot's incident log or the
  relevant Jira issue. Do not include the password or any key.

## 4. Pilot risk

The pilot has one manager-eligible account. While it is hard-locked, no manager can
sign in on POS until an admin activates it, and anyone who knows the loginId can lock
it again with 5 attempts.

These owner decisions are outside this runbook (RT-1263):

- keep or drop the hard lock for admin and manager accounts;
- add a second manager-eligible pilot account (created in the Descope console; RT-793
  owns the operator accounts).
