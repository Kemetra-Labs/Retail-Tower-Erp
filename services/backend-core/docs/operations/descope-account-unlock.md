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

If the user is neither limited, disabled nor temporarily locked, it is a wrong
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

- have the user change the password from Admin once (revokes their other Admin
  sessions);
- for POS, and for an account the user cannot reach, revoke the user's membership
  (owner or tenant admin, `DELETE /api/v1/memberships/<id>`). POS operator routes
  look up the membership on every call (RT-943 item 2). **Needs verification:**
  whether a membership revocation also ends an open Admin session.
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
