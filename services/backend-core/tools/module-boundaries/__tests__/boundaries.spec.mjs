// RT-1453: pins the module-boundary check (tools/module-boundaries/boundaries.mjs) with in-memory fixtures.
// Run: node --test tools/module-boundaries/__tests__/boundaries.spec.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listSourceFiles } from "../../import-cycles/cycles.mjs";
import {
  compareToBaseline,
  importViolations,
  isPublicFile,
  migrationTables,
  moduleDirsOf,
  moduleOf,
  parseModuleMap,
  sqlTablesIn,
  sqlViolations,
} from "../boundaries.mjs";

const A = "apps/api/src";
const f = (rel) => `${A}/${rel}`;

const MAP = parseModuleMap(
  {
    version: 1,
    shared: ["common"],
    sharedTables: ["audit_events"],
    modules: {
      shifts: { tables: ["shifts"] },
      stores: { tables: ["stores"] },
      offers: { tables: ["offers"], publicFiles: ["offer-pack.rebuild.ts"] },
    },
  },
  ["shifts", "stores", "offers", "common", "consumer"],
);

const run = (sources, check) => check(Object.keys(sources), (rel) => sources[rel], MAP);

test("moduleOf: top-level directory, (root) for src files, null outside apps/api/src", () => {
  assert.equal(moduleOf(f("shifts/deep/x.ts")), "shifts");
  assert.equal(moduleOf(f("app.module.ts")), "(root)");
  assert.equal(moduleOf("apps/worker/src/x.ts"), null);
});

test("isPublicFile: index.ts, a root *.module.ts and an explicit publicFiles entry; nothing else", () => {
  assert.equal(isPublicFile(f("shifts/index.ts"), "shifts", MAP), true);
  assert.equal(isPublicFile(f("shifts/shifts.module.ts"), "shifts", MAP), true);
  assert.equal(isPublicFile(f("offers/offer-pack.rebuild.ts"), "offers", MAP), true);
  assert.equal(isPublicFile(f("shifts/shift.service.ts"), "shifts", MAP), false);
  assert.equal(isPublicFile(f("shifts/deep/inner.module.ts"), "shifts", MAP), false, "only a module file at the module root is wiring");
  assert.equal(isPublicFile(f("shifts/deep/index.ts"), "shifts", MAP), false, "only the root barrel is the port");
});

test("a deep import of another module's internal file fails; a port import does not", () => {
  const sources = {
    [f("shifts/shift.service.ts")]: ``,
    [f("shifts/index.ts")]: `export * from "./shift.service";`,
    [f("shifts/shifts.module.ts")]: ``,
    [f("consumer/deep.ts")]: `import { x } from "../shifts/shift.service";`,
    [f("consumer/port.ts")]: `import { x } from "../shifts";`,
    [f("consumer/port-index.ts")]: `import { x } from "../shifts/index";`,
    [f("consumer/wiring.ts")]: `import { ShiftsModule } from "../shifts/shifts.module";`,
  };
  assert.deepEqual(run(sources, importViolations), { [`${f("consumer/deep.ts")} -> ${f("shifts/shift.service.ts")}`]: 1 });
});

test("every import form counts, type-only included: re-export, dynamic import, require, import type", () => {
  const sources = {
    [f("shifts/a.ts")]: ``,
    [f("consumer/reexport.ts")]: `export { a } from "../shifts/a";`,
    [f("consumer/dynamic.ts")]: `const m = () => import("../shifts/a");`,
    [f("consumer/required.ts")]: `const m = require("../shifts/a");`,
    [f("consumer/type.ts")]: `import type { A } from "../shifts/a";`,
    [f("consumer/type-position.ts")]: `export type T = import("../shifts/a").A;`,
  };
  assert.deepEqual(
    Object.keys(run(sources, importViolations)).map((k) => k.split(" -> ")[0]),
    ["reexport", "dynamic", "required", "type", "type-position"].map((n) => f(`consumer/${n}.ts`)).sort(),
  );
});

