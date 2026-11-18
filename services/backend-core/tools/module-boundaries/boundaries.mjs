// RT-1453: intra-api module boundaries for Backend-Core (`apps/api/src`).
//
// Pure functions only (no CLI, no process exit); `check.mjs` is the CLI and `__tests__/` pins both.
// No new dependency: it reuses the RT-1454 scanner (`tools/import-cycles/cycles.mjs`: file listing,
// import specifiers, relative resolution) and the `typescript` parser the package already carries.
//
// MODULE: one top-level directory under `apps/api/src`. Files directly in `src` (main.ts,
// app.module.ts, instrumentation.ts) are the composition root: they may import any module's public
// surface and are never an import target of the check. `shared` modules (module-map.json) are
// cross-cutting infrastructure that every module may import freely.
//
// PUBLIC SURFACE (the port convention): another module may import only
//   - `index.ts` at the module root: the barrel with the module's ports, the only place a port is
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
// `apps/api/src`), and a string literal that holds prose with an UPPER-CASE keyword (a rare false
// positive).
//
// Completeness: every table the db migrations create must be owned in module-map.json, listed in
// `sharedTables` or listed in `unownedTables`, so a new table is never silently unchecked.
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

export const API_SRC = "apps/api/src";
export const ROOT_MODULE = "(root)";

/** The module of a file under `apps/api/src`: its top-level directory, or `(root)`. Null outside the tree. */
export function moduleOf(relFile) {
  if (!relFile.startsWith(`${API_SRC}/`)) return null;
  const rest = relFile.slice(API_SRC.length + 1).split("/");
  return rest.length === 1 ? ROOT_MODULE : rest[0];
}

/** Every api source file (posix, relative to the package root) from a full file list. */
export const apiFiles = (files) => files.filter((f) => f.startsWith(`${API_SRC}/`));

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;
const isStringArray = (v) => Array.isArray(v) && v.every((e) => typeof e === "string");

/**
 * Validate and normalise module-map.json; throws with every problem found. `moduleDirs`: the
 * directories under `apps/api/src`. `opts.files`: every scanned file (to check `publicFiles` exist).
 * `opts.migrationTables`: the tables the migrations create (completeness, see the header).
 */
export function parseModuleMap(raw, moduleDirs, opts = {}) {
  const problems = [];
  if (raw.version !== 1) problems.push("version must be 1");
  const arrayField = (name, value) => {
    if (value === undefined) return [];
    if (!isStringArray(value)) problems.push(`${name} must be an array of strings`);
    return isStringArray(value) ? value : [];
  };
  const shared = arrayField("shared", raw.shared);
  const sharedTables = arrayField("sharedTables", raw.sharedTables);
  const unownedTables = arrayField("unownedTables", raw.unownedTables);
  const modulesOk = raw.modules !== null && typeof raw.modules === "object" && !Array.isArray(raw.modules);
  if (!modulesOk) problems.push("modules must be an object");
  const modules = modulesOk ? raw.modules : {};
  const dirs = new Set(moduleDirs);
  const fileSet = opts.files ? new Set(opts.files) : null;
  for (const dir of shared) {
    if (!dirs.has(dir)) problems.push(`shared module "${dir}" is not a directory under ${API_SRC}`);
    if (dir in modules) problems.push(`"${dir}" is both a shared module and a module with tables`);
  }
  const owner = new Map();
  const nameProblem = (table, where) => (TABLE_NAME.test(table) ? [] : [`${where}: "${table}" is not a lower-case table name (no schema prefix)`]);
  for (const [dir, def] of Object.entries(modules)) {
    if (!dirs.has(dir)) problems.push(`module "${dir}" is not a directory under ${API_SRC}`);
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
      else if (fileSet && !fileSet.has(`${API_SRC}/${dir}/${f}`)) problems.push(`module "${dir}" publicFiles "${f}" does not exist`);
    }
  }
  for (const table of sharedTables) {
    problems.push(...nameProblem(table, "sharedTables"));
    if (owner.has(table)) problems.push(`table "${table}" is both shared and owned by "${owner.get(table)}"`);
  }
  for (const table of unownedTables) {
    problems.push(...nameProblem(table, "unownedTables"));
    if (owner.has(table) || sharedTables.includes(table)) problems.push(`table "${table}" is in unownedTables but also owned or shared`);
  }
  if (opts.migrationTables) {
    const created = new Set(opts.migrationTables);
    const declared = new Set([...owner.keys(), ...sharedTables, ...unownedTables]);
    for (const table of [...created].sort()) {
      if (!declared.has(table)) problems.push(`table "${table}" is created by a migration but is not owned, shared or listed in unownedTables`);
    }
    for (const table of [...declared].sort()) {
      if (!created.has(table)) problems.push(`table "${table}" is declared but no migration creates it (renamed or dropped?)`);
    }
  }
  if (problems.length > 0) throw new Error(`module-map.json is invalid:\n  ${problems.join("\n  ")}`);
  return { shared: new Set(shared), sharedTables: new Set(sharedTables), tableOwner: owner, publicFiles: modules };
}

/** Tables the db migrations create (`CREATE TABLE`, up migrations only), sorted, from `packages/db/drizzle`. */
export function migrationTables(root) {
  const dir = path.join(root, "packages", "db", "drizzle");
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".sql") && !n.endsWith(".down.sql"));
  } catch {
    return [];
  }
  const found = new Set();
  for (const name of names) {
    for (const m of readFileSync(path.join(dir, name), "utf8").matchAll(/^\s*CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gim)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

/** Is `relFile` (a file of module `mod`) part of that module's public surface? */
export function isPublicFile(relFile, mod, map) {
  const inside = relFile.slice(`${API_SRC}/${mod}/`.length);
  if (inside === "index.ts" || (!inside.includes("/") && inside.endsWith(".module.ts"))) return true;
  return (map.publicFiles[mod]?.publicFiles ?? []).includes(inside);
}

const sortedCounts = (counts) => Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const bump = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);

/** Deep-import violations: `{ "<file> -> <target file>": occurrences }`, sorted by key. */
export function importViolations(files, readSource, map) {
  const fileSet = new Set(files);
  const out = new Map();
  for (const from of apiFiles(files)) {
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
  for (const file of apiFiles(files)) {
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

/** The directories under `apps/api/src`, for map validation. */
export const moduleDirsOf = (files) => [...new Set(apiFiles(files).map(moduleOf))].filter((m) => m !== ROOT_MODULE).sort();

/** Read helper for the CLI. */
export const readFrom = (root) => (rel) => readFileSync(path.join(root, rel), "utf8");
