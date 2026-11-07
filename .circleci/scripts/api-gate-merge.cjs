#!/usr/bin/env node
// RT-1258: fan-in of the split API Jest gate. The shards of job api-jest-shard (CircleCI
// timing-based test splitting, parallelism N) each ran their share of the suite with
// `--coverage --coverageReporters=json` and NO per-node thresholds, then persisted
// nodes/<index>/{sha, total, discovered.txt, assigned.txt, api-jest.json, coverage-final.json}.
// This script is the only place the suite's verdict is formed, and every doubt fails:
//   - exactly CIRCLE_NODE_TOTAL nodes 0..N-1, all on the same commit as this job;
//   - every node discovered the same non-empty spec list, the assignments are pairwise disjoint
//     and their union is exactly that list (complete inventory, nothing run twice);
//   - every node's Jest run is complete for its assignment (api-gate-complete.cjs check);
//   - the per-node istanbul coverage maps merge (same instrumentation) and the MERGED summary
//     meets jest.config.cjs coverageThreshold.global exactly as Jest judges it (istanbul pct,
//     truncated to 2 decimals; negative values cap uncovered items). Any other threshold key
//     fails closed rather than being ignored.
// No dependencies (the fan-in job installs nothing). The summary follows istanbul-lib-coverage
// (statements, functions, branches per counter; lines from each statement's start line), pinned in
// CI by a real Jest fixture (two shard maps vs Jest's own full-run summary) and, locally, against
// istanbul-lib-coverage when it is installed.
//
// RT-1258 (owner decision, comment 15863): the run may be IMPACTED. When the scope job's plan
// (<workspace>/plan/plan.json, api-gate-plan.cjs) is a valid IMPACTED plan for this commit AND a risk
// guard re-run by this job (<workspace>/fanin-guard/guard.json) independently agrees, the inventory the
// shards must have covered is exactly the plan's specs, once each, and the global coverage floors are
// NOT evaluated (a selective run cannot measure them; the full suite on main enforces them). A missing,
// unreadable, stale or inconsistent plan means FULL: every discovered spec, merged coverage vs the
// floors, exactly as before. A plan the shards would also have rejected is FULL here too, so the two
// never disagree; only a disagreement with the independent guard fails the gate.
//
// usage: api-gate-merge.cjs <workspace dir> <jest.config.cjs> <head sha>   exit 0 pass, 1 fail
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { check: checkComplete } = require("./api-gate-complete.cjs");
const plans = require("./api-gate-plan.cjs");

const KEYS = ["statements", "branches", "functions", "lines"];

function mergeCoverage(maps) {
  const out = {};
  for (const map of maps) {
    for (const [file, fc] of Object.entries(map || {})) {
      const cur = out[file];
      if (!cur) {
        out[file] = JSON.parse(JSON.stringify(fc));
        continue;
      }
      for (const [k, kind] of [["s", "statementMap"], ["f", "fnMap"], ["b", "branchMap"]]) {
        if (JSON.stringify(cur[kind] || {}) !== JSON.stringify(fc[kind] || {})) {
          throw new Error(`coverage maps differ for ${file} (${kind}): instrumentation mismatch`);
        }
        for (const [id, v] of Object.entries(fc[k] || {})) {
          if (k === "b") {
            const prev = cur.b[id] || [];
            if (prev.length !== v.length) throw new Error(`branch arity differs for ${file} branch ${id}`);
            cur.b[id] = v.map((n, i) => (prev[i] || 0) + n);
          } else {
            cur[k][id] = (cur[k][id] || 0) + v;
          }
        }
      }
    }
  }
  return out;
}

// istanbul-lib-coverage percent(): truncated to two decimals, 100 when nothing to cover.
function percent(covered, total) {
  return total > 0 ? Math.floor((1000 * 100 * covered) / total / 10) / 100 : 100;
}

