/**
 * RT-363 (G1, RT-264) — the one-tender-per-line capture cutoff, `POS_PULSE_FEATURE_SALE_TENDER_REFS_SINCE`.
 *
 * A sale finalized at/after this instant (and past the tenders cutoff) sends one `tenders` entry
 * per tender line with `tenderRef` and `sequence` (`buildCapturePayload`, `tenderRefsSince`).
 * Unset, blank or not an explicit-zone instant = off: the merged body of today.
 *
 * Operator rule: turn it on only AFTER Backend-Core runs with `POS_SALE_TENDERS_SAME_METHOD_ENABLED`
 * on (RT-360), and set it to an instant at or after "now". The body is rebuilt on every send and
 * Backend-Core answers 409 to a different body under the same Idempotency-Key, so an instant
 * earlier than a sale already attempted, or unsetting it while a sale is still retrying, changes
 * that sale's body. Unlike the two RT-1379 cutoffs it is NOT recorded once in the local
 * database (a local migration is a separate decision); it is read from the environment at boot.
 *
 * Logs carry no instant (closed-set event only).
 */
import { parseTenderRefsSince } from './capture-payload.js';

export const TENDER_REFS_SINCE_ENV = 'POS_PULSE_FEATURE_SALE_TENDER_REFS_SINCE';

export const TENDER_REFS_LOG = {
  unparseable: 'sale_sync:tender_refs_since_unparseable_refs_off',
} as const;

/** The cutoff from the environment: a canonical UTC instant, or null (off; one warning if it was set but invalid). */
export function readTenderRefsSince(
  env: Readonly<Record<string, string | undefined>>,
  logger: { warn(msg: string): void },
): string | null {
  const raw = env[TENDER_REFS_SINCE_ENV];
  const parsed = parseTenderRefsSince(raw);
  if (parsed === null && raw !== undefined && raw.trim() !== '') {
    logger.warn(TENDER_REFS_LOG.unparseable);
  }
  return parsed;
}
