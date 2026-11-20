#!/usr/bin/env node
// RT-1471 Phase 2 (POS and POS Pilot): the read-only, fail-closed exact-SHA guard for the mandatory
// CI checks of a release (.github/workflows/release-pos.yml, release-pos-pilot.yml). Owner decision,
// option C: it never dispatches or calls a workflow and needs no `actions: write`.
//
// A required check passes only when ALL of these hold for the exact release SHA:
//   - a check run with the required name, from the GitHub Actions app (slug github-actions);
//   - head_sha == the release SHA (a run for another commit, or with none, refuses);
//   - provenance: its details_url names a workflow run of THIS repository that is in the run list,
//     whose file is the required workflow (for example .github/workflows/pos.yml), whose event is a
//     full-run event (push, schedule, workflow_dispatch), whose branch is main, whose head SHA is the
//     release SHA and which comes from this repository, not a fork. A name and an app slug alone are
//     never enough, so a pull_request run that happens to share the SHA cannot stand in;
//   - the check run is the one GitHub made for an Actions job of that run: its id equals the job id in its
//     details_url, and the job list of the run (`GET actions/runs/<id>/jobs`) has that job with the same name,
//     head SHA, status and conclusion and a check_run_url that names this very check run. A check run created
//     or edited through the Checks API, even one that points at a trusted run, cannot satisfy all of that;
//   - the newest run decides (a run with no started_at is the newest, so a queued re-run is never
//     masked by an older green), every run tied for the newest time must be green, and the decision
//     is status completed with conclusion success. Missing, pending, failed, cancelled, skipped,
//     timed out, neutral, stale, untrusted or unreadable evidence refuses.
//
// When a check is only missing or still running, with nothing red, foreign-SHA or untrusted beside it,
// the refusal prints the one exact-SHA proof that exists (the main-pinned workflow_dispatch of RT-1471
// Phase 1) as a hint. It never runs it.
//
// This is the POS-side sibling of compat-gate.cjs (Backend-Core, RT-871), whose newest-run and
// head_sha rules it follows. It is separate on purpose: that guard also judges Backend-Core's
// contracts-compat files and must not change here. Reads files only; makes no network call.
//
// CLI:
//   node .github/release/ci-check-gate.cjs --checks FILE --runs FILE --jobs FILE --required JSON --sha SHA --repo OWNER/NAME
// --checks: JSON array of {id, name, status, conclusion, slug, started_at, head_sha, details_url}.
// --runs: JSON array of {id, path, event, head_branch, head_sha, repository, head_repository}.
// --jobs: JSON array of the Actions jobs of those runs: {id, run_id, name, status, conclusion, head_sha, check_run_url}.
// --required: JSON array of {name, workflow}. Prints the decision; exit 0 = pass, 1 = refused, 2 = usage.
"use strict";

const fs = require("node:fs");

const TRUSTED_SLUG = "github-actions";
const TRUSTED_EVENTS = ["push", "schedule", "workflow_dispatch"];
const TRUSTED_BRANCH = "main";
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_FILE_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;
const JOB_URL_RE = /^(\d+)\/job\/(\d+)$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const NEWEST = "\uffff"; // a run with no started_at sorts last: it is the newest

