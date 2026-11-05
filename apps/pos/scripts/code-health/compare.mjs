// RT-1198: pure comparison of code-health counts against the committed baseline.
// Kept free of I/O so scripts/__tests__/check-code-health.test.ts can test it directly.

/** The metrics the ratchet tracks. Every one is "lower is better". */
export const METRICS = [
  'knipUnusedFiles',
  'knipUnusedExports',
  'knipUnusedTypes',
  'knipUnusedDependencies',
  'knipUnlistedDependencies',
  'knipDuplicateExports',
  'jscpdClones',
  'jscpdDuplicatedLines',
  'eslintComplexity',
  'eslintMaxLinesPerFunction',
  'eslintMaxLines',
  'testsTypeErrors',
];

export class BaselineError extends Error {}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isKnownKey(key) {
  return METRICS.includes(key) || key === '$comment';
}

/** Validates the parsed baseline JSON: every metric present as a non-negative safe integer. */
export function parseBaseline(value) {
  if (!isPlainObject(value)) {
    throw new BaselineError('baseline must be a JSON object');
  }
  const out = {};
  for (const metric of METRICS) {
    if (!isCount(value[metric])) {
      throw new BaselineError(`baseline.${metric} must be a non-negative integer`);
    }
    out[metric] = value[metric];
  }
  const unknown = Object.keys(value).filter((key) => !isKnownKey(key));
  if (unknown.length > 0) {
    throw new BaselineError(`baseline has unknown keys: ${unknown.join(', ')}`);
  }
  return out;
}

/**
 * Compares current counts with the baseline.
 * Returns { grew: [{metric, current, baseline}], shrank: [...], ok: boolean }.
 */
export function compare(current, baseline) {
  const grew = [];
  const shrank = [];
  for (const metric of METRICS) {
    const now = current[metric];
    const base = baseline[metric];
    if (!isCount(now)) {
      throw new BaselineError(`current.${metric} is not a non-negative integer`);
    }
    if (now > base) grew.push({ metric, current: now, baseline: base });
    else if (now < base) shrank.push({ metric, current: now, baseline: base });
  }
  return { grew, shrank, ok: grew.length === 0 };
}
