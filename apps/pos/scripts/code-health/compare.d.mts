// RT-1198: types for compare.mjs, so the TypeScript unit test is type-checked and lint-clean.

export declare const METRICS: readonly string[];

export declare class BaselineError extends Error {}

export type Counts = Record<string, number>;

export interface Change {
  metric: string;
  current: number;
  baseline: number;
}

export declare function parseBaseline(value: unknown): Counts;

export declare function compare(
  current: Counts,
  baseline: Counts,
): { grew: Change[]; shrank: Change[]; ok: boolean };
