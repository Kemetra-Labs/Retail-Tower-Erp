// RT-1454: circular-import detection for Backend-Core (`apps/*/src`).
//
// Pure functions only (no CLI, no process exit); `check.mjs` is the CLI and `__tests__/` pins
// both. No new dependency: imports are read with the `typescript` compiler API that the package
// already carries (the parser, no type-checker, so it is fast and needs no tsconfig).
//
// What counts as an edge: a RUNTIME import between two files of the scanned tree, i.e. a static
// `import`, `export ... from`, `import x = require()`, a dynamic `import("...")` or a
// `require("...")` with a string literal. Imports written as TYPE-ONLY (`import type`,
// `export type ... from`, or a clause whose every specifier is `type`) are ignored. An import that
// is only USED as a type but not written type-only still counts: this check does not run the type
// checker, and such an edge is still an ownership cycle. Bare specifiers (`@nestjs/common`,
// `@data-pulse-2/shared`) are other packages and are not followed.
//
// Granularity: the graph is built over node keys. `fileKey` (one node per file) finds file cycles.
// `moduleKey` (one node per top-level directory under `apps/<app>/src`, files directly in `src`
// share a `(root)` node) finds module cycles: two features that import each other through
// different files. That is the RT-1454 cycle (`stores/deletion` <-> `console-force-actions`); no
// file in it imports back, so only the module graph sees it. `findCycles` and the baseline logic
// are the same for every key. RT-1456 can refine the module key or add one without touching them.
//
// Baseline unit: an EDGE that lies on a cycle (both ends in one strongly connected component),
// written `from -> to`. A new such edge fails even inside a group that already cycles, so a
// baselined tangle cannot grow; fixing an edge makes its baseline line stale (shrink with --update).

import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/** Node key = the file itself (posix path relative to the package root). */
export const fileKey = (relFile) => relFile;

/** Node key = the top-level directory of the file under `apps/<app>/src` (or `<src>/(root)`). */
export function moduleKey(relFile) {
  const parts = relFile.split("/"); // apps/<app>/src/<dir>/.../<file>
  return parts.length <= 4 ? `${parts.slice(0, 3).join("/")}/(root)` : parts.slice(0, 4).join("/");
}

/** Every `.ts` source file (no `.d.ts`) under each `apps/<app>/src`, as posix paths relative to `root`. */
export function listSourceFiles(root) {
  const out = [];
  const walk = (dirAbs, dirRel) => {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      const rel = `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dirAbs, entry.name), rel);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(rel);
    }
  };
  let apps = [];
  try {
    apps = readdirSync(path.join(root, "apps"), { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return out;
  }
  for (const app of apps.sort((a, b) => a.name.localeCompare(b.name))) {
    const src = path.join(root, "apps", app.name, "src");
    try {
      walk(src, `apps/${app.name}/src`);
    } catch {
      // an app without a src directory has nothing to scan
    }
  }
  return out.sort();
}

const isTypeOnlyClause = (clause) => {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const named = clause.namedBindings;
  // `import { type A, type B } from` has no runtime effect; a default import or a value specifier does.
  return !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
};

/** Module specifiers a file loads at runtime (see the header for what counts). */
export function runtimeSpecifiers(sourceText, fileName = "x.ts") {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyClause(node.importClause)) found.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause;
      const typeOnly =
        node.isTypeOnly || (named && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) found.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      found.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        found.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Resolve a relative specifier from `fromRel` to a file in `fileSet`, or null (not relative, or not in the tree). */
export function resolveRelative(fromRel, specifier, fileSet) {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
  const stripped = base.replace(/\.(m|c)?js$/, "");
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${stripped}.ts`, `${base}/index.ts`]) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Edges between node keys. `readSource(rel)` returns a file's text. Self-edges between two files of
 * one node are dropped (they matter only when a coarser `nodeKey` than `fileKey` is used).
 * @returns {Map<string, Set<string>>} adjacency, every node present as a key.
 */
export function buildGraph(files, readSource, nodeKey = fileKey) {
  const fileSet = new Set(files);
  const graph = new Map();
  for (const f of files) if (!graph.has(nodeKey(f))) graph.set(nodeKey(f), new Set());
  for (const from of files) {
    for (const spec of runtimeSpecifiers(readSource(from), from)) {
      const to = resolveRelative(from, spec, fileSet);
      if (to === null) continue;
      const a = nodeKey(from);
      const b = nodeKey(to);
      if (a !== b || nodeKey === fileKey) graph.get(a).add(b);
    }
  }
  return graph;
}

/**
 * Strongly connected components that are real cycles (size > 1, or a self-import), Tarjan,
 * iterative so a deep import chain cannot overflow the stack. Each component's keys are sorted;
 * components are sorted by their first key, so the output is deterministic.
 * @returns {string[][]}
 */
export function findCycles(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = [];
  let counter = 0;
  const nodes = [...graph.keys()].sort();
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work = [[root, [...(graph.get(root) ?? [])].sort(), 0]];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [v, succ] = frame;
      if (frame[2] < succ.length) {
        const w = succ[frame[2]++];
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push([w, [...(graph.get(w) ?? [])].sort(), 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
        if (low.get(v) === index.get(v)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          if (comp.length > 1 || graph.get(v)?.has(v)) result.push(comp.sort());
        }
      }
    }
  }
  return result.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Every edge on a cycle, as sorted `from -> to` strings (both ends in one cyclic component). */
export function cyclicEdges(graph) {
  const out = [];
  for (const comp of findCycles(graph)) {
    const inComp = new Set(comp);
    for (const from of comp) for (const to of graph.get(from) ?? []) if (inComp.has(to)) out.push(`${from} -> ${to}`);
  }
  return out.sort();
}

/** A shortest import path from `to` back to `from` (so with the edge itself it is a cycle), or null. */
export function pathBack(graph, from, to) {
  const prev = new Map([[to, null]]);
  const queue = [to];
  while (queue.length > 0) {
    const v = queue.shift();
    if (v === from) {
      const chain = [];
      for (let cur = v; cur !== null; cur = prev.get(cur)) chain.unshift(cur);
      return chain;
    }
    for (const w of [...(graph.get(v) ?? [])].sort()) {
      if (!prev.has(w)) {
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  return null;
}

/**
 * Shrink-only comparison of edge strings. `added`: on a cycle now, not in the baseline (fails).
 * `stale`: in the baseline, no longer on a cycle (fixed; the baseline can shrink).
 */
export function compareToBaseline(current, baseline) {
  const cur = new Set(current);
  const base = new Set(baseline);
  return { added: current.filter((e) => !base.has(e)), stale: baseline.filter((e) => !cur.has(e)) };
}
