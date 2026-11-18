### Added
- RT-1457 (audit A-05): `packages/db/__tests__/rls-coverage.invariant.spec.ts` reads the catalog after
  all migrations and fails unless every `public` table with a `tenant_id` column has row-level
  security enabled and forced and at least one policy. The exemption list is empty today and
  shrink-only (each entry needs a reason and a Jira key; a stale entry fails). Tests only, no
  migration and no runtime change.
