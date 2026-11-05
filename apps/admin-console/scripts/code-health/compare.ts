// RT-1200: pure comparison of code-health counts against the committed baseline.
// Kept free of I/O so tests/unit/code-health.test.ts can test it directly.

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
  "biomeCognitiveComplexity",
] as const;

export type Metric = (typeof METRICS)[number];
export type Counts = Record<Metric, number>;
export interface Change {
  metric: Metric;
  current: number;
  baseline: number;
}

export class BaselineError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isKnownKey(key: string): boolean {
  return (METRICS as readonly string[]).includes(key) || key === "$comment";
}

/** Validates the parsed baseline JSON: every metric present as a non-negative safe integer. */
export function parseBaseline(value: unknown): Counts {
  if (!isPlainObject(value)) {
    throw new BaselineError("baseline must be a JSON object");
  }
  const out = {} as Counts;
  for (const metric of METRICS) {
    const count = value[metric];
    if (!isCount(count)) {
      throw new BaselineError(`baseline.${metric} must be a non-negative integer`);
    }
    out[metric] = count;
  }
  const unknown = Object.keys(value).filter((key) => !isKnownKey(key));
  if (unknown.length > 0) {
    throw new BaselineError(`baseline has unknown keys: ${unknown.join(", ")}`);
  }
  return out;
}

/** Compares current counts with the baseline; ok is false when any count grew. */
export function compare(
  current: Partial<Record<Metric, unknown>>,
  baseline: Counts,
): { grew: Change[]; shrank: Change[]; ok: boolean } {
  const grew: Change[] = [];
  const shrank: Change[] = [];
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
