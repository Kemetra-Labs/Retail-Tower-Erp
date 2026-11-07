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

Backend-Core has its own failure limits for Admin sign-in (5 per email and client IP,
20 per email, each per 15 minutes; `apps/api/src/auth/rate-limit.ts`). They are
looser than Descope's, so for a Descope-linked user the Descope lock comes first.

## 1. Tell a lock from a wrong password

POS and Admin show the same generic refusal for both: they never say "locked".

- **Descope console → Users:** a hard-locked user shows as disabled. The Management
  user record carries `lockReason` (disabled by brute-force protection) or, for a
  temporary lock, `tempLockReasons` and `tempLockExpiration`
  ([Search Users](https://docs.descope.com/api/management/users/search-users)).
- **Descope audit:** look for `UserTemporaryPasswordLock` (a temporary lock) and the
  failed password sign-ins before it, with their source IPs.

If the user is neither disabled nor temporarily locked, it is a wrong password: use
the normal password change or reset path, not this runbook.

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
     ([Update User Status](https://docs.descope.com/api/management/users/update-user-status)),
     authorized with the Management key, never pasted into chat or a ticket.
3. Ask the user to sign in once on POS or Admin and confirm it works.

**Not verified:** whether a Descope password reset or a new password clears a lock
on its own. Do not rely on it; activate the user as above. Backend-Core's legacy
password reset does nothing for a Descope-linked user (RT-1262).

A Backend-Core Admin limit (section above) is separate: it clears when its 15-minute
window ends. It does not disable anything in Descope.

## 3. After the unlock

- Read the Descope audit for the failed attempts: how many, from which IPs, over what
  time. Attempts from an address the store does not use mean the account is being
  targeted.
- If it was targeted, or the user may have shared the password, set a new password
  (console, or ask the user to change it from Admin) and tell the owner.
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
