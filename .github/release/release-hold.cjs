#!/usr/bin/env node
// RT-1592: the read-only, fail-closed release HOLD check for a POS or POS Pilot release
// (.github/workflows/release-pos.yml, release-pos-pilot.yml). Owner decision D4 (RT-1588 comment 18706): a build
// that carries the no-default-limit parked-sales behavior (RT-1561, #836) must not be published unless the release
// candidate also contains and still preserves the two capabilities that make it safe to ship: the parked list at
// scale (RT-1562) and the manager bulk-cancel (RT-1563). Jira text cannot stop a release; this check can.
//
// It reads the hold manifest (.github/release/release-holds.json, as of the release SHA) and git history of the release
// SHA. It makes no network call, starts no workflow, holds no write scope and calls no Jira API.
//
// For every hold that applies to the product:
//   - status `open`: REFUSED, the hold is named. The hold never clears itself: a reviewed PR sets `cleared`.
//   - status `cleared`: it passes only when ALL of these hold for the exact release SHA, for EVERY capability:
//       * each recorded clearing SHA exists, is an ancestor of the release SHA and is not reverted in the history
//         after it (a later commit whose body says `This reverts commit <sha>`);
//       * each recorded evidence test file exists in the release SHA's tree;
//       * each recorded production entry point exists in the release SHA's tree (the capability was not removed
//         or replaced after clearing);
//       * the existing exact-SHA release CI guard (RT-1471, ci-check-gate.cjs) passed, which means the mandatory
//         `pos/test` check is a completed success for this SHA. This reuses that guard's verdict; it starts no CI run.
//     Ancestry and revert detection alone are never sufficient.
//   - any other status, a malformed manifest, an unreadable history or tree, a missing evidence list: REFUSED.
//
// The workflows compute and print the verdict on every run (a dry-run included) but fail only a release-mode run, so
// the signing-for-release and publish jobs stop while build, CI, dry-run signing and the dry-run manifest still work.
//
// CLI:
//   node .github/release/release-hold.cjs --manifest FILE --sha SHA --product pos|pos-pilot --guard-verdict VERDICT
// Run it from a checkout whose git history reaches the clearing SHAs (fetch-depth 0). Prints the decision;
// exit 0 = pass, 1 = refused, 2 = usage.
"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const SHA_RE = /^[0-9a-f]{40}$/;
const PRODUCTS = ["pos", "pos-pilot"];
const STATUSES = ["open", "cleared"];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// A repository-relative file path: no leading slash, no `..` or empty segment, no backslash, space or control character.
const PATH_RE = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_GIT_BYTES = 64 * 1024 * 1024;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v !== "";
const isNonEmptyArray = (v) => Array.isArray(v) && v.length > 0;
const validPath = (p) => isText(p) && PATH_RE.test(p) && p.split("/").every((s) => s !== "." && s !== "..");

/** One line, no control characters, bounded: attacker-controlled text never starts a workflow command. */
function clean(text) {
  return String(text).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").slice(0, 400);
}

/** Why the manifest cannot be trusted; null when it is well formed. Anything unknown or ambiguous is a reason. */
function manifestProblem(manifest) {
  if (!isObject(manifest)) return "the hold manifest is not a JSON object";
  if (manifest.schema !== 1) return `the hold manifest schema is '${String(manifest.schema)}', not 1`;
  if (!Array.isArray(manifest.holds)) return "the hold manifest has no holds list";
  const ids = new Set();
  for (const hold of manifest.holds) {
    if (!isObject(hold)) return "a hold entry is not an object";
    if (!isText(hold.id) || !ID_RE.test(hold.id)) return `a hold has an invalid id '${String(hold.id)}'`;
    if (ids.has(hold.id)) return `hold '${hold.id}' is listed twice`;
    ids.add(hold.id);
    if (!isText(hold.reason)) return `hold '${hold.id}' has no reason`;
    if (!isNonEmptyArray(hold.products) || !hold.products.every((p) => PRODUCTS.includes(p))) {
      return `hold '${hold.id}' must list its products, each one of ${PRODUCTS.join("/")}`;
    }
    if (!STATUSES.includes(hold.status)) return `hold '${hold.id}' has unknown status '${String(hold.status)}'`;
    if (hold.status === "cleared") {
      const why = capabilitiesProblem(hold);
      if (why) return why;
    }
  }
  return null;
}

function capabilitiesProblem(hold) {
  if (!isNonEmptyArray(hold.capabilities)) return `hold '${hold.id}' is cleared but lists no capabilities`;
  for (const cap of hold.capabilities) {
    if (!isObject(cap) || !isText(cap.name)) return `a capability of hold '${hold.id}' has no name`;
    const at = `capability '${cap.name}' of hold '${hold.id}'`;
    if (!isNonEmptyArray(cap.clearing_shas) || !cap.clearing_shas.every((s) => typeof s === "string" && SHA_RE.test(s))) {
      return `${at} needs at least one clearing SHA, each a 40-character lowercase hex SHA`;
    }
    if (!isNonEmptyArray(cap.tests) || !cap.tests.every(validPath)) return `${at} needs at least one evidence test file, each a plain repository path`;
    if (!isNonEmptyArray(cap.entry_points) || !cap.entry_points.every(validPath)) {
      return `${at} needs at least one production entry point, each a plain repository path`;
    }
  }
  return null;
}

/**
 * @param git  { commitExists(sha), isAncestor(ancestor, descendant), reverts(sha, release) -> reverting commit SHAs,
 *               isFile(release, path) }. Each may throw: an unreadable history or tree refuses.
 * @returns {{ verdict: "PASS"|"REFUSED", problems: string[], notes: string[] }}
 */
