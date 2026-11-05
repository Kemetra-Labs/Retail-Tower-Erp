#!/usr/bin/env node
// RT-1075: cumulative PR-diff risk guard for the Backend-Core API Jest TIA shadow lane.
// CircleCI's full-test-run-paths compares file hashes with the saved impact data, not with the
// PR's merge-base, so a high-risk file changed in an earlier commit of a PR stops forcing a full
// selection after an unrelated corrective push (PR #221: 703/703 selected, then 208/703; support
// case #151821496). This guard looks at the WHOLE PR diff against merge-base(origin/main, HEAD)
// on every head and decides:
//   FORCE_FULL    a change outside the narrow eligible set, or anything is uncertain
//   TIA_ELIGIBLE  every change is an added or modified regular file in the API fast class
//
// Allowlist, fail closed, and no wider than the trusted graph (tools/project-graph/graph.yaml):
// a change is eligible only if it is added or modified (not deleted, renamed or type-changed),
// a regular file (mode 100644/100755), inside backend-core's `api_jest_fast` class
// (FAST_GLOBS minus FAST_EXCLUDES) and in none of backend-core's tiers that reach apps/api
// (CRITICAL_API_GLOBS). Both lists are copied verbatim from graph.yaml; the colocated test fails
// if they drift. Stricter than the graph's RT-949 selector on one point: a path outside
// Backend-Core forces FULL too (the graph ignores most of them). A rename is read as a delete
// plus an add, so both sides are classified. A main push, an unknown branch, a failed fetch,
// merge-base or diff, an empty diff and any unexpected error force FULL.
//
// RT-920 (owner decisions 2026-11-05): two kinds of added or modified regular file are NEUTRAL:
// they neither force FULL nor make a PR eligible on their own.
//   changelog.d/*.md                 Every Backend-Core PR adds one. The one spec that reads the
//                                    fragments is a must-run (guard.json `mustRun`), and the shadow
//                                    report adds it to the guarded selection, so a bad fragment can
//                                    never count as a hidden miss.
//   tools/code-health/baseline.json  Most refactors lower it. Only the bc/fast ratchet reads it,
//                                    never an API spec (a self-test pins that), so it has no must-run
//                                    spec; its own failures surface in bc/fast.
// A PR whose only changes are neutral is FULL (there is no API change to measure).
//
// Shadow only: the decision is printed and written to <outDir>/guard.json and guard.txt. The
// job runs the full suite (--run-tests=all) in BOTH cases; nothing here selects or skips a test.
// This script never fails the job: every problem becomes FORCE_FULL and it exits 0.
//
// usage: tia-risk-guard.cjs [--repo <dir>] [--out <dir>]
//   --repo  the git checkout (default: cwd)
//   --out   where guard.json and guard.txt are written (default: /tmp/tia)
//   CIRCLE_BRANCH names the branch; empty or "main" forces FULL.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const FORCE_FULL = "FORCE_FULL";
const TIA_ELIGIBLE = "TIA_ELIGIBLE";
const BC = "services/backend-core/";
const REGULAR_MODES = ["100644", "100755"];

// graph.yaml products.backend-core.api_jest_fast, verbatim (relative to services/backend-core/).
const FAST_GLOBS = ["apps/api/src/**/*.ts", "apps/api/test/**/*.spec.ts"];
const FAST_EXCLUDES = ["apps/api/test/_helpers/**", "apps/api/**/*.d.ts", "apps/api/src/main.ts"];

// Every graph.yaml backend-core tier glob under apps/api, verbatim. The money, auth/tenant,
// contracts, sales, stock and posting-sync paths always run the full suite (D-CI-2026-10-29 policy 1).
const CRITICAL_API_GLOBS = [
  "apps/api/src/openapi/**",
  "apps/api/test/contract-conformance.spec.ts",
  "apps/api/test/openapi/**",
  "apps/api/src/settlement/**",
  "apps/api/src/catalog/sales/**",
  "apps/api/src/{pos-shifts,shift-closes}/**",
  "apps/api/src/inventory/**",
  "apps/api/src/catalog/erpnext-{warehouse-map,bin-view}/**",
  "apps/api/src/auth/**",
  "apps/api/test/{auth,authz}/**",
  "apps/api/src/{tenants,memberships,stores,context,devices,pos-operators,pos-cashier-admissions,pos-terminal-pairing}/**",
  "apps/api/src/{outbox,connector,connector-health}/**",
  "apps/api/src/catalog/{erpnext-*,read-down,sale-sync-ops}/**",
];

