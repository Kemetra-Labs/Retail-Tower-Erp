/**
 * RT-1457 / audit A-05 — global RLS coverage invariant.
 *
 * Every table in schema `public` that has a `tenant_id` column must have row-level
 * security ENABLED and FORCED, and at least one policy. The check reads the catalog
 * (`pg_class`, `pg_attribute`, `pg_policies`) after ALL migrations are applied, so it
 * does not depend on a hand-kept table list (`migration.spec.ts` `RLS_TABLES`) and it
 * sees policies that migrations create in dynamic SQL loops (for example 0101), which
 * a static scan of the `.sql` files cannot.
 *
 * Why it exists: a new tenant table whose migration spec forgets its own RLS assertion
 * used to ship without isolation and nothing failed.
 *
 * Exemptions (`RLS_COVERAGE_EXEMPTIONS`) are explicit, commented and SHRINK-ONLY:
 *   - each entry carries the table, a reason and a Jira key;
 *   - a STALE entry (the table now has full RLS coverage, or no longer exists) fails,
 *     so the list can only get shorter on purpose.
 * The list is empty today: every tenant table is covered. Add an entry only with a reason and a
 * Jira key that owns the fix.
 *
 * Scope and limits (by the RT-1457 definition of "tenant table"):
 *   - ordinary and partitioned tables in schema `public` with a live column named `tenant_id`;
 *     views, materialized views, other schemas and tables that scope by a differently named
 *     column are not seen (none exists today). A future partitioned table needs its child
 *     partitions looked at separately: each child is its own row here.
 *   - "at least one policy" counts policies; it does not judge the predicate or command. Policy
 *     CORRECTNESS stays with each migration's own spec (this invariant only catches the missing
 *     RLS, the missing FORCE and the missing policy).
 *
 * Negative fixtures: each failure mode is proven by a throwaway DDL transaction that is
 * rolled back, so a broken invariant cannot pass silently.
 */
import type { PoolClient } from "pg";

import { inRolledBackTx } from "./_helpers/migration-spec";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "./_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Exemptions — shrink-only. Empty on purpose; see the file header.
// ---------------------------------------------------------------------------

interface RlsExemption {
  readonly table: string;
  /** Why the table may lack RLS coverage today. */
  readonly reason: string;
  /** The Jira issue that owns removing this exemption, for example "RT-1234". */
  readonly jira: string;
}

const RLS_COVERAGE_EXEMPTIONS: readonly RlsExemption[] = [];

// ---------------------------------------------------------------------------
// Catalog read + pure evaluation
// ---------------------------------------------------------------------------

interface TenantTableRow {
  readonly table: string;
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
  readonly policies: number;
}

/** Every ordinary or partitioned table in `public` that has a live `tenant_id` column. */
const TENANT_TABLES_SQL = `
  SELECT c.relname AS "table",
         c.relrowsecurity AS "rlsEnabled",
         c.relforcerowsecurity AS "rlsForced",
         (SELECT count(*)::int FROM pg_policies p
           WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid
                    AND a.attname = 'tenant_id'
                    AND a.attnum > 0
                    AND NOT a.attisdropped)
   ORDER BY c.relname`;

async function readTenantTables(client: Pick<PoolClient, "query">): Promise<TenantTableRow[]> {
  const { rows } = await client.query<TenantTableRow>(TENANT_TABLES_SQL);
  return rows;
}

const JIRA_KEY = /^RT-\d+$/;

function isCovered(row: TenantTableRow): boolean {
  return row.rlsEnabled && row.rlsForced && row.policies > 0;
}

function describeGap(row: TenantTableRow): string {
  const gaps = [
    row.rlsEnabled ? null : "RLS not enabled",
    row.rlsForced ? null : "RLS not FORCED",
    row.policies > 0 ? null : "no policy",
  ].filter((g): g is string => g !== null);
  return `${row.table}: ${gaps.join(", ")}`;
}

