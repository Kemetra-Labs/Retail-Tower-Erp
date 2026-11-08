// RT-1275: the Admin Console E2E repeatability job (admin-e2e-repeat). The GitHub admin/e2e gate
// retries a failed test twice, so a flaky test passes there and is counted nowhere. This job runs
// chosen spec files many times with retries off, and this script turns the Playwright JSON report
// into a failure rate per test. It never gates anything.
//
// Usage (from apps/admin-console):
//   node e2e-repeat-report.cjs validate "<specs>" <repeat>   prints the specs, one per line
//   node e2e-repeat-report.cjs report <results.json> <out.md> <spec>...
// `report` exits 1 only when the run is empty or a requested spec file has no result (fail
// closed: a renamed file or a moved line must not look like a clean run). Failed attempts are the
// finding, not an error here: the Playwright step itself already failed the job for them.
"use strict";
const fs = require("node:fs");

const SPEC = /^tests\/e2e\/[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\.spec\.ts(:[0-9]+)?$/;

/** Splits the spec parameter and refuses anything but files under tests/e2e (optionally :line). */
function validateSpecs(text) {
  const specs = String(text).trim().split(/\s+/).filter(Boolean);
  if (specs.length === 0) throw new Error("no spec given");
  for (const s of specs) {
    if (!SPEC.test(s) || s.split("/").includes("..")) throw new Error(`refusing spec '${s}'`);
  }
  return specs;
}

/** The --repeat-each count: a plain integer from 1 to 30 (a bound on the run's cost). */
function validateRepeat(text) {
  if (!/^[0-9]+$/.test(String(text))) throw new Error(`repeat count '${text}' is not an integer`);
  const n = Number(text);
  if (n < 1 || n > 30) throw new Error(`repeat count ${n} is outside 1..30`);
  return n;
}

/** One row per project, file:line and describe path; every non-skipped attempt is a run. */
function summarize(report) {
  const rows = new Map();
  const visit = (suite, titles) => {
    for (const sp of suite.specs ?? []) {
      const title = [...titles, sp.title].join(" > ");
      for (const t of sp.tests ?? []) {
        const key = `${t.projectName}|${sp.file}:${sp.line}|${title}`;
        for (const res of t.results ?? []) {
          if (res.status === "skipped") continue;
          const row = rows.get(key) ?? { key, runs: 0, failed: 0 };
          row.runs += 1;
          if (res.status !== "passed") row.failed += 1;
          rows.set(key, row);
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child, [...titles, child.title]);
  };
  // The top-level suites are the files; their title is the file name, not a describe block.
  for (const fileSuite of report.suites ?? []) visit(fileSuite, []);
  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Problems that make the run meaningless; an empty list means every requested spec ran. */
function check({ rows, specs }) {
  if (rows.length === 0) return ["no test ran: the specs matched nothing or the run stopped early"];
  const errors = [];
  for (const s of specs) {
    // Report paths are relative to testDir (tests/e2e) in current Playwright; accept the
    // config-relative form too. A :line filter must match that line.
    const [file, line] = s.replace(/^tests\/e2e\//, "").split(":");
    const tail = line ? `:${line}|` : ":";
    const hit = (r) => r.key.includes(`|${file}${tail}`) || r.key.includes(`|tests/e2e/${file}${tail}`);
    if (!rows.some(hit)) errors.push(`${s}: no result in the report`);
  }
  return errors;
}

/** A markdown table, tests with failed attempts first. */
function render(rows) {
  const sorted = [...rows].sort((a, b) => b.failed / b.runs - a.failed / a.runs || a.key.localeCompare(b.key));
  const flaky = rows.filter((r) => r.failed > 0).length;
  let out = "### Admin E2E repeatability (retries off)\n\n";
  out += flaky
    ? `${flaky} of ${rows.length} test(s) failed at least once.\n\n`
    : `No failed attempt in ${rows.length} test(s).\n\n`;
  out += "| Test (project \\| file:line \\| title) | Failed | Runs | Rate |\n|---|---|---|---|\n";
  for (const r of sorted) {
    const rate = ((100 * r.failed) / r.runs).toFixed(1);
    out += `| ${r.key.replaceAll("|", "\\|")} | ${r.failed} | ${r.runs} | ${rate}% |\n`;
  }
  return out;
}

/** CLI entry; returns the exit code (0 ok, 1 empty or incomplete run, 2 bad arguments). */
function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "validate") {
      const [specs, repeat] = rest;
      validateRepeat(repeat);
      console.log(validateSpecs(specs).join("\n"));
      return 0;
    }
    if (cmd === "report") {
      const [jsonPath, outPath, ...specs] = rest;
      if (!jsonPath || !outPath) throw new Error("usage: report <results.json> <out.md> <spec>...");
      const rows = summarize(JSON.parse(fs.readFileSync(jsonPath, "utf8")));
      const md = render(rows);
      fs.writeFileSync(outPath, md);
      console.log(md);
      const errors = check({ rows, specs: validateSpecs(specs.join(" ")) });
      for (const e of errors) console.error(`admin-e2e-repeat: ${e}`);
      return errors.length ? 1 : 0;
    }
    throw new Error("usage: e2e-repeat-report.cjs validate|report ...");
  } catch (e) {
    console.error(`admin-e2e-repeat: ${e.message}`);
    return 2;
  }
}

module.exports = { validateSpecs, validateRepeat, summarize, check, render, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