/** A regular file under the size cap, never through a symlink; null otherwise. */
function readRegular(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= MAX_FILE_BYTES ? fs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v !== "";

function validRequired(required) {
  return Array.isArray(required) && required.length > 0 && required.every((r) => isObject(r) && isText(r.name) && isText(r.workflow));
}

/** Why this check's workflow run is not an authentic full run for the release SHA; null when it is. */
function provenanceProblem(check, runsById, jobsById, workflow, sha, repo) {
  const prefix = `https://github.com/${repo}/actions/runs/`;
  const url = check.details_url;
  const match = typeof url === "string" && url.startsWith(prefix) ? JOB_URL_RE.exec(url.slice(prefix.length)) : null;
  if (!match) return `its details_url does not name a workflow run of ${repo} (${typeof url === "string" ? url : "none"})`;
  const id = match[1];
  const wfRun = runsById.get(id);
  if (!wfRun) return `workflow run ${id} is not in the run list of the release SHA`;
  if (wfRun.path !== workflow) return `workflow run ${id} is workflow '${String(wfRun.path)}', not ${workflow}`;
  if (!TRUSTED_EVENTS.includes(wfRun.event)) return `workflow run ${id} has event '${String(wfRun.event)}', not one of ${TRUSTED_EVENTS.join("/")}`;
  if (wfRun.head_branch !== TRUSTED_BRANCH) return `workflow run ${id} ran on branch '${String(wfRun.head_branch)}', not ${TRUSTED_BRANCH}`;
  if (wfRun.head_sha !== sha) return `workflow run ${id} reports head SHA '${String(wfRun.head_sha)}', not the release SHA`;
  if (wfRun.repository !== repo || wfRun.head_repository !== repo) return `workflow run ${id} does not come from repository ${repo}`;
  return jobProblem(check, id, match[2], jobsById, sha, repo);
}

/** The check run must be the one GitHub made for an Actions job of the run: see the header. */
function jobProblem(check, runId, jobId, jobsById, sha, repo) {
  if (String(check.id) !== jobId) return `its id ${String(check.id)} is not the id of the Actions job in its details_url (${jobId})`;
  const job = jobsById.get(jobId);
  if (!job) return `Actions job ${jobId} is not in the job list of workflow run ${runId}`;
  if (String(job.run_id) !== runId) return `Actions job ${jobId} belongs to run ${String(job.run_id)}, not ${runId}`;
  if (job.name !== check.name) return `Actions job ${jobId} is named '${String(job.name)}', not '${String(check.name)}'`;
  if (job.head_sha !== sha) return `Actions job ${jobId} reports head SHA '${String(job.head_sha)}', not the release SHA`;
  if (job.check_run_url !== `https://api.github.com/repos/${repo}/check-runs/${jobId}`) {
    return `Actions job ${jobId} does not name this check run (${String(job.check_run_url)})`;
  }
  if (job.status !== check.status || job.conclusion !== check.conclusion) {
    return `Actions job ${jobId} is ${String(job.status)}/${String(job.conclusion)} but the check run says ${String(check.status)}/${String(check.conclusion)}`;
  }
  return null;
}

/** One line, no control characters, bounded: attacker-controlled text never starts a workflow command. */
function clean(text) {
  return String(text).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").slice(0, 400);
}

/**
 * @returns {{ problems: string[], notes: string[], needsProof: boolean }} needsProof: some required
 *   check is missing or still running and nothing else blocks, so a full exact-SHA run could settle it.
 */
function judgeChecks({ checks, runs, jobs, required, sha, repo }) {
  const problems = [];
  const notes = [];
  if (typeof sha !== "string" || !SHA_RE.test(sha)) problems.push("release SHA is not a 40-character lowercase hex SHA");
  if (typeof repo !== "string" || !REPO_RE.test(repo)) problems.push("repository is not OWNER/NAME");
  if (!Array.isArray(checks)) problems.push("check runs for the release SHA are unreadable");
  if (!Array.isArray(runs)) problems.push("workflow runs for the release SHA are unreadable");
  if (!Array.isArray(jobs)) problems.push("Actions jobs of the workflow runs are unreadable");
  if (!validRequired(required)) problems.push("required checks are not configured as [{name, workflow}]");
  if (problems.length > 0) return { problems, notes, needsProof: false };

  const runsById = new Map();
  for (const r of runs) {
    if (isObject(r) && (typeof r.id === "number" || isText(r.id))) runsById.set(String(r.id), r);
  }
  const jobsById = new Map();
  for (const j of jobs) {
    if (isObject(j) && (typeof j.id === "number" || isText(j.id))) jobsById.set(String(j.id), j);
  }
  const valid = checks.filter(isObject);
  let sawMissing = false;
  let blocked = false; // something a dispatch cannot clear: red, foreign SHA or no provenance
  const when = (r) => (isText(r.started_at) ? r.started_at : NEWEST);

  for (const { name, workflow } of required) {
    const trusted = valid.filter((r) => r.name === name && r.slug === TRUSTED_SLUG);
    const counted = [];
    for (const r of trusted) {
      if (r.head_sha !== sha) {
        problems.push(`check '${name}' reports head SHA '${String(r.head_sha ?? "none")}', not the release SHA ${sha}`);
        blocked = true;
        continue;
      }
      const why = provenanceProblem(r, runsById, jobsById, workflow, sha, repo);
      if (why) {
        problems.push(`check '${name}' is not from a trusted ${workflow} run: ${why}`);
        blocked = true;
        continue;
      }
      counted.push(r);
    }
    const newest = counted.reduce((max, r) => (when(r) > max ? when(r) : max), "");
    const bad = counted.filter((r) => when(r) === newest).find((r) => r.status !== "completed" || r.conclusion !== "success");
    const result = counted.length === 0 ? "missing" : !bad ? "success" : bad.status !== "completed" ? "pending" : (bad.conclusion ?? "pending");
    notes.push(`check '${name}': ${result}`);
    if (result !== "success") problems.push(`required check '${name}' is '${result}' on the release SHA`);
    if (result === "missing" || result === "pending") sawMissing = true;
    else if (result !== "success") blocked = true;
  }
  return { problems: problems.map(clean), notes: notes.map(clean), needsProof: sawMissing && !blocked };
}

/** The only exact-SHA proof there is. The guard prints it and runs nothing. */
function proofHint(sha, required) {
  const files = [...new Set(required.map((r) => r.workflow.split("/").pop()))].filter((f) => WORKFLOW_FILE_RE.test(f));
  if (files.length === 0) return null;
  const cmds = files.map((f) => `\`gh workflow run ${f} --ref main -f expected_sha=${sha}\``).join(" and ");
  return (
    `To prove ${sha}: while it is still the tip of main, run ${cmds} (RT-1471 Phase 1, owner-authorized), wait for it to pass, ` +
    "then re-run this release. If main has moved, cut the release from a commit that a nightly or a manual full run has " +
    "already proven. The guard dispatches nothing."
  );
}

function evaluateGuard({ checks, runs, jobs, required, sha, repo }) {
  const result = judgeChecks({ checks, runs, jobs, required, sha, repo });
  const notes = [...result.notes];
  if (result.needsProof) {
    const hint = proofHint(sha, required);
    if (hint) notes.push(hint);
  }
  return { verdict: result.problems.length ? "REFUSED" : "PASS", problems: result.problems, notes };
}

function readJson(file) {
  try {
    return JSON.parse(readRegular(file) ?? "null");
  } catch {
    return null;
  }
}

function main(argv) {
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const [checksFile, runsFile, jobsFile, requiredJson, sha, repo] = ["--checks", "--runs", "--jobs", "--required", "--sha", "--repo"].map(get);
  if (!checksFile || !runsFile || !jobsFile || !requiredJson || !sha || !repo || argv.length % 2 !== 0) {
    console.error("usage: ci-check-gate.cjs --checks FILE --runs FILE --jobs FILE --required JSON --sha SHA --repo OWNER/NAME");
    return 2;
  }
  let required = null;
  try {
    required = JSON.parse(requiredJson);
  } catch {
    required = null;
  }
  const result = evaluateGuard({ checks: readJson(checksFile), runs: readJson(runsFile), jobs: readJson(jobsFile), required, sha, repo });
  result.notes.forEach((n) => console.log(n));
  result.problems.forEach((p) => console.log(`::error::${p}`));
  console.log(`Release CI check gate: ${result.verdict}`);
  return result.problems.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { SHA_RE, TRUSTED_SLUG, TRUSTED_EVENTS, judgeChecks, evaluateGuard, proofHint, main };
