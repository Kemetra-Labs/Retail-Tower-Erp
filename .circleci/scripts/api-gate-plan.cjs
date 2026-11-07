#!/usr/bin/env node
// RT-1258 (owner decision, RT-1258 comment 15863): the plan of the split API Jest gate. The scope job
// (api-jest-scope) writes /tmp/gate/plan/plan.json with tia-canary-select.cjs: FULL (every spec, merged
// coverage against the jest.config.cjs floors, as before) or IMPACTED (the specs impact analysis
// selected, plus the guard's must-run specs, plus every text-reading spec). This file is the one place
// that judges a plan, shared by the shards (which spec list to split) and the fan-in (which inventory
// the run must have covered). Every doubt is FULL: a missing, unreadable, stale or inconsistent plan
// never narrows the run. Nothing here selects tests; it only decides whether the selector's IMPACTED
// plan is acceptable.
//
//   structural checks (shards and fan-in, no git needed):
//     plan.mode IMPACTED, plan.sha is this commit, the guard that fed it said TIA_ELIGIBLE on this
//     commit, atoms are unique spec paths, all discovered, strictly fewer than discovered, and every
//     must-run spec is among them.
//   independent checks (fan-in only, against a risk guard it re-ran itself on the same checkout):
//     the guard still says TIA_ELIGIBLE on this commit, the must-run lists agree, and every spec file
//     the PR adds or modifies is in the atoms.
//
// usage: api-gate-plan.cjs select <plan.json> <discovered.txt> <head sha> <atoms-out>
//   prints IMPACTED or FULL (reasons on stderr), writes the atoms for IMPACTED, always exits 0.
"use strict";
const fs = require("node:fs");

const API_PREFIX = "services/backend-core/apps/api/";
const SHA_RE = /^[0-9a-f]{40}$/;
// A discovered atom is a plain relative spec path (same shape as tia-canary-select.cjs).
const ATOM_RE = /^(?!-)(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/@+]+\.spec\.ts$/;

const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const isStrings = (a) => Array.isArray(a) && a.every((x) => typeof x === "string");

// Structural problems of an IMPACTED plan against this commit and the discovered spec list.
function planProblems(plan, head, discovered) {
  const p = [];
  if (!plan || typeof plan !== "object") return ["plan is not an object"];
  if (plan.mode !== "IMPACTED") p.push(`plan mode is ${JSON.stringify(plan.mode)}, not IMPACTED`);
  if (!SHA_RE.test(head || "")) p.push("head sha missing or malformed");
  if (plan.sha !== head) p.push(`plan is for ${plan.sha ?? "no commit"}, not ${head}`);
  if (plan.guard?.decision !== "TIA_ELIGIBLE") p.push(`plan guard decision is ${plan.guard?.decision ?? "missing"}`);
  if (plan.guard?.head !== head) p.push(`plan guard ran on ${plan.guard?.head ?? "no commit"}, not ${head}`);
  if (!isStrings(plan.atoms) || plan.atoms.length === 0) {
    p.push("plan atoms are missing, not strings, or empty");
    return p;
  }
  if (!isStrings(plan.mustRun)) p.push("plan must-run list is missing or not strings");
  const atoms = new Set(plan.atoms);
  if (atoms.size !== plan.atoms.length) p.push("plan lists a spec twice");
  const known = new Set(discovered);
  const bad = plan.atoms.find((a) => !ATOM_RE.test(a));
  if (bad !== undefined) p.push(`plan atom with an unexpected shape: ${JSON.stringify(bad)}`);
  const unknown = plan.atoms.filter((a) => !known.has(a));
  if (unknown.length) p.push(`${unknown.length} planned spec(s) are not discovered, first: ${unknown[0]}`);
  if (known.size === 0) p.push("no discovered spec list");
  if (atoms.size >= known.size) p.push(`plan covers ${atoms.size} of ${known.size} specs: nothing is skipped, so it is not an impacted plan`);
  if (isStrings(plan.mustRun)) {
    const miss = plan.mustRun.filter((m) => !atoms.has(m));
    if (miss.length) p.push(`must-run spec(s) not planned: ${miss.join(", ")}`);
  }
  return p;
}