/** Every way the invariant can be violated, as readable strings; empty means it holds. */
function evaluate(rows: readonly TenantTableRow[], exemptions: readonly RlsExemption[]): string[] {
  const problems: string[] = [];
  const byTable = new Map<string, TenantTableRow>(rows.map((r) => [r.table, r] as [string, TenantTableRow]));
  const exempt = new Map<string, RlsExemption>();

  for (const e of exemptions) {
    if (exempt.has(e.table)) problems.push(`duplicate exemption: ${e.table}`);
    exempt.set(e.table, e);
    if (!JIRA_KEY.test(e.jira)) problems.push(`exemption ${e.table} has no Jira key (got "${e.jira}")`);
    if (e.reason.trim().length < 10) problems.push(`exemption ${e.table} has no reason (at least 10 characters)`);
    const row = byTable.get(e.table);
    if (row === undefined) problems.push(`stale exemption: ${e.table} is not a tenant table any more (remove it, ${e.jira})`);
    else if (isCovered(row)) problems.push(`stale exemption: ${e.table} now has full RLS coverage (remove it, ${e.jira})`);
  }

  for (const row of rows) {
    if (!isCovered(row) && !exempt.has(row.table)) problems.push(`uncovered tenant table: ${describeGap(row)}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[rls-coverage.invariant.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[rls-coverage.invariant.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

/** Run `ddl` (a throwaway migration) in a rolled-back transaction, then evaluate the catalog. */
async function evaluateAfter(ddl: string, exemptions: readonly RlsExemption[] = RLS_COVERAGE_EXEMPTIONS): Promise<string[]> {
  return inRolledBackTx(env!.admin, async (client) => {
    await client.query(ddl);
    return evaluate(await readTenantTables(client), exemptions);
  });
}

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

describe("RLS coverage invariant (RT-1457 A-05)", () => {
  it("every public table with a tenant_id column has RLS enabled, forced and at least one policy", async () => {
    if (maybeSkip()) return;
    const rows = await readTenantTables(env!.admin);
    // Guard against a broken catalog query that matches nothing and so "passes".
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.map((r) => r.table)).toEqual(expect.arrayContaining(["memberships", "roles", "store_access", "audit_events"]));
    expect(evaluate(rows, RLS_COVERAGE_EXEMPTIONS)).toEqual([]);
  });

  it("the exemption list can only shrink: it is no longer than its ceiling", () => {
    // Lower this number when an entry is removed; raising it needs a reviewed reason.
    const CEILING = 0;
    expect(RLS_COVERAGE_EXEMPTIONS.length).toBeLessThanOrEqual(CEILING);
  });

  // -------------------------------------------------------------------------
  // Negative fixtures: a throwaway migration that breaks the rule must fail it.
  // -------------------------------------------------------------------------

  it("fails for a tenant table created without RLS", async () => {
    if (maybeSkip()) return;
    const problems = await evaluateAfter(`CREATE TABLE rls_fixture_plain (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)`);
    expect(problems).toEqual(["uncovered tenant table: rls_fixture_plain: RLS not enabled, RLS not FORCED, no policy"]);
  });

  it("fails for a tenant table with RLS enabled but not FORCED", async () => {
    if (maybeSkip()) return;
    const problems = await evaluateAfter(`
      CREATE TABLE rls_fixture_unforced (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
      ALTER TABLE rls_fixture_unforced ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p ON rls_fixture_unforced USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)`);
    expect(problems).toEqual(["uncovered tenant table: rls_fixture_unforced: RLS not FORCED"]);
  });

  it("fails for a tenant table with RLS forced but no policy", async () => {
    if (maybeSkip()) return;
    const problems = await evaluateAfter(`
      CREATE TABLE rls_fixture_nopolicy (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
      ALTER TABLE rls_fixture_nopolicy ENABLE ROW LEVEL SECURITY;
      ALTER TABLE rls_fixture_nopolicy FORCE ROW LEVEL SECURITY`);
    expect(problems).toEqual(["uncovered tenant table: rls_fixture_nopolicy: no policy"]);
  });

  it("passes for a new tenant table that is enabled, forced and has a policy", async () => {
    if (maybeSkip()) return;
    const problems = await evaluateAfter(`
      CREATE TABLE rls_fixture_ok (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
      ALTER TABLE rls_fixture_ok ENABLE ROW LEVEL SECURITY;
      ALTER TABLE rls_fixture_ok FORCE ROW LEVEL SECURITY;
      CREATE POLICY p ON rls_fixture_ok USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)`);
    expect(problems).toEqual([]);
  });

  it("sees a tenant_id column that is added later, and ignores one that was dropped", async () => {
    if (maybeSkip()) return;
    expect(await evaluateAfter(`CREATE TABLE rls_fixture_late (id uuid PRIMARY KEY); ALTER TABLE rls_fixture_late ADD COLUMN tenant_id uuid`)).toEqual([
      "uncovered tenant table: rls_fixture_late: RLS not enabled, RLS not FORCED, no policy",
    ]);
    expect(await evaluateAfter(`CREATE TABLE rls_fixture_gone (id uuid PRIMARY KEY, tenant_id uuid); ALTER TABLE rls_fixture_gone DROP COLUMN tenant_id`)).toEqual([]);
  });

  it("a documented exemption silences exactly its table, and goes stale once the table is covered or gone", async () => {
    if (maybeSkip()) return;
    const exemption: RlsExemption = { table: "rls_fixture_plain", reason: "fixture: no RLS yet, owned by the follow-up", jira: "RT-9999" };
    const create = `CREATE TABLE rls_fixture_plain (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)`;

    // Exempt and still uncovered: passes.
    expect(await evaluateAfter(create, [exemption])).toEqual([]);

    // Exempt but now fully covered: stale, fails.
    const covered = `${create};
      ALTER TABLE rls_fixture_plain ENABLE ROW LEVEL SECURITY;
      ALTER TABLE rls_fixture_plain FORCE ROW LEVEL SECURITY;
      CREATE POLICY p ON rls_fixture_plain USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)`;
    expect(await evaluateAfter(covered, [exemption])).toEqual([
      "stale exemption: rls_fixture_plain now has full RLS coverage (remove it, RT-9999)",
    ]);

    // Exempt but the table does not exist: stale, fails.
    expect(await evaluateAfter(`SELECT 1`, [exemption])).toEqual([
      "stale exemption: rls_fixture_plain is not a tenant table any more (remove it, RT-9999)",
    ]);
  });

  it("rejects an exemption without a Jira key or a reason, and a duplicate", async () => {
    if (maybeSkip()) return;
    const create = `CREATE TABLE rls_fixture_plain (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)`;
    const noKey = await evaluateAfter(create, [{ table: "rls_fixture_plain", reason: "a real reason here", jira: "later" }]);
    expect(noKey).toEqual(['exemption rls_fixture_plain has no Jira key (got "later")']);
    const noReason = await evaluateAfter(create, [{ table: "rls_fixture_plain", reason: "", jira: "RT-1" }]);
    expect(noReason).toEqual(["exemption rls_fixture_plain has no reason (at least 10 characters)"]);
    const dup = { table: "rls_fixture_plain", reason: "a real reason here", jira: "RT-1" };
    expect(await evaluateAfter(create, [dup, dup])).toEqual(["duplicate exemption: rls_fixture_plain"]);
  });
});
