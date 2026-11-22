// RT-1453: module boundaries for Backend-Core, across every app source tree (`apps/*/src`, RT-1525).
//
// Pure functions only (no CLI, no process exit); `check.mjs` is the CLI and `__tests__/` pins both.
// No new dependency: it reuses the RT-1454 scanner (`tools/import-cycles/cycles.mjs`: file listing,
// import specifiers, relative resolution) and the `typescript` parser the package already carries.
//
// MODULE: a logical name, the top-level directory of a module under any app source tree. RT-1525: the
// check scans every `apps/<app>/src` tree (today `api` and `worker`), and a module's files may live in
// `apps/api/src/<name>/`, `apps/worker/src/<name>/` or both: same-named directories are ONE module (an
// import between them is a same-module import, and both may name the module's tables). A module that
// exists only in the worker tree may own tables. Files directly in an app's `src` (main.ts,
// app.module.ts, worker.module.ts, instrumentation.ts) are that app's composition root: they may import
// any module's public surface and are never an import target of the check. `shared` modules
// (module-map.json) are cross-cutting infrastructure that every module may import freely.
//
// PUBLIC SURFACE (the port convention): another module may import only
//   - `index.ts` at the module root (in either tree): the barrel with the module's ports, the only place a port is
//     declared (create it only for a module somebody needs a port from);
//   - a Nest wiring file `*.module.ts` at the module root: DI wiring, not business code;
//   - a file listed in that module's `publicFiles` in module-map.json (an explicit, reviewable
//     exception, relative to the module directory).
// Anything else is an INTERNAL file. A static import, re-export, `import x = require()`, dynamic
// `import()` or `require()` of an internal file of another module is a deep-import violation,
// including a type-only import (a reach-in for types is still a reach-in).
//
// FOREIGN TABLE: raw SQL (a string or template literal) that names a table owned by another module
// after `FROM`, `JOIN`, `INTO`, `UPDATE` or `TRUNCATE` (UPPER CASE keywords, the repo's SQL style, so
// prose in an error message never matches). The owner of each table is declared once, in
// module-map.json. A table not declared there is not checked, a table in `sharedTables` may be
// named by anyone. Not covered: Drizzle table objects (`db.select().from(shifts)`), which
// `rulesdir/no-unscoped-tenant-query` already polices for tenant scope.
//
// KNOWN LIMITS (none occurs in the repo today; widen the scanner before one does): SQL keywords in
// lower case, SQL built by concatenation or with `${schema}.table` / `${table}` interpolation, a comma
// join's second table, `ALTER TABLE` / `LOCK TABLE`, `jest.mock` paths (tests are outside
// `apps/*/src`), and a string literal that holds prose with an UPPER-CASE keyword (a rare false
// positive).
//
// Completeness (RT-1525): every live table of the db migrations (created, minus dropped, with renames
// applied) must be owned by exactly one module in module-map.json, or be in `sharedTables` with a reason
// and the approving RT issue. There is no "unowned" list. A new table without an owner fails, and the
// message names its migration; a declared table that a migration dropped or renamed fails as stale.
//
// Baseline unit: a violation KEY with an OCCURRENCE COUNT: `<file> -> <target file>` for an import
// (counted per import statement) and `<file> :: <table>` for SQL (counted per mention). The baseline
// may only shrink: a key that is absent from it, or that occurs more often than it records, fails
// (new); a key it records that no longer occurs that often fails too (stale; run `--update`). A file
// that moves is renamed in the baseline by hand, with no count raised.

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { resolveRelative, runtimeSpecifiers } from "../import-cycles/cycles.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/** The scanned trees: every `apps/<app>/src` (no app name is hard-coded). */
export const SRC_TREES = "apps/*/src";
export const ROOT_MODULE = "(root)";
const SRC_PREFIX = /^apps\/[^/]+\/src\//;

/** `apps/<app>/src/` of a file, or null outside every source tree. */
const srcPrefixOf = (relFile) => SRC_PREFIX.exec(relFile)?.[0] ?? null;

/** The module of a file under `apps/<app>/src`: its top-level directory, or `(root)`. Null outside the trees. */
export function moduleOf(relFile) {
  const prefix = srcPrefixOf(relFile);
  if (prefix === null) return null;
  const rest = relFile.slice(prefix.length).split("/");
  return rest.length === 1 ? ROOT_MODULE : rest[0];
}