function summarize(map) {
  const t = Object.fromEntries(KEYS.map((k) => [k, { total: 0, covered: 0 }]));
  for (const fc of Object.values(map)) {
    for (const n of Object.values(fc.s || {})) {
      t.statements.total += 1;
      if (n > 0) t.statements.covered += 1;
    }
    for (const n of Object.values(fc.f || {})) {
      t.functions.total += 1;
      if (n > 0) t.functions.covered += 1;
    }
    for (const arr of Object.values(fc.b || {})) {
      for (const n of arr) {
        t.branches.total += 1;
        if (n > 0) t.branches.covered += 1;
      }
    }
    const lines = {};
    for (const [id, loc] of Object.entries(fc.statementMap || {})) {
      const line = loc.start.line;
      const n = (fc.s || {})[id] || 0;
      if (lines[line] === undefined || lines[line] < n) lines[line] = n;
    }
    for (const n of Object.values(lines)) {
      t.lines.total += 1;
      if (n > 0) t.lines.covered += 1;
    }
  }
  for (const k of KEYS) t[k].pct = percent(t[k].covered, t[k].total);
  return t;
}

// Jest's rule: a positive threshold is a minimum percentage, a negative one the maximum number of
// uncovered items. Only `global` is supported; anything else fails closed.
function checkThresholds(summary, threshold) {
  const problems = [];
  if (!threshold || typeof threshold !== "object" || !threshold.global) return ["no coverageThreshold.global in jest.config.cjs"];
  const extra = Object.keys(threshold).filter((k) => k !== "global");
  if (extra.length) problems.push(`unsupported coverageThreshold key(s): ${extra.join(", ")}`);
  for (const [k, v] of Object.entries(threshold.global)) {
    if (!KEYS.includes(k) || typeof v !== "number") {
      problems.push(`unsupported global threshold ${k}=${v}`);
      continue;
    }
    const s = summary[k];
    if (v >= 0 && s.pct < v) problems.push(`${k} ${s.pct}% < ${v}%`);
    if (v < 0 && s.total - s.covered > -v) problems.push(`${k} uncovered ${s.total - s.covered} > ${-v}`);
  }
  return problems;
}

const lines = (t) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// nodes: [{index, sha, total, discovered: [], assigned: [], result, coverage}]
// opts.expected: the specs the run must have covered exactly once (an IMPACTED plan's atoms); absent
// means every discovered spec, with coverage from every node that ran something.
function checkNodes(nodes, headSha, apiRoot, opts = {}) {
  const impacted = Array.isArray(opts.expected);
  const problems = [];
  if (!nodes.length) return ["no shard results in the workspace"];
  const total = nodes[0].total;
  if (!Number.isInteger(total) || total < 1) return [`bad node total ${nodes[0].total}`];
  const idx = nodes.map((n) => n.index).sort((a, b) => a - b);
  if (nodes.length !== total || idx.some((v, i) => v !== i)) {
    problems.push(`expected nodes 0..${total - 1}, got [${idx.join(",")}] (a failed shard persists nothing: see its job for the failure)`);
  }
  if (nodes.some((n) => n.total !== total)) problems.push("nodes disagree on CIRCLE_NODE_TOTAL");
  if (nodes.some((n) => n.sha !== headSha)) problems.push("a node ran on a different commit");
  const discovered = nodes[0].discovered;
  if (!discovered.length) problems.push("no spec discovered");
  if (nodes.some((n) => n.discovered.join("\n") !== discovered.join("\n"))) problems.push("nodes discovered different spec lists");
  const seen = new Map();
  for (const n of nodes) {
    for (const s of n.assigned) {
      if (seen.has(s)) problems.push(`spec assigned twice (nodes ${seen.get(s)} and ${n.index}): ${s}`);
      seen.set(s, n.index);
    }
    const p = n.assigned.length ? checkComplete(n.result, n.assigned, apiRoot) : [];
    for (const x of p) problems.push(`node ${n.index}: ${x}`);
    if (!impacted && n.assigned.length && !n.coverage) problems.push(`node ${n.index}: no coverage-final.json`);
  }
  const want = impacted ? opts.expected : discovered;
  const missing = want.filter((s) => !seen.has(s));
  if (missing.length) problems.push(`${missing.length} ${impacted ? "planned" : "discovered"} spec(s) assigned to no node, first: ${missing[0]}`);
  const foreign = [...seen.keys()].filter((s) => !want.includes(s));
  if (foreign.length) problems.push(`${foreign.length} assigned spec(s) not ${impacted ? "in the plan" : "discovered"}, first: ${foreign[0]}`);
  if (impacted) {
    const unknown = [...seen.keys()].filter((s) => !discovered.includes(s));
    if (unknown.length) problems.push(`${unknown.length} assigned spec(s) not discovered, first: ${unknown[0]}`);
  }
  return problems;
}

