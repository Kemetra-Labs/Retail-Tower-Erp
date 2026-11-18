#!/usr/bin/env node
// RT-1454: fails when `apps/*/src` of Backend-Core has a circular runtime import that the
// shrink-only baseline `baseline.json` does not already list. What counts, the two granularities
// and the baseline unit are documented in cycles.mjs.
//
// Usage (from services/backend-core):
//   node tools/import-cycles/check.mjs            check; exit 1 on a new cycle edge
//   node tools/import-cycles/check.mjs --update   rewrite the baseline to the current cycle edges;
//                                                 refuses (exit 1) while any edge is new
// Wired into `pnpm lint:eslint` through `pnpm lint:cycles`, so bc/fast (GitHub CI) and
// backend-fast (CircleCI) run it. Fix a cycle by moving the shared code to a module both sides
// may import, never by adding it to the baseline: that file may only shrink (a baseline edit that
// adds an edge needs the owner's approval in the PR).
// Exit codes: 0 pass, 1 a new cycle edge (or --update refused), 2 the baseline could not be read.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildGraph, compareToBaseline, cyclicEdges, fileKey, listSourceFiles, moduleKey, pathBack } from "./cycles.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const baselineFile = path.join(here, "baseline.json");

/** The granularities checked, in report order. `name` is the baseline field. */
const MODES = [
  { name: "file", key: fileKey },
  { name: "module", key: moduleKey },
];

function readBaseline() {
  const parsed = JSON.parse(readFileSync(baselineFile, "utf8"));
  const ok = (v) => Array.isArray(v) && v.every((e) => typeof e === "string");
  if (parsed.version !== 1 || !MODES.every((m) => ok(parsed[m.name]))) {
    throw new Error(`baseline.json must be { version: 1, ${MODES.map((m) => `${m.name}: string[]`).join(", ")} }`);
  }
  return parsed;
}

const update = process.argv.includes("--update");
let baseline;
try {
  baseline = readBaseline();
} catch (err) {
  console.error(`import-cycles: cannot read baseline.json: ${err.message}`);
  process.exit(2);
}

const files = listSourceFiles(root);
const readSource = (rel) => readFileSync(path.join(root, rel), "utf8");
let failed = false;
const next = { version: 1 };
const notes = [];

for (const mode of MODES) {
  const graph = buildGraph(files, readSource, mode.key);
  const current = cyclicEdges(graph);
  const { added, stale } = compareToBaseline(current, baseline[mode.name]);
  next[mode.name] = current;
  if (added.length > 0) {
    failed = true;
    console.error(`import-cycles (${mode.name}): ${added.length} new import edge(s) on a cycle in apps/*/src:`);
    for (const edge of added) {
      const [from, to] = edge.split(" -> ");
      const back = pathBack(graph, from, to);
      console.error(`  ${edge}\n    closes: ${[from, ...(back ?? [to])].join(" -> ")}`);
    }
  }
  notes.push(
    `${mode.name}: ${current.length} cycle edge(s)` + (stale.length > 0 ? `, ${stale.length} baseline edge(s) fixed` : ""),
  );
  if (stale.length > 0) next.shrinkable = true;
}

if (failed) {
  console.error(
    "\nBreak the cycle: move the shared code to a module that both sides may import (RT-1454). " +
      "Do not add it to tools/import-cycles/baseline.json; that file may only shrink.",
  );
  process.exit(1);
}

if (update) {
  delete next.shrinkable;
  writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`import-cycles: baseline rewritten (${notes.join("; ")}).`);
} else {
  const hint = next.shrinkable ? " Run `node tools/import-cycles/check.mjs --update` in this PR to shrink the baseline." : "";
  console.log(`import-cycles: OK, no new cycle (${files.length} files; ${notes.join("; ")}).${hint}`);
}
