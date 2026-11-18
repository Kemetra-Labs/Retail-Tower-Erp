/**
 * The open shifts of a store, as a public port of `pos-shifts` (RT-1453).
 *
 * Store deletion (its preview and its write: one evaluator) and the Console open-shifts list used to
 * query `shifts`, `users` and `devices` themselves and, for deletion, re-wrote the stuck predicate in
 * SQL. They ask this port instead, on the caller's client, so the caller's transaction and RLS
 * context stay in force, and the stuck verdict is the one `ShiftForceCloseRepository.readVerdict`
 * gives the POS force close, the Console preview and the Console write (RT-1445).
 *
 * The port never writes and takes no lock (a snapshot, not a reservation). The verdict is judged with
 * the Console rule (no caller token excluded), at the transaction's `now()`.
 */
import type { PoolClient } from "pg";

import {
  countOpenStoreShifts,
  listOpenStoreShifts,
  type OpenStoreShiftRecord,
} from "./shift-force-close.facts";
import { ShiftForceCloseRepository, stuckBlockers, type StuckVerdict } from "./shift-force-close.repository";
import { STUCK_THRESHOLD_MINUTES } from "./shift-force-close.service";

interface OpenStoreShiftRead extends OpenStoreShiftRecord {
  /** The three stuck predicates of the Console rule, judged at the transaction's `now()`. */
  readonly verdict: StuckVerdict;
  /** True when a Console force close would pass its stuck rule now: stale, no live session, no live admission. */
  readonly forceCloseEligible: boolean;
}

interface ReadStoreOpenShiftsOptions {
  /** The contract's cap on the list. */
  readonly limit: number;
  readonly order: "newest_first" | "oldest_first";
  /** The stuck threshold; defaults to the one `ShiftForceCloseService` judges with. */
  readonly thresholdMinutes?: number;
}

const repo = new ShiftForceCloseRepository();

/** The open shifts of one store of the tenant with each one's stuck verdict, capped at `options.limit`. */
export async function readStoreOpenShifts(
  client: PoolClient,
  scope: { readonly tenantId: string; readonly storeId: string },
  options: ReadStoreOpenShiftsOptions,
): Promise<OpenStoreShiftRead[]> {
  const rule = { callerTokenId: null, thresholdMinutes: options.thresholdMinutes ?? STUCK_THRESHOLD_MINUTES };
  const records = await listOpenStoreShifts(client, scope, { limit: options.limit, order: options.order });
  const reads: OpenStoreShiftRead[] = [];
  for (const record of records) {
    // sequential: one pg client runs one statement at a time.
    const verdict = await repo.readVerdict(client, record.shift, rule);
    reads.push({ ...record, verdict, forceCloseEligible: stuckBlockers(verdict).length === 0 });
  }
  return reads;
}

/**
 * The same list WITHOUT the per-shift stuck verdict: no `readVerdict` statements. For a caller that
 * only needs the shifts themselves (the deletion write paths take the ids for the fingerprint and
 * refuse on the exact count, so they discard every verdict).
 */
export function listStoreOpenShifts(
  client: PoolClient,
  scope: { readonly tenantId: string; readonly storeId: string },
  options: Pick<ReadStoreOpenShiftsOptions, "limit" | "order">,
): Promise<OpenStoreShiftRecord[]> {
  return listOpenStoreShifts(client, scope, options);
}

/** The exact number of open shifts of the store, with no cap: what a deletion guard decides on. */
export function countStoreOpenShifts(client: PoolClient, storeId: string): Promise<number> {
  return countOpenStoreShifts(client, storeId);
}