// Problems found by comparing the plan with a risk guard the fan-in ran itself (guard.json).
function independentProblems(plan, guard, head) {
  const p = [];
  if (!guard || typeof guard !== "object") return ["no independent risk guard result on this commit"];
  if (guard.decision !== "TIA_ELIGIBLE") p.push(`independent risk guard says ${guard.decision ?? "nothing"}${guard.reason ? `: ${guard.reason}` : ""}`);
  if (guard.head !== head) p.push(`independent risk guard ran on ${guard.head ?? "no commit"}, not ${head}`);
  if (!isStrings(guard.changed) || !isStrings(guard.mustRun)) {
    p.push("independent risk guard changed-path or must-run list is missing");
    return p;
  }
  const atoms = new Set(isStrings(plan?.atoms) ? plan.atoms : []);
  const changedSpecs = guard.changed.filter((c) => c.startsWith(API_PREFIX) && c.endsWith(".spec.ts")).map((c) => c.slice(API_PREFIX.length));
  const unplanned = changedSpecs.filter((s) => !atoms.has(s));
  if (unplanned.length) p.push(`changed spec(s) not in the plan: ${unplanned.join(", ")}`);
  const unplannedMust = guard.mustRun.filter((m) => !atoms.has(m));
  if (unplannedMust.length) p.push(`guard must-run spec(s) not in the plan: ${unplannedMust.join(", ")}`);
  const a = [...(isStrings(plan?.mustRun) ? plan.mustRun : [])].sort().join("\n");
  const b = [...guard.mustRun].sort().join("\n");
  if (a !== b) p.push("the plan's must-run list differs from the independent guard's");
  return p;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// What the shards run: the plan's atoms when the plan is a valid IMPACTED plan for this commit, else
// everything. `reason` explains a FULL.
function decide(planFile, discoveredFile, head) {
  const plan = readJson(planFile);
  if (plan === null) return { mode: "FULL", atoms: [], reason: "no readable plan" };
  if (plan.mode !== "IMPACTED") return { mode: "FULL", atoms: [], reason: `plan mode ${JSON.stringify(plan.mode)}` };
  let discovered = [];
  try {
    discovered = lines(fs.readFileSync(discoveredFile, "utf8"));
  } catch {
    return { mode: "FULL", atoms: [], reason: "no discovered spec list" };
  }
  const problems = planProblems(plan, head, discovered);
  if (problems.length) return { mode: "FULL", atoms: [], reason: problems.join("; ") };
  return { mode: "IMPACTED", atoms: plan.atoms, reason: `${plan.atoms.length} of ${discovered.length} specs` };
}

function main(argv) {
  const [cmd, planFile, discoveredFile, head, atomsOut] = argv;
  if (cmd !== "select") {
    console.error("usage: api-gate-plan.cjs select <plan.json> <discovered.txt> <head sha> <atoms-out>");
    console.log("FULL");
    return 0;
  }
  let result;
  try {
    result = decide(planFile, discoveredFile, head);
  } catch (e) {
    result = { mode: "FULL", atoms: [], reason: `error: ${e.message}` };
  }
  console.error(`API gate plan for the shards: ${result.mode} (${result.reason})`);
  if (result.mode === "IMPACTED") {
    try {
      fs.writeFileSync(atomsOut, `${result.atoms.join("\n")}\n`);
    } catch (e) {
      console.error(`could not write ${atomsOut}: ${e.message}; FULL`);
      console.log("FULL");
      return 0;
    }
  }
  console.log(result.mode);
  return 0;
}

module.exports = { API_PREFIX, ATOM_RE, planProblems, independentProblems, decide, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
