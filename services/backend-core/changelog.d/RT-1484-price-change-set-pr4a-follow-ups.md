### Fixed
- RT-1484 PR-4a follow-ups (comment 17881): a Change Set list cursor naming an impossible date
  (`02-31`) is 400, not 500; editing or cancelling a `legacy_import` set is `409
  change_set_invalid_state`, not 500; audit metadata carries `reason_present` and `kind`, never
  the reason (spec 042 §10 amended); selector ids are matched in any case; the
  `price-inquiry.yaml` `zoneMembership: ambiguous` description says when it is `conflict` and
  when `none`.
