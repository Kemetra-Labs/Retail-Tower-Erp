#!/usr/bin/env node
// RT-1256: the API Jest gate run is complete only if Jest reported every discovered spec and
// nothing failed or crashed. Jest's own exit code (failures, coverage thresholds) stays the run
// step's; this check adds "no spec silently missing", so a short or empty run can never post a
// green `ci/circleci: api-jest-gate` status.
//
// usage: api-gate-complete.cjs <jest --json output> <discovered specs file, relative to apps/api>
//        [apps/api dir, default cwd]                  exit 0 complete, 1 otherwise
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function check(result, discovered, apiRoot) {
  const problems = [];
  if (!result || typeof result !== "object") return ["no Jest JSON result"];
  if (discovered.length === 0) problems.push("no spec discovered");
  if (result.success !== true) problems.push("Jest reported success=false");
  for (const k of ["numFailedTestSuites", "numRuntimeErrorTestSuites", "numFailedTests"]) {
    if (result[k] !== 0) problems.push(`${k}=${result[k]}`);
  }
  const ran = new Set(
    (Array.isArray(result.testResults) ? result.testResults : []).map((r) =>
      path.relative(apiRoot, String(r.name || r.testFilePath || "")).split(path.sep).join("/"),
    ),
  );
  if (result.numTotalTestSuites !== discovered.length) {
    problems.push(`numTotalTestSuites=${result.numTotalTestSuites}, discovered ${discovered.length}`);
  }
  const missing = discovered.filter((s) => !ran.has(s));
  if (missing.length) problems.push(`${missing.length} discovered spec(s) without a result, first: ${missing[0]}`);
  return problems;
}

function main(argv) {
  const apiRoot = path.resolve(argv[2] || process.cwd());
  let result = null;
  let discovered = [];
  try {
    result = JSON.parse(fs.readFileSync(argv[0], "utf8"));
  } catch {
    result = null;
  }
  try {
    discovered = fs.readFileSync(argv[1], "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    discovered = [];
  }
  const problems = check(result, discovered, apiRoot);
  console.log(problems.length ? `API gate run INCOMPLETE: ${problems.join("; ")}` : `API gate run complete: ${discovered.length} specs`);
  return problems.length ? 1 : 0;
}

module.exports = { check, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