// Neutral paths (relative to services/backend-core/) and the specs that must run when one changes
// (relative to apps/api, the shadow report's spelling).
// Each rule: a glob and the specs that read files matching it (none for the code-health
// baseline, which only the bc/fast ratchet script reads, never an API spec).
const NEUTRAL_RULES = [
  { glob: "changelog.d/*.md", mustRun: ["test/tooling/changelog-fragments.spec.ts"] },
  { glob: "tools/code-health/baseline.json", mustRun: [] },
];
const NEUTRAL_GLOBS = NEUTRAL_RULES.map((r) => r.glob);
const NEUTRAL_MUST_RUN = [...new Set(NEUTRAL_RULES.flatMap((r) => r.mustRun))];

// Graph glob syntax (pgraph/globs.py): `*` stays inside one segment, `?` is one character of a
// segment, `**` spans segments (`**/` also matches no segment), `{a,b}` expands. Returns the
// pattern body; globToRegExp anchors it.
function globBody(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i++;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += `(?:${glob.slice(i + 1, end).split(",").map(globBody).join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return re;
}
// dotAll, as pgraph compiles with re.DOTALL: `.*` must also cross a line terminator in a name.
const globToRegExp = (glob) => new RegExp(`^${globBody(glob)}$`, "s");

const compile = (globs) => globs.map((g) => globToRegExp(BC + g));
const FAST_RES = compile(FAST_GLOBS);
const EXCLUDE_RES = compile(FAST_EXCLUDES);
const CRITICAL_RES = compile(CRITICAL_API_GLOBS);
const NEUTRAL_RULE_RES = NEUTRAL_RULES.map((r) => ({ re: globToRegExp(BC + r.glob), mustRun: r.mustRun }));

// Why a repo-relative path forces FULL, or null when it is in the eligible fast class.
function pathRisk(p) {
  if (!p || p.startsWith("/") || p.includes("\\") || p.split("/").some((s) => s === ".." || s === "." || s === "")) {
    return "unclassifiable path";
  }
  // Control characters and line/paragraph separators in a name are never ordinary source, and
  // U+FFFD means git gave bytes that are not UTF-8 (decoded lossily): the real name is unknown.
  if (/[\u0000-\u001f\u007f\u2028\u2029\uFFFD]/.test(p)) return "unclassifiable path";
  if (CRITICAL_RES.some((re) => re.test(p))) return "critical Backend-Core tier";
  if (!FAST_RES.some((re) => re.test(p)) || EXCLUDE_RES.some((re) => re.test(p))) {
    return "outside the API fast class";
  }
  return null;
}

// Why one change forces FULL, or null. A bare string is an added/modified regular file.
function changeRisk(change) {
  const c = typeof change === "string" ? { status: "M", mode: "100644", path: change } : change;
  if (c.status === "D") return "deleted (or the old side of a rename)";
  if (c.status !== "A" && c.status !== "M") return `git status ${c.status}`;
  if (!REGULAR_MODES.includes(c.mode)) return `special file mode ${c.mode}`;
  return pathRisk(c.path);
}

// True for an added/modified regular file on a neutral path (a changelog fragment). A delete,
// rename side, type change or special mode is never neutral: changeRisk classifies it.
function isNeutral(change) {
  const c = typeof change === "string" ? { status: "M", mode: "100644", path: change } : change;
  if (c.status !== "A" && c.status !== "M") return false;
  if (!REGULAR_MODES.includes(c.mode)) return false;
  if (pathRisk(c.path) === "unclassifiable path") return false;
  return NEUTRAL_RULE_RES.some((r) => r.re.test(c.path));
}

// Decision for a list of changes. An empty list is ambiguous on a PR head, so it is FULL.
function classify(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return { decision: FORCE_FULL, reason: "empty or missing diff", forcing: [], changed: [], neutral: [], mustRun: [] };
  }
  const changed = changes.map((c) => (typeof c === "string" ? c : c.path));
  const forcing = [];
  const neutral = [];
  for (const c of changes) {
    const p = typeof c === "string" ? c : c.path;
    if (isNeutral(c)) {
      neutral.push(p);
      continue;
    }
    const why = changeRisk(c);
    if (why) forcing.push({ path: p, why });
  }
  const mustRun = [...new Set(NEUTRAL_RULE_RES.filter((r) => neutral.some((p) => r.re.test(p))).flatMap((r) => r.mustRun))];
  if (forcing.length) {
    return { decision: FORCE_FULL, reason: `${forcing.length} change(s) force the full suite`, forcing, changed, neutral, mustRun };
  }
  if (neutral.length === changes.length) {
    return { decision: FORCE_FULL, reason: "only neutral changes (changelog fragments, code-health baseline): no API change to measure", forcing, changed, neutral, mustRun };
  }
  return {
    decision: TIA_ELIGIBLE,
    reason: neutral.length
      ? `every change is an added/modified file in the API fast class, plus ${neutral.length} neutral file(s)`
      : "every change is an added/modified file in the API fast class",
    forcing,
    changed,
    neutral,
    mustRun,
  };
}

// `git diff --raw -z --no-renames`: ":OLDMODE NEWMODE OLDSHA NEWSHA STATUS" NUL PATH NUL ...
// The mode kept is the new one, or the old one for a delete. Any unexpected record throws (and
// so forces FULL).
function parseRawZ(out) {
  const parts = out.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  if (parts.length % 2 !== 0) throw new Error("malformed git diff -z output");
  const changes = [];
  for (let i = 0; i < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([ACDMTUX])$/.exec(parts[i]);
    if (!m) throw new Error(`unexpected git diff record '${parts[i]}'`);
    changes.push({ status: m[3], mode: m[3] === "D" ? m[1] : m[2], path: parts[i + 1] });
  }
  return changes;
}

function git(repo, args) {
  // A hung git call (a stalled fetch) throws after a minute and so becomes FORCE_FULL.
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, timeout: 60_000 });
}

// The whole PR diff against merge-base(origin/main, HEAD), or a FORCE_FULL result on any doubt.
function evaluate(repo, branch) {
  const ctx = { branch: branch || "", base: null, head: null };
  const full = (reason) => ({ ...ctx, decision: FORCE_FULL, reason, forcing: [], changed: [], neutral: [], mustRun: [] });
  const first = (e) => e.message.split("\n")[0];
  if (!branch) return full("unknown branch (CIRCLE_BRANCH empty)");
  if (branch === "main") return full("push to main");
  try {
    ctx.head = git(repo, ["rev-parse", "HEAD"]).trim();
  } catch (e) {
    return full(`cannot resolve HEAD: ${first(e)}`);
  }
  try {
    git(repo, ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  } catch (e) {
    return full(`could not fetch origin/main: ${first(e)}`);
  }
  try {
    ctx.base = git(repo, ["merge-base", "refs/remotes/origin/main", "HEAD"]).trim();
  } catch (e) {
    return full(`no merge-base with origin/main: ${first(e)}`);
  }
  let changes;
  try {
    changes = parseRawZ(git(repo, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", ctx.base, ctx.head]));
  } catch (e) {
    return full(`git diff failed: ${first(e)}`);
  }
  return { ...ctx, ...classify(changes) };
}

function report(result) {
  const lines = [
    `TIA_GUARD_DECISION=${result.decision}`,
    `branch=${result.branch} base=${result.base || "-"} head=${result.head || "-"}`,
    `reason: ${result.reason}`,
    `changed paths (${result.changed.length}, cumulative PR diff):`,
    ...result.changed.map((p) => `  ${p}`),
  ];
  if (result.neutral && result.neutral.length) {
    lines.push(`neutral changes (${result.neutral.length}; must run: ${result.mustRun.join(", ")}):`, ...result.neutral.map((p) => `  ${p}`));
  }
  if (result.forcing.length) {
    lines.push(`forcing changes (${result.forcing.length}):`, ...result.forcing.map((f) => `  ${f.path}  [${f.why}]`));
  }
  lines.push("Shadow mode: the full suite (--run-tests=all) runs in both cases.");
  return lines.join("\n");
}

function main(argv, env) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const repo = arg("--repo", process.cwd());
  const outDir = arg("--out", "/tmp/tia");
  let result;
  try {
    result = evaluate(repo, env.CIRCLE_BRANCH);
  } catch (e) {
    result = { branch: env.CIRCLE_BRANCH || "", base: null, head: null, decision: FORCE_FULL, reason: `unexpected error: ${e.message}`, forcing: [], changed: [], neutral: [], mustRun: [] };
  }
  const text = report(result);
  console.log(text);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "guard.json"), `${JSON.stringify(result, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, "guard.txt"), `${text}\n`);
  } catch (e) {
    console.log(`could not write the guard report to ${outDir}: ${e.message}`);
  }
  return result;
}

module.exports = {
  FORCE_FULL, TIA_ELIGIBLE, FAST_GLOBS, FAST_EXCLUDES, CRITICAL_API_GLOBS, NEUTRAL_GLOBS, NEUTRAL_MUST_RUN,
  globToRegExp, pathRisk, changeRisk, isNeutral, classify, parseRawZ, evaluate, main,
};

if (require.main === module) main(process.argv.slice(2), process.env);
