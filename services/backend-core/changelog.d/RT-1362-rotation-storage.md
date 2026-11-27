### Added
- RT-1362 S2 (PR-A) `[GATED: migration]`, owner authorization on RT-1362 comments 19102 and 19107: the storage of
  overlap credential rotation. Migration 0136 adds the pending marker `auth_tokens.pending_rotation_request_id`
  (composite FK to the rotation request of the same tenant), the routed host label and trigger of a
  `credential.rotate` request, at most one open `credential.rotate` request per registration (partial unique index),
  and the provisioner host binding of an adopted registration (label, `provisional` or `confirmed`, revision).
  Migrations 0137 to 0139 replace the one-unrevoked-credential index with at most one current plus at most one
  pending connector credential per registration, built and dropped CONCURRENTLY. No behaviour changes: nothing
  creates a `credential.rotate` request or a pending credential yet.