/** A file's path inside its module directory (`deep/x.ts` for `apps/worker/src/sales/deep/x.ts`). */
const insideModule = (relFile, mod) => relFile.slice(srcPrefixOf(relFile).length + mod.length + 1);

/** Every scanned source file (posix, relative to the package root) from a full file list. */
export const srcFiles = (files) => files.filter((f) => SRC_PREFIX.test(f));

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;
const isStringArray = (v) => Array.isArray(v) && v.every((e) => typeof e === "string");

/** `module-map.json` relative to the repository root, for the messages that tell the author what to edit. */
export const MODULE_MAP_PATH = "services/backend-core/tools/module-boundaries/module-map.json";
const APPROVED_IN = /^RT-[1-9][0-9]*$/;

/**
 * Validate and normalise module-map.json; throws with every problem found. `moduleDirs`: the
 * module names of every `apps/<app>/src` tree. `opts.files`: every scanned file (to check `publicFiles` exist).
 * `opts.migrationTables`: the live migration tables, `Map<table, migration file that created it>`
 * (completeness, see the header). `opts.goneTables`: `Map<table, how a migration removed it>`, to name
 * the migration in a stale-entry message.
 */
export function parseModuleMap(raw, moduleDirs, opts = {}) {
  const problems = [];
  if (raw.version !== 1) problems.push("version must be 1");
  const arrayField = (name, value) => {
    if (value === undefined) return [];
    if (!isStringArray(value)) problems.push(`${name} must be an array of strings`);
    return isStringArray(value) ? value : [];
  };
  // RT-1525: there is no "nobody checks this table" list any more; even an empty one is refused.
  if (Object.hasOwn(raw, "unownedTables")) {
    problems.push("unownedTables is no longer supported: every table needs an owning module (RT-1525)");
  }
  const shared = arrayField("shared", raw.shared);
  const sharedTables = sharedTableNames(raw.sharedTables, problems);
  const modulesOk = raw.modules !== null && typeof raw.modules === "object" && !Array.isArray(raw.modules);
  if (!modulesOk) problems.push("modules must be an object");
  const modules = modulesOk ? raw.modules : {};
  const dirs = new Set(moduleDirs);
  // `<module>/<path inside it>` for every scanned file, in any tree (a publicFiles entry may live in either).
  const moduleFiles = opts.files
    ? new Set(srcFiles(opts.files).filter((f) => moduleOf(f) !== ROOT_MODULE).map((f) => `${moduleOf(f)}/${insideModule(f, moduleOf(f))}`))
    : null;
  for (const dir of shared) {
    if (!dirs.has(dir)) problems.push(`shared module "${dir}" is not a directory under ${SRC_TREES}`);
    if (dir in modules) problems.push(`"${dir}" is both a shared module and a module with tables`);
  }
  const owner = new Map();
  const nameProblem = (table, where) => (TABLE_NAME.test(table) ? [] : [`${where}: "${table}" is not a lower-case table name (no schema prefix)`]);
  for (const [dir, def] of Object.entries(modules)) {
    if (!dirs.has(dir)) problems.push(`module "${dir}" is not a directory under ${SRC_TREES}`);
    const tables = arrayField(`module "${dir}" tables`, def.tables);
    const publicFiles = arrayField(`module "${dir}" publicFiles`, def.publicFiles);
    for (const table of tables) {
      problems.push(...nameProblem(table, `module "${dir}"`));
      if (owner.get(table) === dir) problems.push(`table "${table}" is listed twice in module "${dir}"`);
      else if (owner.has(table)) problems.push(`table "${table}" is owned by both "${owner.get(table)}" and "${dir}"`);
      else owner.set(table, dir);
    }
    for (const f of publicFiles) {
      if (!f.endsWith(".ts")) problems.push(`module "${dir}" publicFiles "${f}" must be a .ts path relative to the module`);
      else if (moduleFiles && !moduleFiles.has(`${dir}/${f}`)) problems.push(`module "${dir}" publicFiles "${f}" does not exist`);
    }
  }
  for (const table of sharedTables) {
    problems.push(...nameProblem(table, "sharedTables"));
    if (owner.has(table)) problems.push(`table "${table}" is both shared and owned by "${owner.get(table)}"`);
  }
  if (opts.migrationTables) {
    const live = opts.migrationTables;
    const gone = opts.goneTables ?? new Map();
    const declared = new Set([...owner.keys(), ...sharedTables]);
    for (const [table, file] of [...live].sort(([x], [y]) => (x < y ? -1 : 1))) {
      if (!declared.has(table)) {
        problems.push(
          `table "${table}" is created by ${file} but has no owner. Add it to modules["<dir>"].tables in ${MODULE_MAP_PATH}, ` +
            "where <dir> is the apps/api/src or apps/worker/src module that will read and write it.",
        );
      }
    }
    for (const table of [...declared].sort()) {
      if (!live.has(table)) {
        const how = gone.get(table);
        problems.push(`table "${table}" is declared but no migration creates it (renamed or dropped?)${how ? `: ${how}` : ""}`);
      }
    }
  }
  if (problems.length > 0) throw new Error(`module-map.json is invalid:\n  ${problems.join("\n  ")}`);
  return { shared: new Set(shared), sharedTables: new Set(sharedTables), tableOwner: owner, publicFiles: modules };
}

