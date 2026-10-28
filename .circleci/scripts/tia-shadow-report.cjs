#!/usr/bin/env node
// RT-920 PR-4b: shadow-mode report for CircleCI test impact analysis. Compares the specs
// `circleci testsuite list-tests` would have selected with the full-suite JUnit report, and
// prints the selection ratio and every failing spec that was NOT selected (a miss). Misses must
// stay at 0 for impact analysis ever to be trusted.
//
// Advisory only: this script never fails the job. Every problem is reported and it exits 0.
//
// usage: tia-shadow-report.cjs <selected.txt> <junit.xml> <outDir> <apiRootDir>
//   selected.txt   list-tests stdout; <outDir>/list-tests.rc holds its exit code
//   junit.xml      the converter's report, or a directory whose *.xml reports are all read
//                  (the CLI numbers outputs.junit, e.g. backend-api-jest-1.xml); spec paths
//                  in `file` are relative to apiRootDir
//   outDir         where report.json and report.txt are written (the stored artifact)
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

function buildReport([selectedPath, junitPath, outDir, apiRoot]) {
  const report = { branch: process.env.CIRCLE_BRANCH || null, sha: process.env.CIRCLE_SHA1 || null };
  const rcText = readIfExists(outDir && path.join(outDir, "list-tests.rc"));
  report.listTestsExitCode = rcText === null ? null : Number(rcText.trim());

  const xml = readJunit(junitPath);
  if (xml === null) {
    report.status = "no-junit";
    report.note = `No JUnit report at ${junitPath}: the suite did not run (guard halt or earlier failure).`;
    return report;
  }
  const { specs, failing } = parseJunit(xml, apiRoot || "");
  report.totalSpecs = specs.size;
  report.failingSpecs = [...failing].sort();

  const selectionText = readIfExists(selectedPath);
  // No selection data is not the same as "selected nothing": a failed list-tests means misses
  // are not computable, never "all failures".
  if (selectionText === null || report.listTestsExitCode !== 0) {
    report.status = "no-selection-data";
    report.note = "list-tests failed or wrote nothing; selection ratio and misses not computable.";
    return report;
  }
  const { selected, unknown } = parseSelection(selectionText, specs, apiRoot || "");
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
  return report;
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
module.exports = { main, normalize, parseJunit, parseSelection };
