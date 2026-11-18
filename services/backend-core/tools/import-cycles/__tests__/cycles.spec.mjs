// RT-1454: pins the import-cycle detector (tools/import-cycles/cycles.mjs) with fixtures.
// Run: node --test tools/import-cycles/__tests__/cycles.spec.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGraph,
  compareToBaseline,
  cyclicEdges,
  fileKey,
  findCycles,
  moduleKey,
  pathBack,
  resolveRelative,
  runtimeSpecifiers,
} from "../cycles.mjs";

const A = "apps/api/src";
const graphOf = (sources, key = fileKey) => buildGraph(Object.keys(sources), (rel) => sources[rel], key);

test("runtimeSpecifiers: runtime imports count, type-only ones do not", () => {
  const src = `
    import a from "./default";
    import { b } from "./named";
    import "./side-effect";
    import * as ns from "./ns";
    import type { T } from "./type-only";
    import type D from "./type-default";
    import { type X, type Y } from "./all-type-specifiers";
    import { type X2, v } from "./mixed";
    export { e } from "./reexport";
    export * from "./star";
    export type { F } from "./type-reexport";
    import eq = require("./equals");
    const lazy = () => import("./dynamic");
    const r = require("./required");
    import { z } from "@nestjs/common";
  `;
  assert.deepEqual(
    runtimeSpecifiers(src).sort(),
    ["./default", "./named", "./side-effect", "./ns", "./mixed", "./reexport", "./star", "./equals", "./dynamic", "./required", "@nestjs/common"].sort(),
  );
});

test("resolveRelative: file, index, .js suffix; bare and unknown specifiers are not followed", () => {
  const set = new Set([`${A}/a/x.ts`, `${A}/b/index.ts`, `${A}/c.ts`]);
  assert.equal(resolveRelative(`${A}/a/y.ts`, "./x", set), `${A}/a/x.ts`);
  assert.equal(resolveRelative(`${A}/a/y.ts`, "../b", set), `${A}/b/index.ts`);
  assert.equal(resolveRelative(`${A}/a/y.ts`, "../c.js", set), `${A}/c.ts`);
  assert.equal(resolveRelative(`${A}/a/y.ts`, "@nestjs/common", set), null);
  assert.equal(resolveRelative(`${A}/a/y.ts`, "./missing", set), null);
});

test("file graph: a file cycle is found, a chain is not", () => {
  const cyc = graphOf({ [`${A}/a.ts`]: `import "./b";`, [`${A}/b.ts`]: `import "./c";`, [`${A}/c.ts`]: `import "./a";` });
  assert.deepEqual(findCycles(cyc), [[`${A}/a.ts`, `${A}/b.ts`, `${A}/c.ts`]]);
  const chain = graphOf({ [`${A}/a.ts`]: `import "./b";`, [`${A}/b.ts`]: `import "./c";`, [`${A}/c.ts`]: `` });
  assert.deepEqual(findCycles(chain), []);
});

test("a type-only back edge is not a cycle; a value back edge is", () => {
  const typeOnly = graphOf({ [`${A}/a.ts`]: `import { b } from "./b";`, [`${A}/b.ts`]: `import type { A } from "./a";` });
  assert.deepEqual(findCycles(typeOnly), []);
  const value = graphOf({ [`${A}/a.ts`]: `import { b } from "./b";`, [`${A}/b.ts`]: `import { A } from "./a";` });
  assert.equal(findCycles(value).length, 1);
});

test("a self-import is a cycle", () => {
  assert.deepEqual(findCycles(graphOf({ [`${A}/a.ts`]: `import "./a";` })), [[`${A}/a.ts`]]);
});

// The RT-1454 shape: no file imports back, only the two directories do.
const RT1454 = {
  [`${A}/stores/deletion/store-deletion.service.ts`]: `import { cap } from "../../console-force-actions/force-action-cap";`,
  [`${A}/console-force-actions/force-action-cap.ts`]: `import { E } from "../stores/deletion/console-429";`,
  [`${A}/stores/deletion/console-429.ts`]: `export class E {}`,
};

test("moduleKey: top-level dir under src, src-root files share (root)", () => {
  assert.equal(moduleKey(`${A}/stores/deletion/x.ts`), `${A}/stores`);
  assert.equal(moduleKey(`${A}/stores/x.ts`), `${A}/stores`);
  assert.equal(moduleKey(`${A}/main.ts`), `${A}/(root)`);
  assert.equal(moduleKey("apps/worker/src/outbox/y/z.ts"), "apps/worker/src/outbox");
});

test("the RT-1454 cycle is invisible to the file graph and found by the module graph", () => {
  assert.deepEqual(findCycles(graphOf(RT1454)), []);
  const g = graphOf(RT1454, moduleKey);
  assert.deepEqual(cyclicEdges(g), [
    `${A}/console-force-actions -> ${A}/stores`,
    `${A}/stores -> ${A}/console-force-actions`,
  ]);
});

test("moving the shared code to a neutral module removes the cycle", () => {
  const fixed = {
    [`${A}/stores/deletion/store-deletion.service.ts`]: `import { cap } from "../../console-action-cap/force-action-cap";`,
    [`${A}/console-force-actions/service.ts`]: `import { cap } from "../console-action-cap/force-action-cap";`,
    [`${A}/console-action-cap/force-action-cap.ts`]: `import { E } from "./console-429";`,
    [`${A}/console-action-cap/console-429.ts`]: `export class E {}`,
  };
  assert.deepEqual(cyclicEdges(graphOf(fixed, moduleKey)), []);
});

test("compareToBaseline: a new edge fails even inside an already-cyclic group; a fixed one is stale", () => {
  const base = ["a -> b", "b -> a"];
  assert.deepEqual(compareToBaseline(["a -> b", "b -> a"], base), { added: [], stale: [] });
  assert.deepEqual(compareToBaseline(["a -> b", "b -> a", "a -> c", "c -> a"], base).added, ["a -> c", "c -> a"]);
  assert.deepEqual(compareToBaseline([], base), { added: [], stale: ["a -> b", "b -> a"] });
});

test("pathBack: the import path that closes a new edge", () => {
  const g = new Map([["a", new Set(["b"])], ["b", new Set(["c"])], ["c", new Set(["a"])]]);
  assert.deepEqual(pathBack(g, "c", "a"), ["a", "b", "c"]);
  assert.equal(pathBack(new Map([["a", new Set()], ["b", new Set()]]), "a", "b"), null);
});

test("findCycles survives a long chain (iterative, no stack overflow)", () => {
  const g = new Map();
  const n = 20000;
  for (let i = 0; i < n; i += 1) g.set(`n${i}`, new Set(i + 1 < n ? [`n${i + 1}`] : [`n0`]));
  const cycles = findCycles(g);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].length, n);
});