/**
 * RT-1525: `sharedTables` is a list of `{ table, reason, approvedIn }`. A table every module may name is an
 * exception the owner approves in the PR (like a baseline line), so each entry says why and where.
 */
function sharedTableNames(value, problems) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push("sharedTables must be an array of { table, reason, approvedIn }");
    return [];
  }
  const names = [];
  for (const entry of value) {
    const ok = entry !== null && typeof entry === "object" && !Array.isArray(entry);
    const table = ok && typeof entry.table === "string" ? entry.table : null;
    if (table === null) {
      problems.push(`sharedTables entry ${JSON.stringify(entry)} must be { table, reason, approvedIn }`);
      continue;
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") problems.push(`sharedTables "${table}" needs a non-empty reason`);
    if (typeof entry.approvedIn !== "string" || !APPROVED_IN.test(entry.approvedIn)) {
      problems.push(`sharedTables "${table}" needs approvedIn: the RT issue that approved it (for example "RT-1525")`);
    }
    names.push(table);
  }
  return names;
}

// One statement that creates, drops or renames a table, matched in text order across an up migration.
const TABLE_DDL =
  /^\s*(?:(CREATE TABLE(?: IF NOT EXISTS)?|DROP TABLE(?: IF EXISTS)?)\s+([^;(]+)|ALTER TABLE(?: IF EXISTS)?(?: ONLY)?\s+((?:public\.)?"?[a-z_][a-z0-9_]*"?)\s+RENAME TO\s+("?[a-z_][a-z0-9_]*"?))/gim;
const tableNameOf = (text) => /^(?:public\.)?"?([a-z_][a-z0-9_]*)"?/i.exec(text.trim())?.[1];

/**
 * The live tables of the db migrations and the ones they removed, from `packages/db/drizzle` (up migrations
 * only, in file order, each file in text order). `live`: `Map<table, migration file>` for every table a
 * `CREATE TABLE` made (or an `ALTER TABLE ... RENAME TO` named) and nothing later dropped or renamed away.
 * `gone`: `Map<table, "dropped by <file>" | "renamed to \"<new>\" by <file>">`. A dropped table needs no
 * owner (RT-422); a renamed table is owned under its new name (RT-1525). Files are repo-relative.
 */
export function migrationHistory(root) {
  const dir = path.join(root, "packages", "db", "drizzle");
  const rel = (name) => `services/backend-core/packages/db/drizzle/${name}`;
  const live = new Map();
  const gone = new Map();
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".sql") && !n.endsWith(".down.sql"));
  } catch {
    return { live, gone };
  }
  for (const name of names.sort()) {
    const sql = readFileSync(path.join(dir, name), "utf8");
    for (const m of sql.matchAll(TABLE_DDL)) {
      if (m[3] !== undefined) {
        const [from, to] = [tableNameOf(m[3]), tableNameOf(m[4])];
        if (from === undefined || to === undefined) continue;
        live.delete(from);
        gone.set(from, `renamed to "${to}" by ${rel(name)}`);
        live.set(to, rel(name));
        gone.delete(to);
        continue;
      }
      const isDrop = m[1].toUpperCase().startsWith("DROP");
      // `DROP TABLE a, b CASCADE` names several tables; a CREATE names one (the capture stops at its `(`).
      for (const part of isDrop ? m[2].split(",") : [m[2]]) {
        const table = tableNameOf(part);
        if (table === undefined) continue;
        if (isDrop) {
          live.delete(table);
          gone.set(table, `dropped by ${rel(name)}`);
        } else {
          live.set(table, rel(name));
          gone.delete(table);
        }
      }
    }
  }
  return { live, gone };
}