test("same-module imports, shared modules, the composition root and non-api files are never violations", () => {
  const sources = {
    [f("shifts/a.ts")]: ``,
    [f("shifts/deep/b.ts")]: `import "../a";`,
    [f("common/util.ts")]: ``,
    [f("consumer/c.ts")]: `import "../common/util";`,
    [f("app.module.ts")]: `import "./shifts/a";`,
    [f("main.ts")]: `import "./app.module";`,
    [f("consumer/d.ts")]: `import "../app.module"; import "@nestjs/common"; import "./missing";`,
  };
  assert.deepEqual(run(sources, importViolations), {});
});

test("occurrences are counted per import statement and per SQL mention", () => {
  const sources = {
    [f("shifts/a.ts")]: ``,
    [f("consumer/many.ts")]: `import { a } from "../shifts/a"; import type { B } from "../shifts/a"; export * from "../shifts/a";
      const q1 = "SELECT 1 FROM shifts"; const q2 = "UPDATE shifts SET a = 1";`,
  };
  assert.deepEqual(run(sources, importViolations), { [`${f("consumer/many.ts")} -> ${f("shifts/a.ts")}`]: 3 });
  assert.deepEqual(run(sources, sqlViolations), { [`${f("consumer/many.ts")} :: shifts`]: 2 });
});

test("sqlTablesIn: reads string and template literals after upper-case SQL keywords, not prose or comments", () => {
  const src = `
    // FROM shifts in a comment
    const a = "SELECT 1 FROM shifts s JOIN public.stores st ON true";
    const b = \`UPDATE offers SET x = 1; INSERT INTO "audit_events" (a) VALUES ($1)\`;
    const c = \`SELECT 1 FROM \${table} JOIN devices d ON true\`;
    const msg = "cannot delete from shifts";
    const d = "DELETE FROM ONLY stores";
    const e = "SELECT 1 FROM app.shifts";
  `;
  assert.deepEqual(Object.fromEntries(sqlTablesIn(src)), { shifts: 2, stores: 2, offers: 1, audit_events: 1, devices: 1 });
});

test("a raw SQL reference to another module's table fails; own, shared and undeclared tables do not", () => {
  const sources = {
    [f("stores/facts.ts")]: `const q = "SELECT 1 FROM shifts WHERE id = $1"; const own = "SELECT 1 FROM stores";`,
    [f("stores/audit.ts")]: `const q = "INSERT INTO audit_events (a) VALUES ($1)"; const tmp = "SELECT 1 FROM some_cte";`,
    [f("shifts/own.ts")]: `const q = "SELECT 1 FROM shifts";`,
    [f("app.module.ts")]: `const q = "SELECT 1 FROM shifts";`,
  };
  assert.deepEqual(run(sources, sqlViolations), { [`${f("stores/facts.ts")} :: shifts`]: 1 });
});

test("parseModuleMap rejects a stale directory, a doubly-owned table and a table both shared and owned", () => {
  const dirs = ["a", "b"];
  assert.throws(() => parseModuleMap({ version: 1, shared: [], modules: { gone: { tables: [] } } }, dirs), /module "gone" is not a directory/);
  assert.throws(() => parseModuleMap({ version: 1, shared: ["gone"], modules: {} }, dirs), /shared module "gone"/);
  assert.throws(
    () => parseModuleMap({ version: 1, modules: { a: { tables: ["t"] }, b: { tables: ["t"] } } }, dirs),
    /owned by both "a" and "b"/,
  );
  assert.throws(() => parseModuleMap({ version: 1, sharedTables: ["t"], modules: { a: { tables: ["t"] } } }, dirs), /both shared and owned/);
});

