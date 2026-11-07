#!/usr/bin/env node
// RT-1265: the Admin Console Vitest gate run is complete only if Vitest reported a result for every
// spec file the config includes, no file failed, the run succeeded and the coverage report was
// written. Vitest's own exit code stays the run step's; this check adds "no spec silently missing"
// and "coverage was produced", so a short, empty or coverage-less run can never post a green
// `ci/circleci: admin-vitest-gate` status. Admin Console has no coverage floor (vitest.config.ts
// sets no thresholds), so the coverage evidence is only that a non-empty lcov exists, exactly what
// `pnpm test` on GitHub produces; no threshold is added here.
//
// Discovered specs: the files under tests/unit/ matching vitest.config.ts `include`
// (tests/unit/**/*.test.ts and *.test.tsx; the spec pins the two together).
//
// usage: admin-gate-complete.cjs <vitest --reporter=json output> [admin-console dir, default cwd]
//        exit 0 complete, 1 otherwise
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SPEC_RE = /\.test\.tsx?$/;

function discover(appRoot) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(appRoot, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && SPEC_RE.test(e.name)) out.push(r);
    }
  };
  walk("tests/unit");
  return out.sort();
}

function check(result, discovered, appRoot, lcovBytes) {
  const problems = [];
  if (!result || typeof result !== "object") return ["no Vitest JSON result"];
  if (discovered.length === 0) problems.push("no spec discovered");
  if (result.success !== true) problems.push("Vitest reported success=false");
  // Review fix: whole-file skips are allowed, but a run where no test ran and passed (every file
  // skipped or empty) is not evidence of anything, so it can never post a green status.
  if (!(result.numPassedTests > 0)) problems.push(`numPassedTests=${result.numPassedTests}: no test ran and passed`);
  for (const k of ["numFailedTestSuites", "numFailedTests"]) {
    if (result[k] !== 0) problems.push(`${k}=${result[k]}`);
  }
  const files = Array.isArray(result.testResults) ? result.testResults : [];
  const seen = new Map();
  for (const f of files) {
    const rel = path.relative(appRoot, String(f.name || "")).split(path.sep).join("/");
    seen.set(rel, (seen.get(rel) || 0) + 1);
    if (f.status === "failed") problems.push(`failed: ${rel}`);
  }
  const twice = [...seen].filter(([, n]) => n > 1).map(([p]) => p);
  if (twice.length) problems.push(`${twice.length} spec(s) reported more than once, first: ${twice[0]}`);
  const missing = discovered.filter((s) => !seen.has(s));
  if (missing.length) problems.push(`${missing.length} discovered spec(s) without a result, first: ${missing[0]}`);
  const extra = [...seen.keys()].filter((p) => !discovered.includes(p));
  if (extra.length) problems.push(`${extra.length} result(s) for an undiscovered file, first: ${extra[0]}`);
  if (!(lcovBytes > 0)) problems.push("no coverage report (coverage/lcov.info missing or empty)");
  return problems;
}

function main(argv) {
  const appRoot = path.resolve(argv[1] || process.cwd());
  let result = null;
  let discovered = [];
  let lcovBytes = 0;
  try {
    result = JSON.parse(fs.readFileSync(argv[0], "utf8"));
  } catch {
    result = null;
  }
  try {
    discovered = discover(appRoot);
  } catch {
    discovered = [];
  }
  try {
    lcovBytes = fs.statSync(path.join(appRoot, "coverage", "lcov.info")).size;
  } catch {
    lcovBytes = 0;
  }
  const problems = check(result, discovered, appRoot, lcovBytes);
  console.log(
    problems.length
      ? `Admin Vitest gate run INCOMPLETE: ${problems.join("; ")}`
      : `Admin Vitest gate run complete: ${discovered.length} spec files, coverage report written`,
  );
  return problems.length ? 1 : 0;
}

module.exports = { SPEC_RE, discover, check, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
