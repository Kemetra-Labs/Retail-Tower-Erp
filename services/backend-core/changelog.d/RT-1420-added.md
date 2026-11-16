### Added
- RT-1420 `[GATED: migration, contract]`, owner delegation in chat 2026-11-16: the
  Count Session domain behind the RT-1419 contract, dark by default. Migration
  0114 adds the session, line, expected-at-cut, observation and late-event
  finding tables (FORCE RLS) and the per-tenant `count_sessions_enabled` and
  small-merchant approval exception settings. Lifecycle open, Count Cut behind
  a device-drain and ERP-import barrier, submit, recount, approve under the
  separation policy, cancel; late pre-cut events invalidate lines before
  approval and raise findings after it; approval writes append-only
  `count_correction` effects (`not_posted`) and no posting artefact. The
  eleven operations drop their contract-only markers (inventory.yaml
  1.16.0-draft, wording only).
