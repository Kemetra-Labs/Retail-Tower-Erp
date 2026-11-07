#!/usr/bin/env node
// RT-1265: does the Admin Console Vitest gate job (admin-vitest-gate) need to run for this PR?
// Reads the PR's changed paths (merge-base..HEAD, one per line). Out of scope ONLY when there is at
// least one path and every path is in OUT_OF_SCOPE_RE: POS and the connector (not their .github/),
// Backend-Core except its `contracts` tier and the Admin edge, the e2e suite, docs, system
// manifests, the two root prose files and the Admin Console's own `low` tier. The project graph
// never selects admin/build-test for those (pinned against the real graph in
// tools/project-graph/tests/test_circleci_gate.py), and the GitHub verifier
// (pgraph/circleci_gate.py ADMIN_OUT_OF_SCOPE_RE, the same pattern, test-pinned) fails a selected
// job whose paths are all out of scope, so a skipped run can never pass the gate.
// Any read problem or an empty list is in scope: the suite runs.
//
// usage: admin-gate-scope.cjs <changed-paths-file>   exit 0 in scope, 10 out of scope
"use strict";
const fs = require("node:fs");

const OUT_OF_SCOPE_RE =
  /^(?:(?:apps\/pos|integrations\/erpnext-connector)\/(?!(?:.*\/)?\.github\/)|services\/backend-core\/(?!(?:.*\/)?\.github\/|packages\/contracts\/|packages\/shared\/__tests__\/observability\/|apps\/api\/src\/openapi\/|apps\/api\/test\/openapi\/|apps\/api\/test\/contract-conformance\.spec\.ts$|tools\/oasdiff\/|tools\/schemathesis\/)|apps\/admin-console\/(?:(?:docs|specs|design|design_handoff_retail_tower_console|\.design-sync|\.claude|\.specify|\.impeccable)\/|[^/]+\.md$)|tests\/e2e\/|docs\/|system\/|README\.md$|ARCHITECTURE\.md$)/;

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
