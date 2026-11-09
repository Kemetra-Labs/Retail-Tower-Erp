// RT-1199: spec for tools/code-health/compare.mjs (plain ESM + node:test, no dependencies).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BaselineError,
  METRICS,
  compare,
  compareOversizedFiles,
  maxLinesActual,
  parseBaseline,
} from "../compare.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function counts(value) {
  return Object.fromEntries(METRICS.map((metric) => [metric, value]));
}

function without(metric, value) {
  return Object.fromEntries(METRICS.filter((m) => m !== metric).map((m) => [m, value]));
}

test("parseBaseline accepts every metric as a non-negative integer, plus an optional $comment", () => {
  assert.deepEqual(parseBaseline({ $comment: "note", ...counts(3), oversizedFiles: {} }), {
    ...counts(3),
    oversizedFiles: {},
  });
});

test("parseBaseline rejects a missing, negative, fractional or non-number metric", () => {
  assert.throws(() => parseBaseline(without("knipUnusedFiles", 1)), BaselineError);
  assert.throws(() => parseBaseline({ ...counts(1), jscpdClones: -1 }), BaselineError);
  assert.throws(() => parseBaseline({ ...counts(1), jscpdClones: 1.5 }), BaselineError);
  assert.throws(() => parseBaseline({ ...counts(1), jscpdClones: "2" }), BaselineError);
});

test("parseBaseline rejects unknown keys so a typo cannot silently drop a metric", () => {
  assert.throws(
    () => parseBaseline({ ...counts(1), oversizedFiles: {}, jscpdClone: 4 }),
    /unknown keys: jscpdClone/,
  );
});

test("parseBaseline rejects a non-object baseline", () => {
  assert.throws(() => parseBaseline(null), BaselineError);
  assert.throws(() => parseBaseline([1, 2]), BaselineError);
});

test("the committed baseline parses", () => {
  const committed = JSON.parse(readFileSync(path.join(here, "..", "baseline.json"), "utf8"));
  assert.doesNotThrow(() => parseBaseline(committed));
});

test("compare passes when every count is equal to the baseline", () => {
  assert.deepEqual(compare(counts(5), counts(5)), { grew: [], shrank: [], ok: true });
});

test("compare fails and names the metric when one count grows", () => {
  const result = compare({ ...counts(5), knipUnusedExports: 6 }, counts(5));
  assert.equal(result.ok, false);
  assert.deepEqual(result.grew, [{ metric: "knipUnusedExports", current: 6, baseline: 5 }]);
});

test("compare passes and reports a shrink when a count drops", () => {
  const result = compare({ ...counts(5), eslintMaxLines: 2 }, counts(5));
  assert.equal(result.ok, true);
  assert.deepEqual(result.shrank, [{ metric: "eslintMaxLines", current: 2, baseline: 5 }]);
});

test("a drop elsewhere does not offset a growth", () => {
  const result = compare({ ...counts(5), jscpdClones: 4, eslintComplexity: 6 }, counts(5));
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.grew.map((g) => g.metric),
    ["eslintComplexity"],
  );
});

test("compare throws when a measured count is missing or invalid", () => {
  assert.throws(() => compare(without("eslintMaxLines", 1), counts(1)), BaselineError);
});

// RT-1295: an already over-max-lines file may not grow.

test("parseBaseline requires oversizedFiles, so the per-file ratchet cannot be dropped", () => {
  assert.throws(() => parseBaseline(counts(1)), /oversizedFiles/);
  assert.throws(() => parseBaseline({ ...counts(1), oversizedFiles: [] }), BaselineError);
  assert.throws(() => parseBaseline({ ...counts(1), oversizedFiles: { "a.ts": 900.5 } }), BaselineError);
  assert.throws(() => parseBaseline({ ...counts(1), oversizedFiles: { "a.ts": "900" } }), BaselineError);
  assert.deepEqual(parseBaseline({ ...counts(1), oversizedFiles: { "a.ts": 900 } }).oversizedFiles, {
    "a.ts": 900,
  });
});

test("the committed baseline lists one over-limit file per eslintMaxLines warning", () => {
  const committed = parseBaseline(
    JSON.parse(readFileSync(path.join(here, "..", "baseline.json"), "utf8")),
  );
  assert.equal(Object.keys(committed.oversizedFiles).length, committed.eslintMaxLines);
  for (const lines of Object.values(committed.oversizedFiles)) assert.ok(lines > 800);
});

test("an over-limit file that gains lines fails, even though the eslintMaxLines count is unchanged", () => {
  const baseline = { "sales.service.ts": 1028, "pos-operators.service.ts": 857 };
  const current = { "sales.service.ts": 1029, "pos-operators.service.ts": 857 };
  assert.equal(compare({ ...counts(2) }, { ...counts(2) }).ok, true);
  assert.deepEqual(compareOversizedFiles(current, baseline), {
    grew: [{ file: "sales.service.ts", current: 1029, baseline: 1028 }],
    added: [],
    shrank: [],
    ok: false,
  });
});

test("a file that newly goes over the limit fails, even when another one dropped under it", () => {
  const result = compareOversizedFiles({ "b.ts": 801 }, { "a.ts": 900 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.added, [{ file: "b.ts", current: 801 }]);
  assert.deepEqual(result.shrank, [{ file: "a.ts", current: 0, baseline: 900 }]);
});

test("an over-limit file that shrinks, or drops under the limit, passes and is reported", () => {
  const result = compareOversizedFiles({ "a.ts": 950 }, { "a.ts": 1000, "b.ts": 820 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.shrank, [
    { file: "a.ts", current: 950, baseline: 1000 },
    { file: "b.ts", current: 0, baseline: 820 },
  ]);
});

test("an unchanged over-limit file passes", () => {
  assert.deepEqual(compareOversizedFiles({ "a.ts": 900 }, { "a.ts": 900 }), {
    grew: [],
    added: [],
    shrank: [],
    ok: true,
  });
});

test("compareOversizedFiles throws on an invalid measured count", () => {
  assert.throws(() => compareOversizedFiles({ "a.ts": -1 }, {}), BaselineError);
});

test("maxLinesActual reads the line count from the ESLint 8 max-lines message", () => {
  assert.equal(maxLinesActual("File has too many lines (1028). Maximum allowed is 800."), 1028);
  assert.equal(maxLinesActual("Something else (12)."), null);
  assert.equal(maxLinesActual(undefined), null);
});
