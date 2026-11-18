### Changed
- RT-1470 (owner decision 2026-11-18, RT-1468 comment 17463): a session platform admin decides as an
  owner in every service that reads the caller's role itself (offers, cash variance policy, catalog
  writes, people, devices, tracking resolution, count sessions, and every operator store scope through
  `callerStoreScope`), member or not, and is tenant-wide. New `context/effective-role.ts`. A bearer
  token never qualifies (RT-132 D6); audit records keep the real membership role; non-admin callers
  are unchanged.
