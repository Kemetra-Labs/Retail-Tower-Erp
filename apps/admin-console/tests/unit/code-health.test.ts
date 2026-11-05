import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BaselineError,
  type Counts,
  METRICS,
  type Metric,
  compare,
  parseBaseline,
} from "../../scripts/code-health/compare.ts";

function counts(value: number): Counts {
  return Object.fromEntries(METRICS.map((metric) => [metric, value])) as Counts;
}

function without(metric: Metric, value: number): Partial<Counts> {
  return Object.fromEntries(METRICS.filter((m) => m !== metric).map((m) => [m, value]));
}

describe("RT-1200 code-health ratchet: parseBaseline", () => {
  it("accepts every metric as a non-negative integer, plus an optional $comment", () => {
    expect(parseBaseline({ $comment: "note", ...counts(3) })).toEqual(counts(3));
  });

  it("rejects a missing, negative, fractional or non-number metric", () => {
    expect(() => parseBaseline(without("knipUnusedFiles", 1))).toThrow(BaselineError);
    expect(() => parseBaseline({ ...counts(1), jscpdClones: -1 })).toThrow(BaselineError);
    expect(() => parseBaseline({ ...counts(1), jscpdClones: 1.5 })).toThrow(BaselineError);
    expect(() => parseBaseline({ ...counts(1), jscpdClones: "2" })).toThrow(BaselineError);
  });

  it("rejects unknown keys so a typo cannot silently drop a metric", () => {
    expect(() => parseBaseline({ ...counts(1), jscpdClone: 4 })).toThrow(
      /unknown keys: jscpdClone/,
    );
  });

  it("rejects a non-object baseline", () => {
    expect(() => parseBaseline(null)).toThrow(BaselineError);
    expect(() => parseBaseline([1, 2])).toThrow(BaselineError);
  });

  it("the committed baseline parses", () => {
    const file = path.resolve(__dirname, "../../scripts/code-health/baseline.json");
    expect(() => parseBaseline(JSON.parse(readFileSync(file, "utf8")))).not.toThrow();
  });
});

describe("RT-1200 code-health ratchet: compare", () => {
  it("passes when every count is equal to the baseline", () => {
    expect(compare(counts(5), counts(5))).toEqual({ grew: [], shrank: [], ok: true });
  });

  it("fails and names the metric when one count grows", () => {
    const result = compare({ ...counts(5), jscpdClones: 6 }, counts(5));
    expect(result.ok).toBe(false);
    expect(result.grew).toEqual([{ metric: "jscpdClones", current: 6, baseline: 5 }]);
  });

  it("passes and reports a shrink when a count drops", () => {
    const result = compare({ ...counts(5), biomeCognitiveComplexity: 2 }, counts(5));
    expect(result.ok).toBe(true);
    expect(result.shrank).toEqual([
      { metric: "biomeCognitiveComplexity", current: 2, baseline: 5 },
    ]);
  });

  it("a drop elsewhere does not offset a growth", () => {
    const result = compare({ ...counts(5), jscpdClones: 4, knipUnusedExports: 6 }, counts(5));
    expect(result.ok).toBe(false);
    expect(result.grew.map((g) => g.metric)).toEqual(["knipUnusedExports"]);
  });

  it("throws when a measured count is missing or invalid", () => {
    expect(() => compare(without("jscpdDuplicatedLines", 1), counts(1))).toThrow(BaselineError);
  });
});
