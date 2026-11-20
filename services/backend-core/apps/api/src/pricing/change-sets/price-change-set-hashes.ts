/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — the two hashes `validate` binds a set to (spec 042 §3, §6;
 * RT-1484 comment 17882, decision 3). Pure.
 *
 *   targetStoreSetHash = sha256 of the target Stores as `(storeId, timezone)` pairs sorted by
 *                        Store id (Q-B8: a time-zone change moves `store_local` instants, so it
 *                        changes the hash);
 *   previewHash        = sha256 of the canonical JSON of the materialized lines with their
 *                        classes, the per-Store preview rows, the Zone-membership changes,
 *                        `targetStoreSetHash` and `validatedAtRevision` (§6).
 *
 * Canonical JSON: object keys sorted by code unit at every depth, no whitespace, arrays in their
 * given (deterministic) order. Both hashes are written `sha256:<64 hex>`.
 */
import { createHash } from "node:crypto";

import { compareCodeUnits } from "../../common/compare-code-units";

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/** `value` as canonical JSON (sorted keys at every depth). */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as readonly Json[]).map(canonicalJson).join(",")}]`;
  const obj = value as { readonly [key: string]: Json };
  const keys = Object.keys(obj).sort(compareCodeUnits);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k]!)}`).join(",")}}`;
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** A target Store and its IANA time zone at validation. */
export interface TargetStore {
  readonly storeId: string;
  readonly timezone: string;
}

/** The target Stores sorted by id (the order the hash and `target_stores` use). */
export function sortTargetStores(stores: readonly TargetStore[]): TargetStore[] {
  return [...stores].sort((x, y) => compareCodeUnits(x.storeId, y.storeId));
}

/** sha256 of the sorted `(storeId, timezone)` pairs. */
export function targetStoreSetHash(stores: readonly TargetStore[]): string {
  return sha256(canonicalJson(sortTargetStores(stores).map((s) => [s.storeId, s.timezone])));
}

/** sha256 of the canonical preview (spec 042 §6). */
export function previewHash(input: {
  readonly validatedAtRevision: number;
  readonly targetStoreSetHash: string;
  readonly lines: readonly Json[];
  readonly previewRows: readonly Json[];
  readonly membershipChanges: readonly Json[];
}): string {
  return sha256(
    canonicalJson({
      validatedAtRevision: input.validatedAtRevision,
      targetStoreSetHash: input.targetStoreSetHash,
      lines: input.lines,
      previewRows: input.previewRows,
      membershipChanges: input.membershipChanges,
    }),
  );
}

export type { Json };
