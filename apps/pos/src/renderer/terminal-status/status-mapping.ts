import type { TerminalStatusSnapshot } from '../../shared/terminal-status/types';
import type { ArabicPluralForms } from '../../shared/formatters/arabic-plural';
import { countedParts, countedText } from './counted-copy';
import { STATUS_COPY } from './status-copy';

/**
 * RT-604 (VN-S6 S6-3) — doc 24 §4.1 as a pure function: main sends facts, the
 * renderer derives the indicator. `rule` is the banner precedence (U2 … U7,
 * first match wins) for S6-4; the indicator always shows connection and sync
 * as separate rows.
 *
 * U1 (not paired / revoked) has no row here: the indicator lives only in the
 * v5 frame, which the router mounts only for a paired, signed-in terminal, and
 * the RT-215 recovery route replaces it on revocation.
 *
 * RT-887: `sync.held` (the discount-held subset of `pending`, RT-856) is never
 * «sending» and never attention. Every sync rule below reads the non-held
 * count, `pending − held`; main sends `oldestPendingAt` for the non-held sales
 * already. The held count is its own neutral row. Absent or 0, nothing changes.
 */

/** D-6-5 = b: a pending sale older than N = 24 h needs a human. */
export const SYNC_ATTENTION_AGE_MS = 24 * 60 * 60 * 1000;

/** The freeze 15 §4 status roles, plus neutral for «checking» (no dot colour). */
export type IndicatorTone = 'success' | 'warning' | 'info' | 'danger' | 'neutral';

export interface IndicatorRow {
  readonly tone: IndicatorTone;
  /** Copy before the count (the whole text when there is no count). */
  readonly before: string;
  /** Rendered as an isolated LTR run with Western digits; null for 1 and 2 (words). */
  readonly count: number | null;
  readonly after: string;
}

export type StatusRule = 'U2' | 'U3' | 'U4' | 'U5' | 'U6' | 'U7';

export interface TerminalStatusView {
  readonly rule: StatusRule;
  readonly connection: IndicatorRow;
  /** Null when nothing is pending and nothing needs attention. */
  readonly sync: IndicatorRow | null;
  /** RT-887: the neutral held-discount row; null when nothing is held. */
  readonly held: IndicatorRow | null;
}

function textRow(tone: IndicatorTone, text: string): IndicatorRow {
  return { tone, before: text, count: null, after: '' };
}

/** RT-646: the count-aware sentence for `count` (doc 15 §5.1). */
function countRow(forms: ArabicPluralForms, count: number): IndicatorRow {
  return { tone: 'info', ...countedParts(count, forms) };
}

/** The row as one string (tests, and anywhere a plain name is needed). */
export function rowText(row: IndicatorRow): string {
  return countedText(row);
}

/** RT-887: the held count, never more than `pending` (two reads in main). */
function heldCount(snapshot: TerminalStatusSnapshot): number {
  return Math.min(snapshot.sync.held ?? 0, snapshot.sync.pending);
}

/** RT-887: the pending sales that are not held — the only ones that send or age. */
function sendablePending(snapshot: TerminalStatusSnapshot): number {
  return snapshot.sync.pending - heldCount(snapshot);
}

/** When the oldest non-held pending sale was queued (ms), or null with none. */
function oldestPendingMs(snapshot: TerminalStatusSnapshot): number | null {
  const { oldestPendingAt } = snapshot.sync;
  if (sendablePending(snapshot) === 0) return null;
  return oldestPendingAt === null ? null : Date.parse(oldestPendingAt);
}

/** The oldest pending sale is older than N = 24 h (D-6-5). */
function isAged(snapshot: TerminalStatusSnapshot, nowMs: number): boolean {
  const oldest = oldestPendingMs(snapshot);
  return oldest !== null && nowMs - oldest > SYNC_ATTENTION_AGE_MS;
}

function needsAttention(snapshot: TerminalStatusSnapshot, nowMs: number): boolean {
  return snapshot.sync.deadLetter > 0 || isAged(snapshot, nowMs);
}

