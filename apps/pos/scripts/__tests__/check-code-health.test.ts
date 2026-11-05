import { describe, expect, it } from 'vitest';

import { BaselineError, METRICS, compare, parseBaseline } from '../code-health/compare.mjs';

function counts(value: number): Record<string, number> {
  return Object.fromEntries(METRICS.map((metric) => [metric, value]));
}

function without(metric: string, value: number): Record<string, number> {
  return Object.fromEntries(METRICS.filter((m) => m !== metric).map((m) => [m, value]));
}

describe('code-health ratchet: parseBaseline', () => {
  it('accepts every metric as a non-negative integer, plus an optional $comment', () => {
    const baseline = { $comment: 'note', ...counts(3) };
    expect(parseBaseline(baseline)).toEqual(counts(3));
  });

  it('rejects a missing, negative, fractional or non-number metric', () => {
    expect(() => parseBaseline(without('knipUnusedFiles', 1))).toThrow(BaselineError);
    expect(() => parseBaseline({ ...counts(1), jscpdClones: -1 })).toThrow(BaselineError);
    expect(() => parseBaseline({ ...counts(1), jscpdClones: 1.5 })).toThrow(BaselineError);
    expect(() => parseBaseline({ ...counts(1), jscpdClones: '2' })).toThrow(BaselineError);
  });

  it('rejects unknown keys so a typo cannot silently drop a metric', () => {
    expect(() => parseBaseline({ ...counts(1), jscpdClone: 4 })).toThrow(
      /unknown keys: jscpdClone/,
    );
  });

  it('rejects a non-object baseline', () => {
    expect(() => parseBaseline(null)).toThrow(BaselineError);
    expect(() => parseBaseline([1, 2])).toThrow(BaselineError);
  });
});

describe('code-health ratchet: compare', () => {
  it('passes when every count is equal to the baseline', () => {
    expect(compare(counts(5), counts(5))).toEqual({ grew: [], shrank: [], ok: true });
  });

  it('fails and names the metric when one count grows', () => {
    const result = compare({ ...counts(5), knipUnusedExports: 6 }, counts(5));
    expect(result.ok).toBe(false);
    expect(result.grew).toEqual([{ metric: 'knipUnusedExports', current: 6, baseline: 5 }]);
  });

  it('passes and reports shrink when a count drops', () => {
    const result = compare({ ...counts(5), testsTypeErrors: 2 }, counts(5));
    expect(result.ok).toBe(true);
    expect(result.shrank).toEqual([{ metric: 'testsTypeErrors', current: 2, baseline: 5 }]);
  });

  it('a drop elsewhere does not offset a growth', () => {
    const result = compare({ ...counts(5), jscpdClones: 4, eslintComplexity: 6 }, counts(5));
    expect(result.ok).toBe(false);
    expect(result.grew.map((g) => g.metric)).toEqual(['eslintComplexity']);
  });

  it('throws when a measured count is missing or invalid', () => {
    expect(() => compare(without('eslintMaxLines', 1), counts(1))).toThrow(BaselineError);
  });
});
