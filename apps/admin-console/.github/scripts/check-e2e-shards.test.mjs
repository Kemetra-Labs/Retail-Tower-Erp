// RT-1278: the admin/e2e fan-in passes only when the sharded run is complete. Run with
// `node --test .github/scripts/check-e2e-shards.test.mjs` from apps/admin-console.
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkShards, testKeys } from "./check-e2e-shards.mjs";

// The shape of a Playwright JSON report (both `--list` and a merged run): nested suites with
// specs, each spec holding one test per project.
const spec = (title, line, projects, status = "expected") => ({
  title,
  file: "a.spec.ts",
  line,
  column: 1,
  tests: projects.map((projectName) => ({
    projectName,
    status,
    results:
      status === "listed"
        ? []
        : [{ status: status === "expected" ? "passed" : "failed" }],
  })),
});
const report = (specs) => ({
  suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs, suites: [] }],
});

const both = ["chromium-ar", "chromium-en"];
const listed = report([
  spec("one", 3, both, "listed"),
  spec("two", 9, both, "listed"),
]);
const merged = report([spec("one", 3, both), spec("two", 9, both)]);
const blobs = ["report-1.zip", "report-2.zip", "report-3.zip", "report-4.zip"];

test("testKeys gives one key per (project, file, line, title)", () => {
  assert.deepEqual(testKeys(listed).sort(), [
    "chromium-ar|a.spec.ts:3|one",
    "chromium-ar|a.spec.ts:9|two",
    "chromium-en|a.spec.ts:3|one",
    "chromium-en|a.spec.ts:9|two",
  ]);
});

test("a complete run passes", () => {
  assert.deepEqual(
    checkShards({ blobFiles: blobs, shards: 4, listed, merged }),
    [],
  );
});

test("a missing shard report fails", () => {
  const errors = checkShards({
    blobFiles: blobs.slice(0, 3),
    shards: 4,
    listed,
    merged,
  });
  assert.match(errors.join("\n"), /expected 4 shard blob reports, found 3/);
});

test("an extra shard report fails", () => {
  const errors = checkShards({
    blobFiles: [...blobs, "report-5.zip"],
    shards: 4,
    listed,
    merged,
  });
  assert.match(errors.join("\n"), /expected 4 shard blob reports, found 5/);
});

test("a listed test missing from the merged report fails", () => {
  const short = report([spec("one", 3, both)]);
  const errors = checkShards({
    blobFiles: blobs,
    shards: 4,
    listed,
    merged: short,
  });
  assert.match(
    errors.join("\n"),
    /2 listed test\(s\) missing from the merged report/,
  );
  assert.match(errors.join("\n"), /chromium-ar\|a\.spec\.ts:9\|two/);
});

test("a test reported twice fails", () => {
  const dup = report([
    spec("one", 3, both),
    spec("two", 9, both),
    spec("two", 9, ["chromium-en"]),
  ]);
  const errors = checkShards({
    blobFiles: blobs,
    shards: 4,
    listed,
    merged: dup,
  });
  assert.match(
    errors.join("\n"),
    /reported more than once: chromium-en\|a\.spec\.ts:9\|two/,
  );
});

test("a test that is not in the listing fails", () => {
  const extra = report([
    spec("one", 3, both),
    spec("two", 9, both),
    spec("ghost", 20, ["chromium-ar"]),
  ]);
  const errors = checkShards({
    blobFiles: blobs,
    shards: 4,
    listed,
    merged: extra,
  });
  assert.match(
    errors.join("\n"),
    /not in the listing: chromium-ar\|a\.spec\.ts:20\|ghost/,
  );
});

test("an unexpected (failed) test fails, even if every shard job was green", () => {
  const red = report([
    spec("one", 3, both),
    spec("two", 9, both, "unexpected"),
  ]);
  const errors = checkShards({
    blobFiles: blobs,
    shards: 4,
    listed,
    merged: red,
  });
  assert.match(errors.join("\n"), /2 test\(s\) failed/);
});

test("an empty listing fails rather than passing vacuously", () => {
  const errors = checkShards({
    blobFiles: blobs,
    shards: 4,
    listed: report([]),
    merged: report([]),
  });
  assert.match(errors.join("\n"), /the listing has no tests/);
});

test("nested describe blocks are walked", () => {
  const nested = {
    suites: [
      {
        title: "a.spec.ts",
        file: "a.spec.ts",
        specs: [],
        suites: [
          {
            title: "group",
            file: "a.spec.ts",
            specs: [spec("deep", 5, ["chromium-ar"], "listed")],
            suites: [],
          },
        ],
      },
    ],
  };
  assert.deepEqual(testKeys(nested), ["chromium-ar|a.spec.ts:5|group > deep"]);
});
