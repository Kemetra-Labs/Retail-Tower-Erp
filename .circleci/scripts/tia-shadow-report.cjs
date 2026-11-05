#!/usr/bin/env node
// RT-920 PR-4b: shadow-mode report for CircleCI test impact analysis. Compares the specs
// `circleci testsuite list-tests` would have selected with the full-suite JUnit report, and
// prints the selection ratio and every failing spec that was NOT selected (a miss). Misses must
// stay at 0 for impact analysis ever to be trusted.
//
// RT-1083: it also reports the GUARDED selection, the RT-1075 risk guard's decision applied
// (<outDir>/guard.json). FORCE_FULL means every spec would run, so no miss is possible;
// TIA_ELIGIBLE means the raw list-tests selection would run. A missing, unreadable, invalid or
// stale guard.json is FORCE_FULL_UNKNOWN: labelled, with misses null, never a measured pass.
// The raw fields are unchanged, so the raw-versus-guarded difference stays visible.
//
// Advisory only: this script never fails the job. Every problem is reported and it exits 0.
//
// usage: tia-shadow-report.cjs <selected.txt> <junit.xml> <outDir> <apiRootDir>
//   selected.txt   list-tests stdout; <outDir>/list-tests.rc holds its exit code
//   junit.xml      the converter's report, or a directory whose *.xml reports are all read
//                  (the CLI numbers outputs.junit, e.g. backend-api-jest-1.xml); spec paths
//                  in `file` are relative to apiRootDir
//   outDir         where report.json and report.txt are written (the stored artifact); the
//                  risk guard step writes guard.json here too
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const XML_ENTITIES = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" };
const unescapeXml = (s) => s.replace(/&(lt|gt|amp|quot|apos);/g, (e) => XML_ENTITIES[e]);

// One spelling for a spec path on both sides: forward slashes, relative to apps/api, no "./".
function normalize(p, apiRoot) {
  let s = p.trim().replace(/\\/g, "/");
  const root = apiRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && s.startsWith(`${root}/`)) s = s.slice(root.length + 1);
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

const readIfExists = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);

// A file, or every *.xml in a directory joined; null when there is no report at all.
function readJunit(p) {
  if (!p || !fs.existsSync(p)) return null;
  if (!fs.statSync(p).isDirectory()) return fs.readFileSync(p, "utf8");
  const files = fs.readdirSync(p).filter((f) => f.endsWith(".xml")).sort();
  return files.length ? files.map((f) => fs.readFileSync(path.join(p, f), "utf8")).join("\n") : null;
}

// Spec files in the full run and the ones with at least one failure (including the converter's
// "suite failed to run" case, which also counts in the suite's failures attribute).
function parseJunit(xml, apiRoot) {
  const specs = new Set();
  const failing = new Set();
  for (const m of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const file = /\bfile="([^"]*)"/.exec(m[1]);
    if (!file) continue;
    const spec = normalize(unescapeXml(file[1]), apiRoot);
    specs.add(spec);
    const failures = /\bfailures="(\d+)"/.exec(m[1]);
    if (failures && Number(failures[1]) > 0) failing.add(spec);
  }
  return { specs, failing };
}

// list-tests output may mix log lines with atoms; keep only tokens that are specs of this run.
function parseSelection(text, specs, apiRoot) {
  const selected = new Set();
  const unknown = [];
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const spec = normalize(token, apiRoot);
    if (specs.has(spec)) selected.add(spec);
    else if (/\.spec\.ts$/.test(spec)) unknown.push(spec);
  }
  return { selected, unknown };
}

const GUARD_DECISIONS = ["FORCE_FULL", "TIA_ELIGIBLE"];

