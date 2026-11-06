#!/usr/bin/env node
// RT-1256: does the API Jest gate job (api-jest-gate) need to run for this PR?
// Reads the PR's changed paths (merge-base..HEAD, one per line) and prints `in-scope` or
// `out-of-scope`. Out of scope ONLY when there is at least one path and every path is in
// OUT_OF_SCOPE_RE: the other products (except their own .github/, a policy path that selects
// every job), the e2e suite, docs, system manifests and the two root prose files. The project
// graph never selects bc/db-integration for those, and the GitHub verifier
// (tools/project-graph/pgraph/circleci_gate.py, same pattern, pinned by its tests) fails a
// selected job whose paths are all out of scope, so a skipped run can never pass the gate.
// Any read problem or an empty list is in scope: the suite runs.
//
// usage: api-gate-scope.cjs <changed-paths-file>   exit 0 in scope, 10 out of scope
"use strict";
const fs = require("node:fs");

const OUT_OF_SCOPE_RE =
  /^(?:(?:apps\/(?:pos|admin-console)|integrations\/erpnext-connector)\/(?!(?:.*\/)?\.github\/)|tests\/e2e\/|docs\/|system\/|README\.md$|ARCHITECTURE\.md$)/;

function outOfScope(paths) {
  const list = (paths || []).map((p) => String(p).trim()).filter(Boolean);
  return list.length > 0 && list.every((p) => OUT_OF_SCOPE_RE.test(p));
}

function main(argv) {
  let text = null;
  try {
    text = fs.readFileSync(argv[0], "utf8");
  } catch {
    text = null;
  }
  const skip = text !== null && outOfScope(text.split(/\r?\n/));
  console.log(skip ? "out-of-scope" : "in-scope");
  return skip ? 10 : 0;
}

module.exports = { OUT_OF_SCOPE_RE, outOfScope, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