function connectionRow(snapshot: TerminalStatusSnapshot | null): IndicatorRow {
  switch (snapshot?.connection) {
    case 'online':
      return textRow('success', STATUS_COPY.online);
    case 'offline':
    case 'degraded':
      return textRow('warning', STATUS_COPY.offline);
    default:
      return textRow('neutral', STATUS_COPY.checking);
  }
}

/**
 * S16 «sending» only when the terminal is online and the drain is not paused;
 * otherwise M-O2 «waiting» (D-6-6), which is true in every other state.
 */
function syncRow(snapshot: TerminalStatusSnapshot, attention: boolean): IndicatorRow | null {
  if (attention) return textRow('danger', STATUS_COPY.syncAttention);
  const pending = sendablePending(snapshot);
  if (pending === 0) return null;
  const sending = snapshot.connection === 'online' && snapshot.sync.paused === null;
  return countRow(sending ? STATUS_COPY.sending : STATUS_COPY.waiting, pending);
}

/** RT-887: held discounted sales, neutral — not an error and not «sending». */
function heldRow(snapshot: TerminalStatusSnapshot): IndicatorRow | null {
  const held = heldCount(snapshot);
  if (held === 0) return null;
  return { tone: 'neutral', ...countedParts(held, STATUS_COPY.heldDiscount) };
}

function ruleFor(snapshot: TerminalStatusSnapshot, attention: boolean): StatusRule {
  if (attention) return 'U2';
  const { connection, sync } = snapshot;
  if (connection === 'offline' || connection === 'degraded') return 'U3';
  if (connection === 'checking') return 'U7';
  if (sendablePending(snapshot) === 0) return 'U6';
  return sync.paused === null ? 'U4' : 'U5';
}

/** No snapshot yet reads as `checking`, never `online` (doc 24 §2.4). */
export function mapTerminalStatus(
  snapshot: TerminalStatusSnapshot | null,
  nowMs: number,
): TerminalStatusView {
  if (snapshot === null) {
    return { rule: 'U7', connection: connectionRow(null), sync: null, held: null };
  }
  const attention = needsAttention(snapshot, nowMs);
  return {
    rule: ruleFor(snapshot, attention),
    connection: connectionRow(snapshot),
    sync: syncRow(snapshot, attention),
    held: heldRow(snapshot),
  };
}

/** The notices-stack banners (doc 24 §4.3); both show when both hold. */
export interface StatusBanners {
  /** M-O3's ‹n›, or null when nothing needs a human (U2 does not hold). */
  readonly attention: number | null;
  /** M-O1: `offline`, or `degraded` shown as offline (D-6-2). */
  readonly offline: boolean;
}

/**
 * RT-605 (VN-S6 S6-4) — which status banners show. Attention is the same U2
 * test the indicator uses. Its count is the dead letters, plus every pending
 * sale once the oldest has passed 24 h (they wait behind it). No snapshot
 * shows nothing, never a guess. RT-887: held sales are never counted.
 */
export function mapStatusBanners(
  snapshot: TerminalStatusSnapshot | null,
  nowMs: number,
): StatusBanners {
  if (snapshot === null) return { attention: null, offline: false };
  const { connection, sync } = snapshot;
  const offline = connection === 'offline' || connection === 'degraded';
  if (!needsAttention(snapshot, nowMs)) return { attention: null, offline };
  const waiting = isAged(snapshot, nowMs) ? sendablePending(snapshot) : 0;
  return { attention: sync.deadLetter + waiting, offline };
}

/**
 * When the oldest pending sale will pass the 24 h line, so the view can be
 * re-derived once at that moment instead of polling. Null when nothing is
 * pending or a dead letter already decides attention.
 */
export function syncAttentionDueAt(snapshot: TerminalStatusSnapshot | null): number | null {
  if (snapshot === null || snapshot.sync.deadLetter > 0) return null;
  const oldest = oldestPendingMs(snapshot);
  return oldest === null ? null : oldest + SYNC_ATTENTION_AGE_MS;
}

/** D-6-7 = a: a row only while the last print failed; never «جاهز». */
export function printerRow(lastPrintFailed: boolean): IndicatorRow | null {
  return lastPrintFailed ? textRow('warning', STATUS_COPY.printerFailed) : null;
}
