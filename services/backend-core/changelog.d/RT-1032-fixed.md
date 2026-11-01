### Fixed
- RT-1032, owner authorization 2026-11-01: `RT-BackendLabDeploy` accepts a same-release redeploy
  (`CurrentRelease` equal to `ReleaseTag`). Since RT-908 B2 its next-wrapper guard always refused one
  (`next-wrapper-still-uses-the-current-release`), because the release directory is rewritten to itself;
  the guard now requires an unchanged wrapper for the same release, and keeps the old check for another release.
  The owner must `update-document` the SSM document after merge.
