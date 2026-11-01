### Security
- RT-1028 (RT-132 D1–D5a, RT-447 F03): membership changes now follow the
  tenant role hierarchy (owner > tenant_admin > store_manager > store_staff).
  On `PATCH` and `DELETE /api/v1/memberships/{id}` and `POST
  /api/v1/memberships/invite`, a tenant_admin can no longer invite, promote,
  change or revoke an owner; no member can change its own role or store access
  (self-revoke stays allowed); revoking or demoting a tenant's last active
  owner is refused, even by that owner or a platform admin; and an owner grant
  must be for all stores. Each refusal is a 403 `forbidden` and writes one
  `membership.change_refused` audit row. The last-owner check locks the
  tenant's owner rows, so two owners revoking themselves at once leave one.
  No contract or migration change.
