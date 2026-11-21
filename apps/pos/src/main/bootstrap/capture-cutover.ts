import type { Logger } from 'pino';
import { machineCodeOf, type DatabaseHandle } from '../db/client.js';
import { recordCaptureCutoverOnce } from '../sales-sync/capture-cutover.js';
import { recordTenderRefsCutoverOnce } from '../sales-sync/tender-refs-cutoff.js';

/** What the boot step closes over from the composition root. */
export interface CaptureCutoverBootDeps {
  /** The open, migrated database handle. */
  db: DatabaseHandle;
  /**
   * The process environment: the two `*_SINCE` variables only seed the first write, and the
   * RT-363 `POS_PULSE_FEATURE_SALE_TENDER_REFS_SINCE` only opts in (the stored row wins after).
   */
  env: Readonly<Record<string, string | undefined>>;
  mainLogger: Logger;
}

/**
 * RT-1379 (RT-1377 decision, Rules 1 to 3) — record the tender and receipt capture instant once,
 * at every start of the build, right after the migrations and before anything can finalize or
 * send a sale: `index.ts` calls it before the paired-workers latch registers the finalize listener
 * and its startup recovery. Paired or not. The decision and the write live in
 * `sales-sync/capture-cutover.ts`; the sale-sync engine reads the stored row
 * (`bootstrap/sale-sync.ts`).
 *
 * Never fatal: a failed write logs a closed-set code (no path, no value) and the engine then runs
 * with both cut-offs off, which keeps every body stable; the next start that writes the row puts
 * the instant after every sale sent meanwhile (Rule 1).
 */
export function recordCaptureCutoverAtBoot(deps: CaptureCutoverBootDeps): void {
  const { db, env, mainLogger } = deps;
  try {
    recordCaptureCutoverOnce({ db, env, now: () => new Date(), logger: mainLogger });
  } catch (err) {
    mainLogger.error({ code: machineCodeOf(err) }, 'sale_sync:capture_cutover_unrecorded');
  }
  // RT-363: the one-tender-per-line instant, recorded once on opt-in (migration 0066). Its own
  // step so a failure of either write never stops the other; a failed one runs with it off.
  try {
    recordTenderRefsCutoverOnce({ db, env, now: () => new Date(), logger: mainLogger });
  } catch (err) {
    mainLogger.error({ code: machineCodeOf(err) }, 'sale_sync:tender_refs_cutover_unrecorded');
  }
}