test("parseModuleMap rejects malformed shapes, bad names, a missing publicFiles file and a shared/module clash", () => {
  const dirs = ["a", "b"];
  const bad = (raw, re, opts) => assert.throws(() => parseModuleMap({ version: 1, ...raw }, dirs, opts), re);
  bad({ modules: { a: { tables: "shifts" } } }, /tables must be an array of strings/);
  bad({ modules: [] }, /modules must be an object/);
  bad({ shared: "a", modules: {} }, /shared must be an array of strings/);
  bad({ modules: { a: { tables: ["t", "t"] } } }, /listed twice in module "a"/);
  bad({ modules: { a: { tables: ["Shifts"] } } }, /not a lower-case table name/);
  bad({ modules: { a: { tables: ["public.shifts"] } } }, /not a lower-case table name/);
  bad({ shared: ["a"], modules: { a: { tables: [] } } }, /both a shared module and a module with tables/);
  bad({ modules: { a: { publicFiles: ["x.ts"] } } }, /publicFiles "x.ts" does not exist/, { files: [] });
  bad({ unownedTables: ["t"], modules: { a: { tables: ["t"] } } }, /unownedTables but also owned/);
  assert.doesNotThrow(() => parseModuleMap({ version: 1, modules: { a: { publicFiles: ["x.ts"] } } }, dirs, { files: [f("a/x.ts")] }));
});

test("completeness: a migration table nobody owns fails, a declared table no migration creates fails", () => {
  const raw = { version: 1, sharedTables: ["audit_events"], unownedTables: ["legacy"], modules: { a: { tables: ["shifts"] } } };
  const dirs = ["a"];
  assert.doesNotThrow(() => parseModuleMap(raw, dirs, { migrationTables: ["shifts", "audit_events", "legacy"] }));
  assert.throws(() => parseModuleMap(raw, dirs, { migrationTables: ["shifts", "audit_events", "legacy", "new_table"] }), /"new_table" is created by a migration but is not owned/);
  assert.throws(() => parseModuleMap(raw, dirs, { migrationTables: ["shifts", "audit_events"] }), /"legacy" is declared but no migration creates it/);
});

test("compareToBaseline: a new key or a higher count fails, a stale key or a lower count fails, equal passes", () => {
  assert.deepEqual(compareToBaseline({ a: 1, b: 1 }, { a: 1 }), { added: [{ key: "b", current: 1, baseline: 0 }], stale: [] });
  assert.deepEqual(compareToBaseline({ a: 3 }, { a: 2 }), { added: [{ key: "a", current: 3, baseline: 2 }], stale: [] });
  assert.deepEqual(compareToBaseline({ a: 1 }, { a: 2 }), { added: [], stale: [{ key: "a", current: 1, baseline: 2 }] });
  assert.deepEqual(compareToBaseline({}, { gone: 1 }), { added: [], stale: [{ key: "gone", current: 0, baseline: 1 }] });
  assert.deepEqual(compareToBaseline({ a: 1 }, { a: 1 }), { added: [], stale: [] });
});

test("the checked-in module map is valid and complete against the real tree and migrations", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..", "..", "..");
  const files = listSourceFiles(root);
  const raw = JSON.parse(readFileSync(path.join(here, "..", "module-map.json"), "utf8"));
  const tables = migrationTables(root);
  assert.ok(tables.length > 100, "the migrations must be found");
  assert.doesNotThrow(() => parseModuleMap(raw, moduleDirsOf(files), { files, migrationTables: tables }));
});

