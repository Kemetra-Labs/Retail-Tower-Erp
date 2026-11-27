/**
 * RT-1498 confirm-by-read (review round) — does the return the server recorded carry EXACTLY the refund
 * allocations this till journaled?
 *
 * The status read's matcher (`matchingTotalMinor`) proves the provenance, sale, currency, lines and total.
 * It does not see the refund allocations, yet they are part of the recorded payload (contract
 * `recordReturn`, Idempotency: "The allocation fields are part of that payload (R-3)"), and the payout's
 * refund execution names the JOURNALED `allocationRef`. A read that matched every other field but holds
 * different allocations must not confirm: the execution could not be reconciled. Only the exact POST
 * replay (same bytes, same key) can settle such a return: Backend-Core replays it (200) or refuses the
 * different payload (409).
 *
 * Exact means, per allocation and in order: the same `method`, the same amount (as a decimal value), the
 * same `allocationRef` (both absent, or equal), and `originalTenderRef` and `instrument` exactly as sent
 * (the till sends neither, so the recorded allocation must carry neither: "An absent `instrument` ...
 * hashes differently"). Anything unreadable on either side is no match (fail closed).
 */
import type { WireRecordedTender } from './returns-wire.js';
import { parseAmount4 } from './returns-money.js';

interface JournaledTender {
  readonly method: unknown;
  readonly amount: unknown;
  readonly allocationRef?: unknown;
  readonly originalTenderRef?: unknown;
  readonly instrument?: unknown;
}

function journaledTenders(requestBodyJson: string): readonly JournaledTender[] | null {
  try {
    const body = JSON.parse(requestBodyJson) as { refundTenders?: unknown };
    return Array.isArray(body.refundTenders) ? (body.refundTenders as JournaledTender[]) : null;
  } catch {
    return null;
  }
}

/** Both absent, or the same string (a UUID ref compares without case). */
function sameOptional(sent: unknown, recorded: string | undefined, caseless = false): boolean {
  if (sent === undefined) return recorded === undefined;
  if (typeof sent !== 'string' || recorded === undefined) return false;
  return caseless ? sent.toLowerCase() === recorded.toLowerCase() : sent === recorded;
}

function sameAmount(sent: unknown, recorded: string): boolean {
  if (typeof sent !== 'string') return false;
  const a = parseAmount4(sent);
  const b = parseAmount4(recorded);
  return a !== null && b !== null && a === b;
}

function sameTender(sent: JournaledTender, recorded: WireRecordedTender): boolean {
  return (
    sent.method === recorded.method &&
    sameAmount(sent.amount, recorded.amount) &&
    sameOptional(sent.allocationRef, recorded.allocationRef, true) &&
    sameOptional(sent.originalTenderRef, recorded.originalTenderRef, true) &&
    sameOptional(sent.instrument, recorded.instrument)
  );
}

export function recordedTendersMatchRequest(
  requestBodyJson: string,
  recorded: readonly WireRecordedTender[] | null,
): boolean {
  if (recorded === null) return false;
  const sent = journaledTenders(requestBodyJson);
  if (sent === null || sent.length === 0 || sent.length !== recorded.length) return false;
  return sent.every((tender, i) => {
    const other = recorded[i];
    return other !== undefined && sameTender(tender, other);
  });
}
