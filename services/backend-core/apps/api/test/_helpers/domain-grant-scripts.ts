/**
 * RT-812 — the independent oracle for the boot-checked grant lists: the
 * routine deploy scripts in docs/operations/sql and the migrations' CREATE
 * TABLEs, read from disk. The lists themselves are assembled from fragments
 * (src/auth/grants/), so a test that compared them with themselves would not
 * notice a dropped entry; comparing them with what deploy actually grants does.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
export const SQL_DIR = resolve(repoRoot, "docs", "operations", "sql");
export const DRIZZLE_DIR = resolve(repoRoot, "packages", "db", "drizzle");

/** The opt-in line `deploy/apply-domain-grants.sh` selects routine scripts by. */
export const ROUTINE_MARKER = "-- deploy: every-release";

/** The last migration covered by the frozen grants baseline. */
export const GRANTS_BASELINE_HEAD = "0067_refund_executions";

const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** Every `*-domain-grants.sql` carrying the routine marker, by name. */
export function routineGrantScripts(dir = SQL_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith("-domain-grants.sql"))
    .filter((f) => read(resolve(dir, f)).split("\n").includes(ROUTINE_MARKER))
    .sort();
}

const TABLE_GRANT = /^\s*GRANT\s+([A-Z, ]+?)\s+ON\s+([a-z0-9_, ]+?)\s+TO\s+:"domain_role"\s*;/gm;
/** RT-1249: `GRANT <PRIVILEGE> (<col>, ...) ON <table> TO :"domain_role";`, one privilege per statement. */
const COLUMN_GRANT = /^\s*GRANT\s+([A-Z]+)\s*\(([a-z0-9_, ]+)\)\s+ON\s+([a-z0-9_]+)\s+TO\s+:"domain_role"\s*;/gm;

const split = (list: string): string[] => list.split(",").map((item) => item.trim());

/**
 * Every GRANT of a script, parsed as table grants ("table:PRIVILEGE") and
 * column grants ("table(column):PRIVILEGE"). Fails closed: a GRANT statement in
 * any other shape (lowercase, `ON TABLE`, a schema prefix, another grantee, two
 * privileges in one column grant) throws instead of being skipped, so no grant
 * deploy applies can escape the comparison.
 */
function parseScript(script: string, dir: string): { tables: string[]; columns: string[] } {
  const sql = read(resolve(dir, script));
  const statements = sql.match(/^\s*GRANT\b[^;]*;?/gim) ?? [];
  const tableGrants = [...sql.matchAll(TABLE_GRANT)];
  const columnGrants = [...sql.matchAll(COLUMN_GRANT)];
  const unparsed = statements.length - tableGrants.length - columnGrants.length;
  if (unparsed !== 0) {
    throw new Error(`${script}: ${unparsed} GRANT statement(s) the grant oracle cannot parse`);
  }
  const tables = tableGrants.flatMap((m) => split(m[2]!).flatMap((table) => split(m[1]!).map((p) => `${table}:${p}`)));
  const columns = columnGrants.flatMap((m) => split(m[2]!).map((column) => `${m[3]!}(${column}):${m[1]!}`));
  return { tables, columns };
}

/** "table:PRIVILEGE" for each table-level privilege a script GRANTs to the domain role. */
export function scriptGrants(script: string, dir = SQL_DIR): string[] {
  return parseScript(script, dir).tables;
}

/** RT-1249: "table(column):PRIVILEGE" for each column privilege a script GRANTs to the domain role. */
export function scriptColumnGrants(script: string, dir = SQL_DIR): string[] {
  return parseScript(script, dir).columns;
}

/** Tables created by the up migrations after `afterId` (lexical id order). */
export function tablesCreatedAfter(afterId: string, dir = DRIZZLE_DIR): string[] {
  const tables: string[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!/^\d{4}_.+\.sql$/.test(file) || file.endsWith(".down.sql")) continue;
    if (file.replace(/\.sql$/, "") <= afterId) continue;
    for (const m of read(resolve(dir, file)).matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi,
    )) {
      tables.push(m[1]!.toLowerCase());
    }
  }
  return tables;
}