/** The live migration tables, `Map<table, migration file>` (see `migrationHistory`). */
export const migrationTables = (root) => migrationHistory(root).live;

/** Is `relFile` (a file of module `mod`) part of that module's public surface? */
export function isPublicFile(relFile, mod, map) {
  const inside = insideModule(relFile, mod);
  if (inside === "index.ts" || (!inside.includes("/") && inside.endsWith(".module.ts"))) return true;
  return (map.publicFiles[mod]?.publicFiles ?? []).includes(inside);
}

const sortedCounts = (counts) => Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const bump = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);

/** Deep-import violations: `{ "<file> -> <target file>": occurrences }`, sorted by key. */
export function importViolations(files, readSource, map) {
  const fileSet = new Set(files);
  const out = new Map();
  for (const from of srcFiles(files)) {
    const fromMod = moduleOf(from);
    if (fromMod === ROOT_MODULE) continue;
    for (const spec of runtimeSpecifiers(readSource(from), from, true)) {
      const to = resolveRelative(from, spec, fileSet);
      const toMod = to === null ? null : moduleOf(to);
      if (toMod === null || toMod === ROOT_MODULE || toMod === fromMod || map.shared.has(toMod)) continue;
      if (!isPublicFile(to, toMod, map)) bump(out, `${from} -> ${to}`);
    }
  }
  return sortedCounts(out);
}

// An optional `schema.` prefix (public or any other) is skipped, so `FROM app.shifts` names `shifts`.
const SQL_TABLE = /\b(?:FROM|JOIN|INTO|UPDATE|TRUNCATE)\s+(?:ONLY\s+)?(?:"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?/g;

/** The table names a source file names in SQL, as `Map<table, mentions>`, from its string and template literal text. */
export function sqlTablesIn(sourceText, fileName = "x.ts") {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found = new Map();
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const m of node.text.matchAll(SQL_TABLE)) bump(found, m[1]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Foreign-table violations: `{ "<file> :: <table>": mentions }`, sorted by key. */
export function sqlViolations(files, readSource, map) {
  const out = new Map();
  for (const file of srcFiles(files)) {
    const mod = moduleOf(file);
    if (mod === ROOT_MODULE) continue;
    for (const [table, mentions] of sqlTablesIn(readSource(file), file)) {
      const owner = map.tableOwner.get(table);
      if (owner !== undefined && owner !== mod && !map.sharedTables.has(table)) out.set(`${file} :: ${table}`, mentions);
    }
  }
  return sortedCounts(out);
}

/**
 * Shrink-only comparison of `{ key: count }` maps. `added`: keys that are absent from the baseline or
 * occur more often than it records (fails). `stale`: keys the baseline records that occur less often
 * now, or not at all (fails; `--update` shrinks it). Each entry is `{ key, current, baseline }`.
 */
export function compareToBaseline(current, baseline) {
  const added = [];
  const stale = [];
  for (const [key, n] of Object.entries(current)) if (n > (baseline[key] ?? 0)) added.push({ key, current: n, baseline: baseline[key] ?? 0 });
  for (const [key, n] of Object.entries(baseline)) if ((current[key] ?? 0) < n) stale.push({ key, current: current[key] ?? 0, baseline: n });
  return { added, stale };
}

/** The module names (top-level directories of every `apps/<app>/src` tree, merged), for map validation. */
export const moduleDirsOf = (files) => [...new Set(srcFiles(files).map(moduleOf))].filter((m) => m !== ROOT_MODULE).sort();

/** Read helper for the CLI. */
export const readFrom = (root) => (rel) => readFileSync(path.join(root, rel), "utf8");
