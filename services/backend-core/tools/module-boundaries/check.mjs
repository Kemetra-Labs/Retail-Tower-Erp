#!/usr/bin/env node
// RT-1453: fails when a source tree of Backend-Core (`apps/*/src`, RT-1525: api and worker) has a module-boundary violation that the
// shrink-only baseline `baseline.json` does not already list, or when the baseline lists one that
// is gone or counted fewer times. What counts (deep import of another module's internal file; raw SQL naming another
// module's table), the module map and the public-port convention are documented in boundaries.mjs
// and declared in module-map.json.
//
// Usage (from services/backend-core):
//   node tools/module-boundaries/check.mjs            check; exit 1 on a new or a stale baseline line
//   node tools/module-boundaries/check.mjs --update   rewrite the baseline to the current violations;
//                                                     refuses (exit 1) while any violation is new
// Wired into `pnpm lint:eslint` through `pnpm lint:module-boundaries`, so bc/fast (GitHub CI) and
// backend-fast (CircleCI) run it. Fix a violation by asking the owning module for a port (an
// `index.ts` export that takes the caller's PoolClient), never by adding a line to the baseline:
// that file may only shrink (a baseline edit that adds a line needs the owner's approval in the PR).
// A file that moves: rename its keys in baseline.json by hand in the same PR (no count may rise); the
// check then passes only if the renamed keys match the real violations exactly.
// Exit codes: 0 pass, 1 new/stale violation (or --update refused), 2 map or baseline unreadable or invalid
// (RT-1525: including a migration table with no owner, or a declared table a migration dropped or renamed).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listSourceFiles } from "../import-cycles/cycles.mjs";
import {
  compareToBaseline,
  importViolations,
  migrationHistory,
  moduleDirsOf,
  moduleOf,
  parseModuleMap,
  readFrom,
  sqlViolations,
} from "./boundaries.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const baselineFile = path.join(here, "baseline.json");
const KINDS = ["imports", "sql"];

const update = process.argv.includes("--update");
const files = listSourceFiles(root);
let map;
let baseline;
try {
  const history = migrationHistory(root);
  map = parseModuleMap(JSON.parse(readFileSync(path.join(here, "module-map.json"), "utf8")), moduleDirsOf(files), {
    files,
    migrationTables: history.live,
    goneTables: history.gone,
  });
  baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
  const isCounts = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((n) => Number.isInteger(n) && n > 0);
  if (baseline.version !== 1 || !KINDS.every((k) => isCounts(baseline[k]))) {
    throw new Error(`baseline.json must be { version: 1, ${KINDS.map((k) => `${k}: { "<key>": <count> }`).join(", ")} }`);
  }
} catch (err) {
  console.error(`module-boundaries: ${err.message}`);
  process.exit(2);
}

const readSource = readFrom(root);
const current = { imports: importViolations(files, readSource, map), sql: sqlViolations(files, readSource, map) };
const describe = {
  imports: (key) => {
    const [, to] = key.split(" -> ");
    return `"${moduleOf(to)}" exposes only its index.ts and *.module.ts: ask it for a port (index.ts) instead of importing its internals.`;
  },
  sql: (key) => {
    const [, table] = key.split(" :: ");
    return `table "${table}" belongs to "${map.tableOwner.get(table)}": ask that module for a port that runs the query on the caller's client.`;
  },
};

let failed = false;
let anyAdded = false;
const next = { version: 1 };
const notes = [];
for (const kind of KINDS) {
  const { added, stale } = compareToBaseline(current[kind], baseline[kind]);
  next[kind] = current[kind];
  if (added.length > 0) {
    failed = true;
    console.error(`module-boundaries (${kind}): ${added.length} new violation(s) in apps/*/src:`);
    for (const a of added) console.error(`  ${a.key} (now ${a.current}, baseline ${a.baseline})\n    ${describe[kind](a.key)}`);
  }
  if (stale.length > 0 && !update) {
    failed = true;
    console.error(`module-boundaries (${kind}): ${stale.length} baseline line(s) no longer match a violation (fixed, renamed or counted fewer times):`);
    for (const s of stale) console.error(`  ${s.key} (now ${s.current}, baseline ${s.baseline})`);
  }
  notes.push(`${kind}: ${Object.keys(current[kind]).length} baselined`);
  anyAdded ||= added.length > 0;
}

if (failed) {
  console.error(
    (anyAdded
      ? "\nFix a new violation with a port in the owning module (RT-1453). Never add it to tools/module-boundaries/baseline.json: that file may only shrink."
      : "\nA baseline line is stale (a violation was fixed or moved).") +
      " For a fixed violation, run `node tools/module-boundaries/check.mjs --update` in this PR; for a moved file, rename its keys by hand.",
  );
  process.exit(1);
}

if (update) {
  writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`module-boundaries: baseline rewritten (${notes.join("; ")}).`);
} else {
  console.log(`module-boundaries: OK, no new violation (${files.length} files; ${notes.join("; ")}).`);
}
