### Security
- RT-1028 (owner decision 2026-11-01, "Accept-time check"): `POST
  /api/v1/invitations/accept` now re-checks the stored invitation against the
  tenant role hierarchy, with the inviter as it is today as the actor. An owner
  invitation made by a tenant_admin, or one with 'specific' store access (both
  possible before RT-1028), can no longer be accepted. An invitation is also
  refused when its inviter has since been revoked or demoted below
  tenant_admin, or its tenant is no longer active; this applies to every role,
  not only owner. A platform-admin inviter skips the actor check but an owner
  grant must still be for all stores. A refusal is the existing opaque 400
  invalid-token response, writes nothing but one `membership.change_refused`
  audit row (`operation: "invitation.accept"`, the invitation as target, no
  email), and for a new invitee happens before any identity-provider call. No
  contract or migration change.