// The guard's decision for this head. Any doubt is FORCE_FULL_UNKNOWN with the reason, never an
// error. The guard step's bash fallback writes only decision and reason (no head key), and only
// FORCE_FULL. TIA_ELIGIBLE narrows the selection, so it counts only when pinned to CIRCLE_SHA1;
// FORCE_FULL is safe on any head the guard could not resolve (head null).
function readGuard(outDir, sha) {
  const unknown = (source, reason, head = null) => ({ decision: "FORCE_FULL_UNKNOWN", source, reason, head });
  let g;
  try {
    const text = readIfExists(outDir && path.join(outDir, "guard.json"));
    if (text === null) return unknown("missing", "no guard.json: the risk guard step recorded no decision");
    g = JSON.parse(text);
  } catch (err) {
    return unknown("unreadable", `guard.json unreadable: ${err.message}`);
  }
  if (!g || typeof g !== "object" || Array.isArray(g) || !GUARD_DECISIONS.includes(g.decision)) {
    return unknown("invalid-decision", "guard.json has no FORCE_FULL or TIA_ELIGIBLE decision");
  }
  const fallback = !("head" in g);
  if (fallback && g.decision !== "FORCE_FULL") {
    return unknown("invalid-decision", "guard.json without head records only FORCE_FULL (the step's fallback)");
  }
  const head = typeof g.head === "string" && g.head ? g.head : null;
  if (head && sha && head !== sha) return unknown("stale-head", `guard.json is for ${head}, not ${sha}`, head);
  if (g.decision === "TIA_ELIGIBLE" && !(head && sha)) {
    return unknown("stale-head", `TIA_ELIGIBLE not pinned to this commit (guard head ${head || "none"}, CIRCLE_SHA1 ${sha || "unset"})`, head);
  }
  // RT-920: specs the guard requires for neutral changes (a changelog fragment adds one). Anything that is
  // not a list of strings becomes null, and the guarded block then fails closed (see below).
  // A guard.json without the field (written before RT-920) has no must-run specs.
  const mustRun =
    g.mustRun === undefined ? [] : Array.isArray(g.mustRun) && g.mustRun.every((m) => typeof m === "string") ? g.mustRun : null;
  return { decision: g.decision, source: fallback ? "fallback" : "guard.json", reason: typeof g.reason === "string" ? g.reason : null, head, mustRun };
}

// What would have run with the guard in force. Only a known decision yields misses.
function guardedSelection(r, selected) {
  const none = (status) => ({ status, selectedSpecs: null, selectionRatio: null, misses: null });
  if (r.guard.decision === "FORCE_FULL") {
    return { status: "force-full", selectedSpecs: r.totalSpecs, selectionRatio: r.totalSpecs ? 1 : null, misses: [] };
  }
  if (r.guard.decision !== "TIA_ELIGIBLE") return none("force-full-unknown");
  if (!r.misses || !selected) return none(r.status);
  // RT-920: the guard's must-run specs join the raw selection. A must-run list that is missing
  // or names a spec absent from the full run means the guard's assumption broke: not measured.
  const mustRun = r.guard.mustRun;
  if (!mustRun) return none("must-run-unknown");
  if (mustRun.some((m) => !r.allSpecs.has(m))) return none("must-run-missing");
  const union = new Set([...selected, ...mustRun]);
  // The status follows the guarded selection, with measureRaw's rules: must-run specs can lift an
  // empty raw selection, or make the union cover every spec.
  const status = union.size === 0 ? "empty-selection" : union.size === r.totalSpecs ? "all-selected" : "measured";
  const guarded = {
    status,
    selectedSpecs: union.size,
    selectionRatio: r.totalSpecs ? union.size / r.totalSpecs : null,
    misses: r.failingSpecs.filter((s) => !union.has(s)),
  };
  // Only a non-empty must-run list adds the field, so every earlier report keeps its shape.
  if (mustRun.length) guarded.mustRun = [...mustRun];
  return guarded;
}

function buildReport(args) {
  const [, junitPath, outDir, apiRoot] = args;
  const report = { branch: process.env.CIRCLE_BRANCH || null, sha: process.env.CIRCLE_SHA1 || null };
  report.guard = readGuard(outDir, report.sha);
  const rcText = readIfExists(outDir && path.join(outDir, "list-tests.rc"));
  report.listTestsExitCode = rcText === null ? null : Number(rcText.trim());

  const xml = readJunit(junitPath);
  if (xml === null) {
    report.status = "no-junit";
    report.note = `No JUnit report at ${junitPath}: the suite did not run (guard halt or earlier failure).`;
    // No guarded block here or on partial-run: without a full-suite report there is no
    // measurement to apply the guard to; `guard` alone records the decision.
    return report;
  }
  const { specs, failing } = parseJunit(xml, apiRoot || "");
  report.totalSpecs = specs.size;
  report.failingSpecs = [...failing].sort();

  // A failed-only rerun reports a subset of the suite: not a full-suite measurement.
  const countText = readIfExists(outDir && path.join(outDir, "discovered.count"));
  report.discoveredSpecs = countText === null ? null : Number(countText.trim()) || null;
  if (report.discoveredSpecs !== null && specs.size < report.discoveredSpecs) {
    report.status = "partial-run";
    report.note = `JUnit covers ${specs.size} of ${report.discoveredSpecs} specs (a failed-only rerun or an early stop); selection ratio and misses not computed.`;
    return report;
  }

  const selected = measureRaw(report, args[0], specs, apiRoot || "");
  // The guarded selection does not depend on list-tests: FORCE_FULL is computable even when
  // list-tests failed.
  Object.defineProperty(report, "allSpecs", { value: specs, enumerable: false });
  report.guarded = guardedSelection(report, selected);
  return report;
}