// What this run must have covered: { mode, atoms, problems, note }. IMPACTED only for a valid plan
// that the independent guard confirms; FULL for anything the shards would also treat as FULL.
function expectation(dir, headSha, discovered) {
  const planFile = path.join(dir, "plan", "plan.json");
  const plan = fs.existsSync(planFile) ? readJsonFile(planFile) : null;
  if (plan === null) return { mode: "FULL", atoms: null, problems: [], note: "no plan: full run" };
  if (plan.mode !== "IMPACTED") return { mode: "FULL", atoms: null, problems: [], note: `plan mode ${JSON.stringify(plan.mode)}: full run` };
  const structural = plans.planProblems(plan, headSha, discovered);
  if (structural.length) return { mode: "FULL", atoms: null, problems: [], note: `impacted plan not accepted, full run: ${structural.join("; ")}` };
  const guard = readJsonFile(path.join(dir, "fanin-guard", "guard.json"));
  const independent = plans.independentProblems(plan, guard, headSha);
  return {
    mode: "IMPACTED",
    atoms: plan.atoms,
    problems: independent.map((x) => `impacted plan rejected: ${x}`),
    note: `${plan.atoms.length} of ${discovered.length} specs`,
  };
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readNodes(dir) {
  const root = path.join(dir, "nodes");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((d) => /^\d+$/.test(d)).map((d) => {
    const p = (f) => path.join(root, d, f);
    const read = (f) => (fs.existsSync(p(f)) ? fs.readFileSync(p(f), "utf8") : null);
    const json = (f) => {
      try {
        return JSON.parse(read(f) ?? "null");
      } catch {
        return null;
      }
    };
    return {
      index: Number(d),
      sha: (read("sha") || "").trim(),
      total: Number((read("total") || "").trim()),
      discovered: lines(read("discovered.txt") || ""),
      assigned: lines(read("assigned.txt") || ""),
      result: json("api-jest.json"),
      coverage: json("coverage-final.json"),
    };
  });
}

function main(argv) {
  const [dir, jestConfig, headSha] = argv;
  const problems = [];
  let summary = null;
  let impacted = false;
  let note = "";
  try {
    if (!/^[0-9a-f]{40}$/.test(headSha || "")) throw new Error("head sha missing or malformed");
    const nodes = readNodes(dir);
    const exp = nodes.length ? expectation(dir, headSha, nodes[0].discovered) : { mode: "FULL", atoms: null, problems: [], note: "" };
    impacted = exp.mode === "IMPACTED";
    if (exp.note && !impacted) console.log(`API gate plan: ${exp.note}`);
    problems.push(...checkNodes(nodes, headSha, path.dirname(path.resolve(jestConfig)), impacted ? { expected: exp.atoms } : {}));
    problems.push(...exp.problems);
    if (impacted) note = exp.note;
    if (!problems.length && !impacted) {
      summary = summarize(mergeCoverage(nodes.map((n) => n.coverage)));
      delete require.cache[path.resolve(jestConfig)];
      problems.push(...checkThresholds(summary, require(path.resolve(jestConfig)).coverageThreshold));
    }
  } catch (e) {
    problems.push(`merge error: ${e.message}`);
  }
  if (summary) console.log(`merged coverage: ${KEYS.map((k) => `${k} ${summary[k].pct}% (${summary[k].covered}/${summary[k].total})`).join(", ")}`);
  if (problems.length) {
    console.log(`API gate FAILED: ${problems.join("; ")}`);
  } else if (impacted) {
    console.log(
      `API gate passed (IMPACTED run, ${note}): planned inventory complete, every planned spec green. Global coverage floors were NOT evaluated on this run: a selective run cannot measure them. The full suite on main enforces them.`,
    );
  } else {
    console.log("API gate passed: complete inventory, all specs green, coverage floors met");
  }
  return problems.length ? 1 : 0;
}

module.exports = { mergeCoverage, summarize, percent, checkThresholds, checkNodes, expectation, readNodes, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
