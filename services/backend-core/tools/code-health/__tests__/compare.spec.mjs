// RT-1199: spec for tools/code-health/compare.mjs (plain ESM + node:test, no dependencies).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BaselineError, METRICS, compare, parseBaseline } from "../compare.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function counts(value) {
  return Object.fromEntries(METRICS.map((metric) => [metric, value]));
}

function without(metric, value) {
  return Object.fromEntries(METRICS.filter((m) => m !== metric).map((m) => [m, value]));
}

test("parseBaseline accepts every metric as a non-negative integer, plus an optional $comment", () => {
  assert.deepEqual(parseBaseline({ $comment: "note", ...counts(3) }), counts(3));
});

test("parseBaseline rejects a missing, negative, fractional or non-number metric", () => {
  assert.throws(() => parseBaseline(without("knipUnusedFiles", 1)), BaselineError);
  assert.throws(() => parseBaseline({ ...counts(1), jscpdClones: -1 }), BaselineError);
  assert.throws(() => parseBaseline({ ...counts(1), jscpdClones: 1.5 }), BaselineError);
  assert.throws(() => parseBaseline({ ...counts(1), jscpdClones: "2" }), BaselineError);
});

test("parseBaseline rejects unknown keys so a typo cannot silently drop a metric", () => {
  assert.throws(() => parseBaseline({ ...counts(1), jscpdClone: 4 }), /unknown keys: jscpdClone/);
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
