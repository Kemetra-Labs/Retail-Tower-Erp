// RT-1199: pure comparison of code-health counts against the committed baseline.
// Kept free of I/O so tools/code-health/__tests__/compare.spec.mjs can test it directly.
//
// RT-1295: the eslintMaxLines count alone let a file that is already over `max-lines` grow
// without failing. The baseline therefore also records, in `oversizedFiles`, each over-limit
// file's line count as the max-lines rule counts it (code lines: blank and comment lines
// skipped). Such a file may not grow, and no new file may go over the limit.

/** The metrics the ratchet tracks. Every one is "lower is better". */
export const METRICS = [
  "knipUnusedFiles",
  "knipUnusedExports",
  "knipUnusedTypes",
  "knipUnusedDependencies",
  "knipUnlistedDependencies",
  "knipDuplicateExports",
  "jscpdClones",
  "jscpdDuplicatedLines",
  "eslintComplexity",
  "eslintMaxLinesPerFunction",
  "eslintMaxLines",
];

export class BaselineError extends Error {}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isKnownKey(key) {
  return METRICS.includes(key) || key === "$comment" || key === "oversizedFiles";
}

/** Validates `oversizedFiles`: { "<path from services/backend-core>": <code lines> }. */
function parseOversizedFiles(value) {
  if (!isPlainObject(value)) {
    throw new BaselineError("baseline.oversizedFiles must be an object of file path to line count");
  }
  for (const [file, lines] of Object.entries(value)) {
    if (!isCount(lines)) {
      throw new BaselineError(`baseline.oversizedFiles["${file}"] must be a non-negative integer`);
    }
  }
  return { ...value };
}

/**
 * Validates the parsed baseline JSON: every metric present as a non-negative safe integer, and
 * `oversizedFiles` (required, so the per-file ratchet cannot be dropped by deleting the key).
 */
export function parseBaseline(value) {
  if (!isPlainObject(value)) {
    throw new BaselineError("baseline must be a JSON object");
  }
  const out = {};
  for (const metric of METRICS) {
    if (!isCount(value[metric])) {
      throw new BaselineError(`baseline.${metric} must be a non-negative integer`);
    }
    out[metric] = value[metric];
  }
  out.oversizedFiles = parseOversizedFiles(value.oversizedFiles);
  const unknown = Object.keys(value).filter((key) => !isKnownKey(key));
  if (unknown.length > 0) {
    throw new BaselineError(`baseline has unknown keys: ${unknown.join(", ")}`);
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

/**
 * Compares each over-`max-lines` file's line count with the baseline (RT-1295).
 * `current` and `baseline` map a file path to its counted lines.
 * Returns {
 *   grew:   [{file, current, baseline}]  an over-limit file gained lines (fails),
 *   added:  [{file, current}]            a file newly over the limit (fails),
 *   shrank: [{file, current, baseline}]  an over-limit file lost lines, or (current 0) is no
 *                                        longer over the limit (passes; lower the baseline),
 *   ok: boolean
 * }.
 */
export function compareOversizedFiles(current, baseline) {
  const grew = [];
  const added = [];
  const shrank = [];
  for (const [file, now] of Object.entries(current)) {
    if (!isCount(now)) {
      throw new BaselineError(`current oversizedFiles["${file}"] is not a non-negative integer`);
    }
    const base = baseline[file];
    if (base === undefined) added.push({ file, current: now });
    else if (now > base) grew.push({ file, current: now, baseline: base });
    else if (now < base) shrank.push({ file, current: now, baseline: base });
  }
  for (const [file, base] of Object.entries(baseline)) {
    if (!Object.hasOwn(current, file)) shrank.push({ file, current: 0, baseline: base });
  }
  return { grew, added, shrank, ok: grew.length === 0 && added.length === 0 };
}

/**
 * The line count in an ESLint 8 `max-lines` message ("File has too many lines (1028). Maximum
 * allowed is 800."), or null when the text does not match.
 */
export function maxLinesActual(message) {
  const match = /^File has too many lines \((\d+)\)\./.exec(message ?? "");
  return match ? Number(match[1]) : null;
}
