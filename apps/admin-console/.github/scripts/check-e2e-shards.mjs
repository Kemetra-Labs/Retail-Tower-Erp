// RT-1278: completeness check for the sharded admin/e2e run. The fan-in job named admin/e2e
// passes only when every shard left a blob report, and the merged report holds every test of
// `playwright test --list` at this SHA exactly once, with none failed. A shard that never ran,
// an artifact that never arrived, or a test that slipped between shards fails here instead of
// passing silently.
//
// Usage (from apps/admin-console):
//   node .github/scripts/check-e2e-shards.mjs <blob-dir> <shard-count> <listed.json> <merged.json>
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** One key per test: project, file:line and the describe path down to the test title. */
export function testKeys(report) {
  const keys = [];
  const visit = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      const title = [...titles, spec.title].join(" > ");
      for (const t of spec.tests ?? [])
        keys.push(`${t.projectName}|${spec.file}:${spec.line}|${title}`);
    }
    for (const child of suite.suites ?? [])
      visit(child, [...titles, child.title]);
  };
  // The top-level suites are the files; their title is the file name, not a describe block.
  for (const fileSuite of report.suites ?? []) visit(fileSuite, []);
  return keys;
}

/** How many tests ended `unexpected` (failed after all retries) anywhere in the report. */
function failedCount(report) {
  let n = 0;
  const visit = (suite) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) if (t.status === "unexpected") n += 1;
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const s of report.suites ?? []) visit(s);
  return n;
}

/** Returns the list of problems; an empty list means the sharded run is complete and green. */
export function checkShards({ blobFiles, shards, listed, merged }) {
  const errors = [];
  const zips = blobFiles.filter((f) => f.endsWith(".zip"));
  if (zips.length !== shards)
    errors.push(`expected ${shards} shard blob reports, found ${zips.length}`);

  const want = testKeys(listed);
  if (want.length === 0) errors.push("the listing has no tests");
  const got = testKeys(merged);

  const seen = new Map();
  for (const k of got) seen.set(k, (seen.get(k) ?? 0) + 1);
  const wantSet = new Set(want);
  const missing = want.filter((k) => !seen.has(k));
  const dup = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  const extra = [...seen.keys()].filter((k) => !wantSet.has(k));
  const show = (list) =>
    list.slice(0, 10).join(", ") + (list.length > 10 ? ", ..." : "");

  if (missing.length)
    errors.push(
      `${missing.length} listed test(s) missing from the merged report: ${show(missing)}`,
    );
  if (dup.length)
    errors.push(`${dup.length} test(s) reported more than once: ${show(dup)}`);
  if (extra.length)
    errors.push(
      `${extra.length} reported test(s) not in the listing: ${show(extra)}`,
    );

  const failed = failedCount(merged);
  if (failed) errors.push(`${failed} test(s) failed in the merged report`);
  return errors;
}

/**
 * CLI entry: reads the blob folder and both JSON reports, prints one `::error` per problem.
 * Returns the exit code: 0 complete and green, 1 incomplete or red, 2 bad arguments.
 */
function main(argv) {
  const [blobDir, shardArg, listedPath, mergedPath] = argv;
  if (!blobDir || !shardArg || !listedPath || !mergedPath) {
    console.error(
      "usage: check-e2e-shards.mjs <blob-dir> <shard-count> <listed.json> <merged.json>",
    );
    return 2;
  }
  const shards = Number(shardArg);
  if (!Number.isInteger(shards) || shards < 1) {
    console.error(`invalid shard count '${shardArg}'`);
    return 2;
  }
  let blobFiles = [];
  try {
    blobFiles = fs.readdirSync(blobDir);
  } catch {
    // A missing directory is a missing set of reports, judged below.
  }
  let listed;
  let merged;
  try {
    listed = JSON.parse(fs.readFileSync(listedPath, "utf8"));
    merged = JSON.parse(fs.readFileSync(mergedPath, "utf8"));
  } catch (e) {
    console.error(
      `::error title=admin/e2e fan-in::cannot read the listing or the merged report: ${e.message}`,
    );
    return 1;
  }
  const errors = checkShards({ blobFiles, shards, listed, merged });
  if (errors.length) {
    for (const e of errors)
      console.error(`::error title=admin/e2e fan-in::${e}`);
    return 1;
  }
  console.log(
    `admin/e2e fan-in: ${shards} shard reports, ${testKeys(merged).length} tests, each exactly once, none failed`,
  );
  return 0;
}

if (
  import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href
) {
  process.exitCode = main(process.argv.slice(2));
}
