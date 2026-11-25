-- RT-1603: release prerequisites that only a superuser (or the owner) can set up,
-- checked BEFORE `migrate up` (deploy/README.md, Deploy step 0; the lab deploy
-- document runs the target bundle's copy at its G-Prereq gate, before it changes
-- anything on the host).
--
-- Read-only by contract: it only reads catalogs and RAISEs. Run it in a
-- read-only transaction, as the migration owner (the PG* variables of
-- deploy/grants.env):
--
--   psql -X -q -1 -v ON_ERROR_STOP=1 -c 'SET TRANSACTION READ ONLY' \
--     -f docs/operations/sql/release-prerequisites.sql
--
-- It never creates, grants or changes anything (a spec checks the statements).
-- Each check holds as well after its migration ran, so it is safe on every
-- release. When a migration needs something the migration owner cannot do
-- itself, add its check here in the same PR as the migration, naming the
-- runbook section that fixes it.
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  is_superuser boolean;
BEGIN
  SELECT rolsuper INTO is_superuser FROM pg_roles WHERE rolname = current_user;

  -- Migration 0132 (RT-1485): docs/operations/database-roles.md, "Before migration 0132".
  -- A superuser migration owner (test databases) lets 0132 create the role itself.
  IF NOT coalesce(is_superuser, false) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pricing_projection_writer') THEN
      missing := missing || 'role pricing_projection_writer does not exist (database-roles.md, Before migration 0132)'::text;
    ELSIF NOT pg_has_role(current_user, 'pricing_projection_writer', 'MEMBER') THEN
      missing := missing || format('%s is not a member of pricing_projection_writer (database-roles.md, Before migration 0132)', current_user);
    END IF;
  END IF;

  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'release prerequisites missing: %', array_to_string(missing, '; ')
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'A superuser sets each one up once per cluster; see the named runbook section.';
  END IF;
  RAISE NOTICE 'release prerequisites: ok';
END
$$;
