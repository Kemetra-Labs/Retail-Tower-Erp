### Changed
- RT-797 (provider-neutral identity 2/5; no OpenAPI, migration, dependency or
  deploy change): the operator cutover CLI is provider-neutral and flips
  identity links only. `packages/db/src/cli/descope-cutover.ts` is now
  `identity-link-cutover.ts`: `apply --user --from --to --subject --issuer` and
  `rollback --user --from --to`, each with `--dry-run`, strict arguments,
  counts-only output and one transaction. It never reads or writes
  `users.clerk_user_id` and never deletes a link row. A transaction advisory
  lock on the claimed (provider, subject) serializes concurrent claims across
  this CLI and the pilot bootstrap. The issuer is an explicit
  `--issuer` (no provider env derivation). Refusal codes are neutral
  (`no_active_source_link`, `inconsistent_target_state`,
  `target_subject_linked_to_other_user`, `no_active_target_link`,
  `no_disabled_source_link`, `source_subject_linked_to_other_user`;
  `user_not_found` and `unexpected_active_link` are unchanged). Retired:
  `subject_held_by_other_user` and the repair of a user with a bridge column but
  no link row (that user is now refused as `no_active_source_link`, the RT-796
  deploy precondition). `bootstrap-pilot.ts` takes `OPERATOR_PROVIDER_KEY`,
  `OPERATOR_PROVIDER_ISSUER` and `OPERATOR_PROVIDER_SUBJECT` instead of
  `CLERK_OPERATOR_SUBJECT`, and seeds the operator's active identity link
  alongside the bridge column (kept until RT-799); its output reports
  `operator_link_active: false` (and warns) when the operator already signs in
  through another link, which the seed never flips.