// The raw list-tests selection against the full run (the pre-RT-1083 report, unchanged).
function measureRaw(report, selectedPath, specs, apiRoot) {
  const selectionText = readIfExists(selectedPath);
  // No selection data is not the same as "selected nothing": a failed list-tests means misses
  // are not computable, never "all failures".
  if (selectionText === null || report.listTestsExitCode !== 0) {
    report.status = "no-selection-data";
    report.note = "list-tests failed or wrote nothing; selection ratio and misses not computable.";
    return null;
  }
  const { selected, unknown } = parseSelection(selectionText, specs, apiRoot);
  report.selectedSpecs = selected.size;
  report.selectionRatio = specs.size ? selected.size / specs.size : null;
  report.unknownSelected = unknown.sort();
  report.misses = report.failingSpecs.filter((s) => !selected.has(s));
  // A successful but empty selection is a real result ("no spec impacted"), and the one where
  // a miss would skip the whole suite, so its misses count. Every spec selected is either a
  // full-test-run path or the no-impact-data fallback: not evidence of good selection.
  if (selected.size === 0) {
    report.status = "empty-selection";
    report.note = "list-tests selected no spec: either no spec is impacted or main has no impact data yet (see list-tests.log).";
  } else if (selected.size === specs.size) {
    report.status = "all-selected";
    report.note = "every spec selected: a full-test-run path changed or there is no impact data yet (see list-tests.log).";
  } else {
    report.status = "measured";
  }
  return selected;
}

function renderGuarded(r, lines) {
  if (r.guard) {
    lines.push(`guard decision: ${r.guard.decision} (${r.guard.source})${r.guard.reason ? `: ${r.guard.reason}` : ""}`);
  }
  const g = r.guarded;
  if (!g) return;
  if (g.status === "force-full-unknown") {
    lines.push("GUARDED: guard decision unknown, not a measured result");
  } else if (g.misses === null) {
    lines.push(`GUARDED: ${g.status}; selection ratio and misses not computable`);
  } else {
    const pct = g.selectionRatio === null ? "n/a" : `${(g.selectionRatio * 100).toFixed(1)}%`;
    lines.push(`GUARDED: selected ${g.selectedSpecs}/${r.totalSpecs} (${pct}), MISSES ${g.misses.length}`);
    for (const s of g.misses) lines.push(`  GUARDED MISS ${s}`);
  }
}

function render(r) {
  const lines = ["Impact analysis shadow report (advisory; the full suite ran)"];
  lines.push(`branch: ${r.branch ?? "?"}  sha: ${r.sha ?? "?"}  list-tests exit code: ${r.listTestsExitCode ?? "n/a"}`);
  lines.push(`status: ${r.status}`);
  if (r.note) lines.push(r.note);
  if (r.totalSpecs !== undefined) lines.push(`spec files in the full run: ${r.totalSpecs}; failing: ${r.failingSpecs.length}`);
  if (r.misses) {
    const pct = r.selectionRatio === null ? "n/a" : `${(r.selectionRatio * 100).toFixed(1)}%`;
    lines.push(`selected: ${r.selectedSpecs}/${r.totalSpecs} (${pct})`);
    if (r.unknownSelected.length) lines.push(`selected but not in the run: ${r.unknownSelected.join(", ")}`);
    lines.push(`MISSES (failing but not selected): ${r.misses.length}`);
    for (const s of r.misses) lines.push(`  MISS ${s}`);
  }
  renderGuarded(r, lines);
  return lines.join("\n");
}

function main(args) {
  let report;
  try {
    report = buildReport(args);
  } catch (err) {
    report = { status: "report-error", note: `report failed: ${err && err.stack ? err.stack : err}` };
  }
  const text = render(report);
  console.log(text);
  try {
    if (args[2]) {
      fs.mkdirSync(args[2], { recursive: true });
      fs.writeFileSync(path.join(args[2], "report.json"), `${JSON.stringify(report, null, 2)}\n`);
      fs.writeFileSync(path.join(args[2], "report.txt"), `${text}\n`);
    }
  } catch (err) {
    console.log(`could not write the report files: ${err}`);
  }
  return report;
}

if (require.main === module) {
  main(process.argv.slice(2));
  process.exit(0);
}
module.exports = { main, normalize, parseJunit, parseSelection, readGuard };
