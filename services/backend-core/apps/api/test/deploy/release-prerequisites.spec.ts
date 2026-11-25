/**
 * RT-1603 — docs/operations/sql/release-prerequisites.sql, the read-only check of
 * what only a superuser can set up before `migrate up`. The lab deploy document
 * runs the target bundle's copy at G-Prereq, before it changes anything on lab-01,
 * and deploy/README.md runs it as Deploy step 0. The checks are static: the file
 * reads catalogs and RAISEs, nothing else; it ships in the bundle; and every
 * migration that tells the operator to act "as a superuser" has its check here.
 * Its behaviour on a real role layout is recorded on RT-1603.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");
const FILE = "docs/operations/sql/release-prerequisites.sql";
const sql = read(FILE);

/** The SQL without comments and string literals, so only statements and identifiers remain. */
const code = sql
  .replace(/--[^\n]*/g, "")
  .replace(/'(?:[^']|'')*'/g, "''");

describe("release-prerequisites.sql (RT-1603)", () => {
  it("is one DO block that only reads catalogs and raises", () => {
    expect(code.match(/\bDO \$\$/g)).toHaveLength(1);
    // no DDL, DML, privilege, transaction, session or psql meta-command
    expect(code).not.toMatch(/\b(CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE|COPY|COMMIT|ROLLBACK|SAVEPOINT|SET|RESET|EXECUTE|CALL|LOCK|VACUUM|CLUSTER|REINDEX|COMMENT|SECURITY)\b/i);
    expect(code).not.toMatch(/\\[a-z!]/i);
    expect(code).not.toMatch(/\bdblink|\bpg_(read|write|file|terminate|cancel|reload)/i);
    expect(sql).toContain("RAISE EXCEPTION 'release prerequisites missing: %'");
  });

  it("checks the role migration 0132 needs and the migration owner's membership", () => {
    expect(sql).toContain("Migration 0132");
    expect(code).toContain("FROM pg_roles WHERE rolname = ''");
    expect(sql).toContain("rolname = 'pricing_projection_writer'");
    expect(sql).toContain("pg_has_role(current_user, 'pricing_projection_writer', 'MEMBER')");
    // the runbook section it names exists
    expect(read("docs/operations/database-roles.md")).toContain("## Before migration 0132: `pricing_projection_writer`");
  });

  it("covers every migration that asks for a superuser step before it runs", () => {
    const dir = "packages/db/drizzle";
    const needy = readdirSync(resolve(repoRoot, dir))
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.endsWith(".down.sql"))
      .filter((f) => /HINT\s*=\s*'As a superuser/i.test(read(`${dir}/${f}`)))
      .map((f) => f.slice(0, 4));
    expect(needy).toContain("0132");
    for (const n of needy) expect({ migration: n, checked: sql.includes(`Migration ${n}`) }).toEqual({ migration: n, checked: true });
  });

  it("ships in the release bundle and runs read-only in Deploy step 0", () => {
    expect(read("deploy/release-bundle.sh")).toContain(`  ${FILE}\n`);
    const readme = read("deploy/README.md");
    const deploy = readme.slice(readme.indexOf("\n## Deploy\n"), readme.indexOf("# 1. Apply migrations"));
    expect(deploy).toContain("op run --env-file=deploy/grants.env -- deploy/apply-domain-grants.sh --check-env\n");
    expect(deploy).toContain(`psql -X -q -1 -v ON_ERROR_STOP=1 -c 'SET TRANSACTION READ ONLY' \\\n    -f ${FILE}\n`);
  });
});