function evaluateHold({ manifest, sha, product, guardVerdict, git }) {
  const problems = [];
  const notes = [];
  if (typeof sha !== "string" || !SHA_RE.test(sha)) problems.push("release SHA is not a 40-character lowercase hex SHA");
  if (!PRODUCTS.includes(product)) problems.push(`product '${String(product)}' is not one of ${PRODUCTS.join("/")}`);
  const why = manifestProblem(manifest);
  if (why) problems.push(why);
  if (problems.length > 0) return finish(problems, notes);

  const holds = manifest.holds.filter((h) => h.products.includes(product));
  if (holds.length === 0) notes.push(`no hold applies to ${product}`);
  for (const hold of holds) {
    if (hold.status === "open") {
      const lifted = Array.isArray(hold.lifted_by) ? ` Lifted by ${hold.lifted_by.map(String).join(" and ")}.` : "";
      problems.push(`hold '${hold.id}' is open: ${hold.reason}${lifted} A reviewed PR sets it to cleared once the work is done; it never clears itself.`);
      notes.push(`hold '${hold.id}': open`);
      continue;
    }
    const before = problems.length;
    if (guardVerdict !== "PASS") {
      problems.push(`hold '${hold.id}' cannot be cleared: the release CI guard verdict is '${String(guardVerdict || "none")}', so pos/test is not proven for ${sha}`);
    }
    for (const cap of hold.capabilities) checkCapability(hold, cap, sha, git, problems);
    notes.push(`hold '${hold.id}': ${problems.length === before ? "cleared and verified" : "cleared but NOT verified"}`);
  }
  return finish(problems, notes);
}

function finish(problems, notes) {
  return { verdict: problems.length ? "REFUSED" : "PASS", problems: problems.map(clean), notes: notes.map(clean) };
}

function checkCapability(hold, cap, sha, git, problems) {
  const at = `hold '${hold.id}', capability '${cap.name}'`;
  for (const clearing of cap.clearing_shas) {
    try {
      if (!git.commitExists(clearing)) {
        problems.push(`${at}: clearing SHA ${clearing} is not a commit in the history read`);
        continue;
      }
      if (!git.isAncestor(clearing, sha)) {
        problems.push(`${at}: clearing SHA ${clearing} is not an ancestor of the release SHA ${sha}`);
        continue;
      }
      for (const reverting of git.reverts(clearing, sha)) {
        problems.push(`${at}: clearing SHA ${clearing} is reverted by ${reverting} in the history of the release SHA`);
      }
    } catch (error) {
      problems.push(`${at}: the history for clearing SHA ${clearing} is unreadable (${errorText(error)})`);
    }
  }
  for (const [kind, files] of [["evidence test file", cap.tests], ["production entry point", cap.entry_points]]) {
    for (const file of files) {
      try {
        if (!git.isFile(sha, file)) problems.push(`${at}: ${kind} ${file} is missing from the release SHA ${sha}`);
      } catch (error) {
        problems.push(`${at}: the tree of the release SHA is unreadable for ${kind} ${file} (${errorText(error)})`);
      }
    }
  }
}

function errorText(error) {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

/** The real git adapter: fixed argument lists, no shell, read-only commands, run in the current checkout. */
function realGit() {
  const run = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: MAX_GIT_BYTES, stdio: ["ignore", "pipe", "pipe"] });
  const succeeds = (args) => {
    try {
      execFileSync("git", args, { stdio: "ignore" });
      return true;
    } catch (error) {
      if (error && typeof error.status === "number" && error.status === 1) return false;
      throw error;
    }
  };
  return {
    // `rev-parse --verify --quiet` exits 1 for a missing commit; only commit objects are read, never blobs.
    commitExists: (sha) => succeeds(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]),
    // `merge-base --is-ancestor` exits 0 for yes and 1 for no; anything else (128: bad object or no history) throws.
    isAncestor: (ancestor, descendant) => succeeds(["merge-base", "--is-ancestor", ancestor, descendant]),
    reverts(sha, release) {
      const out = run(["log", "--format=%H%x1f%B%x1e", `${sha}..${release}`]);
      const found = [];
      for (const record of out.split("\x1e")) {
        const [hash, body = ""] = record.split("\x1f");
        for (const m of body.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) {
          if (sha.startsWith(m[1]) && hash.trim() !== "") found.push(hash.trim());
        }
      }
      return found;
    },
    // ls-tree reads tree entries only, so it needs no blob from a partial (sparse, blob-filtered) clone.
    isFile(release, file) {
      const out = run(["ls-tree", "-z", release, "--", file]);
      return out.split("\0").some((entry) => /^100(644|755) blob [0-9a-f]{40}\t/.test(entry) && entry.slice(entry.indexOf("\t") + 1) === file);
    },
  };
}

function readManifest(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function main(argv, git = realGit()) {
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const [manifestFile, sha, product] = ["--manifest", "--sha", "--product"].map(get);
  const guardVerdict = get("--guard-verdict") ?? "";
  if (!manifestFile || !sha || !product || argv.length % 2 !== 0 || argv.some((a, i) => i % 2 === 0 && !a.startsWith("--"))) {
    console.error("usage: release-hold.cjs --manifest FILE --sha SHA --product pos|pos-pilot --guard-verdict VERDICT");
    return 2;
  }
  const result = evaluateHold({ manifest: readManifest(manifestFile), sha, product, guardVerdict, git });
  result.notes.forEach((n) => console.log(n));
  result.problems.forEach((p) => console.log(`::error::${p}`));
  console.log(`Release hold: ${result.verdict}`);
  return result.problems.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { SHA_RE, PRODUCTS, manifestProblem, evaluateHold, realGit, main };