test("migrationTables leaves out a table a later up migration drops (also several in one DROP), and keeps a re-created one (RT-422)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mt-"));
  try {
    const dir = path.join(root, "packages", "db", "drizzle");
    mkdirSync(dir, { recursive: true });
    const lines = (...l) => `${l.join("\n")}\n`;
    writeFileSync(path.join(dir, "0001_a.sql"), lines("CREATE TABLE kept (id uuid);", "CREATE TABLE gone (id uuid);", "CREATE TABLE again (id uuid);", "CREATE TABLE gone2 (id uuid);", "CREATE TABLE gone3 (id uuid);", "CREATE TABLE recycled (id uuid);"));
    writeFileSync(path.join(dir, "0002_b.sql"), lines("-- DROP TABLE kept (a comment drops nothing)", "DROP TABLE gone;", "DROP TABLE IF EXISTS public.again;", "DROP TABLE gone2, public.gone3 CASCADE;", "DROP TABLE recycled;", "CREATE TABLE recycled (id uuid);"));
    writeFileSync(path.join(dir, "0003_c.sql"), lines("CREATE TABLE again (id uuid);"));
    writeFileSync(path.join(dir, "0003_c.down.sql"), lines("DROP TABLE again;"));
    assert.deepEqual(migrationTables(root), ["again", "kept", "recycled"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- the CLI, on a scratch package tree: pins the exit codes and the shrink-only guarantee ----
const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_ROOT = path.resolve(TOOLS, "..");

function scratchPackage(srcFiles, baseline) {
  const root = mkdtempSync(path.join(tmpdir(), "mb-"));
  symlinkSync(path.join(REAL_ROOT, "node_modules"), path.join(root, "node_modules")); // `typescript`
  mkdirSync(path.join(root, "tools"), { recursive: true });
  cpSync(path.join(TOOLS, "import-cycles", "cycles.mjs"), path.join(root, "tools", "import-cycles", "cycles.mjs"), { recursive: true });
  const mb = path.join(root, "tools", "module-boundaries");
  mkdirSync(mb, { recursive: true });
  for (const n of ["boundaries.mjs", "check.mjs"]) cpSync(path.join(TOOLS, "module-boundaries", n), path.join(mb, n));
  writeFileSync(
    path.join(mb, "module-map.json"),
    JSON.stringify({ version: 1, shared: [], modules: { shifts: { tables: ["shifts"] }, stores: { tables: ["stores"] } } }),
  );
  writeFileSync(path.join(mb, "baseline.json"), JSON.stringify({ version: 1, ...baseline }));
  mkdirSync(path.join(root, "packages", "db", "drizzle"), { recursive: true });
  writeFileSync(path.join(root, "packages", "db", "drizzle", "0000_init.sql"), "CREATE TABLE shifts (id uuid);\nCREATE TABLE IF NOT EXISTS stores (id uuid);\n");
  for (const [rel, text] of Object.entries(srcFiles)) {
    mkdirSync(path.dirname(path.join(root, A, rel)), { recursive: true });
    writeFileSync(path.join(root, A, rel), text);
  }
  const run = (...args) => spawnSync(process.execPath, [path.join(mb, "check.mjs"), ...args], { encoding: "utf8" });
  const baselineText = () => readFileSync(path.join(mb, "baseline.json"), "utf8");
  return { root, run, baselineText, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("CLI: exit 0 on a match, 1 on a new violation, 1 on a stale line, --update never grows and shrinks a stale one", () => {
  const src = { "shifts/a.ts": ``, "stores/s.ts": `import "../shifts/a"; const q = "SELECT 1 FROM shifts";` };
  const sqlKey = `${f("stores/s.ts")} :: shifts`;
  const impKey = `${f("stores/s.ts")} -> ${f("shifts/a.ts")}`;
  const exact = scratchPackage(src, { imports: { [impKey]: 1 }, sql: { [sqlKey]: 1 } });
  const grown = scratchPackage(src, { imports: { [impKey]: 1 }, sql: {} });
  const stale = scratchPackage(src, { imports: { [impKey]: 1 }, sql: { [sqlKey]: 1, [`${f("gone.ts")} :: shifts`]: 1 } });
  const bad = scratchPackage(src, { imports: [] });
  try {
    assert.equal(exact.run().status, 0);

    const newViolation = grown.run();
    assert.equal(newViolation.status, 1);
    assert.match(newViolation.stderr, /1 new violation\(s\)/);
    const before = grown.baselineText();
    assert.equal(grown.run("--update").status, 1, "--update refuses while a violation is new");
    assert.equal(grown.baselineText(), before, "a refused --update leaves the baseline untouched");

    const staleRun = stale.run();
    assert.equal(staleRun.status, 1);
    assert.match(staleRun.stderr, /no longer match a violation/);
    assert.equal(stale.run("--update").status, 0);
    assert.deepEqual(JSON.parse(stale.baselineText()).sql, { [sqlKey]: 1 });
    assert.equal(stale.run().status, 0);

    assert.equal(bad.run().status, 2, "an unreadable baseline is exit 2");
  } finally {
    for (const p of [exact, grown, stale, bad]) p.cleanup();
  }
});
