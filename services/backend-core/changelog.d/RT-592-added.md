### Added
- RT-592 `[GATED: migration, contract]`, owner decision 2026-11-21 (Jira RT-592 comments 18021 and 18028): shift opens
  that arrive more than 24 hours after `openedAt` on a policy that is not the store's effective policy at receipt are
  flagged `policy_revision_stale_at_receipt` (never refused, no limit on `openedAt`). `PolicyFlag` gains the value in
  `pos-shifts.openapi.yaml` 1.6.0-draft and `shift-closes.openapi.yaml` 1.3.0-draft; migration
  `0130_shift_policy_flag_stale_at_receipt` widens `shifts_frozen_policy_flags_valid`. The POS and Admin-Console
  generated clients are repinned in this PR (owner decision, RT-592 comment 18031); a later PR repins both to the merge
  commit.
