/**
 * RT-1379 (RT-1377 decision, Confluence 77168641, owner-approved 2026-11-13: O-1 option B) —
 * the tender (RT-79) and receipt (RT-540) capture instants, recorded ONCE in the local
 * database (migration 0062, `sale_capture_cutover`) and read back on every later start.
 *
 * A sale's capture body carries `tenders` / `receipt` only when it was finalized at or after
 * these instants (`finalizedAtOrAfter` in `capture-payload.ts`, unchanged). The body is rebuilt
 * on every send and Backend-Core answers 409 to a different body under the same
 * Idempotency-Key, so the instants must never put an already-sent sale on the other side.
 *
 * Rule 1 — `T = max(now, newest parseable sales.finalized_at + 1 ms)`, computed in the same
 *   transaction as the write. "Parseable" is exactly the per-sale test's own: `Date.parse`, not
 *   NaN, compared in milliseconds. Every sale is scanned (any tenant, branch, terminal), so an
 *   old-build sale, even one finalized while the clock ran ahead, stays before T.
 * Rule 2 — a valid environment value (`POS_PULSE_FEATURE_SALE_TENDERS_SINCE` /
 *   `..._RECEIPT_SINCE`, the existing explicit-zone grammar) seeds its own column verbatim (as
 *   the parser's canonical UTC form of the same instant, never moved) at the first write, even when the receipt instant is earlier than the tenders one: a terminal
 *   that already sent under those instants keeps them. Otherwise `tenders_since` is T and
 *   `receipt_since` is `max(T, tenders_since)`. After the first write the stored row wins.
 * Rule 3 — the row arrives with a migration and is append-only (triggers refuse UPDATE and
 *   DELETE); the writer inserts with ON CONFLICT DO NOTHING and returns what is stored.
 *
 * Logs carry no instant (closed-set events only):
 *   • `sale_sync:capture_cutover_recorded` `{ source }` — this start wrote the row;
 *   • `sale_sync:capture_cutover_ahead_of_clock` — a column holds the Rule 1 value and it is
 *     later than the clock at the write, so sales finalized until the clock catches up go
 *     without T/R (a seeded column is the operator's own choice and never warns);
 *   • `sale_sync:capture_cutover_env_ignored` — on a later start, a set variable differs from
 *     the stored column (an invalid value included), or the row was seeded from the
 *     environment and neither variable is set any more. A `first_start` row with no variables
 *     is the normal pilot state and logs nothing;
 *   • the two existing unparseable warnings, whenever a set variable is not a valid instant;
 *   • `sale_sync:capture_cutover_missing_off` — the engine found no readable row (the boot
 *     write failed) and runs with both cut-offs off, which is body-stable: the next start that
 *     writes the row puts T after every sale sent meanwhile (Rule 1).
 */
import type { DatabaseHandle } from '../db/client.js';
import { parseReceiptSince, parseTendersSince } from './capture-payload.js';

export const TENDERS_SINCE_ENV = 'POS_PULSE_FEATURE_SALE_TENDERS_SINCE';
export const RECEIPT_SINCE_ENV = 'POS_PULSE_FEATURE_SALE_RECEIPT_SINCE';

export const CAPTURE_CUTOVER_LOG = {
  recorded: 'sale_sync:capture_cutover_recorded',
  aheadOfClock: 'sale_sync:capture_cutover_ahead_of_clock',
  envIgnored: 'sale_sync:capture_cutover_env_ignored',
  missingOff: 'sale_sync:capture_cutover_missing_off',
  tendersUnparseable: 'sale_sync:tenders_since_unparseable_tenders_off',
  receiptUnparseable: 'sale_sync:receipt_since_unparseable_receipt_off',
} as const;

/** How the row was written; the closed set of migration 0062's `source` CHECK. */
export type CaptureCutoverSource = 'first_start' | 'env_seed';

/** The stored row. */
export interface CaptureCutover {
  tendersSince: string;
  receiptSince: string;
  recordedAt: string;
  source: CaptureCutoverSource;
}

/** What the sale-sync engine is given (`SaleSyncEngineDeps.tendersSince` / `receiptSince`). */
export interface EngineCutoffs {
  tendersSince: string | null;
  receiptSince: string | null;
}

/** The logger surface used here (pino's `info` / `warn`); never given an instant. */
export interface CaptureCutoverLogger {
  info(obj: { source: CaptureCutoverSource }, msg: string): void;
  warn(msg: string): void;
}

export interface CutoverDecisionInput {
  now: Date;
  /** The newest parseable `sales.finalized_at`, in ms (`newestFinalizedAtMs`); null = none. */
  maxFinalizedAt: number | null;
  envTenders?: string | undefined;
  envReceipt?: string | undefined;
}

export interface CutoverDecision {
  tendersSince: string;
  receiptSince: string;
  source: CaptureCutoverSource;
  /** A stored column is the Rule 1 value, and it is later than `now`. */
  aheadOfClock: boolean;
}

/** The newest instant among `finalized_at` values, by the per-sale test's own parse; null if none. */
export function newestFinalizedAtMs(values: Iterable<string>): number | null {
  const parsed = Array.from(values, (value) => Date.parse(value)).filter((ms) => !Number.isNaN(ms));
  // reduce, not Math.max(...parsed): a long sales history must not overflow the argument list.
  return parsed.length === 0 ? null : parsed.reduce((newest, ms) => Math.max(newest, ms));
}

/** Rules 1 and 2: the row the first start writes. Pure. */
export function decideCutover(input: CutoverDecisionInput): CutoverDecision {
  const nowMs = input.now.getTime();
  const ruleOneMs =
    input.maxFinalizedAt === null ? nowMs : Math.max(nowMs, input.maxFinalizedAt + 1);
  const computed = new Date(ruleOneMs).toISOString();
  const seededTenders = parseTendersSince(input.envTenders);
  const seededReceipt = parseReceiptSince(input.envReceipt);
  const tendersSince = seededTenders ?? computed;
  const receiptSince =
    seededReceipt ?? (Date.parse(tendersSince) > ruleOneMs ? tendersSince : computed);
  const usesRuleOne = [tendersSince, receiptSince].includes(computed);
  return {
    tendersSince,
    receiptSince,
    source: seededTenders !== null || seededReceipt !== null ? 'env_seed' : 'first_start',
    // Only when a stored column is the Rule 1 value: a seeded column is the operator's own.
    aheadOfClock: usesRuleOne && ruleOneMs > nowMs,
  };
}

/** The narrow better-sqlite3 statement surface this module uses (sql.js in tests). */
interface Statement<Row> {
  get(): Row | undefined;
  all(): Row[];
  run(...params: unknown[]): { changes: number };
}

const SELECT_ROW = `SELECT tenders_since, receipt_since, recorded_at, source
                    FROM sale_capture_cutover WHERE id = 1`;
const SELECT_FINALIZED_AT = 'SELECT finalized_at FROM sales';
// Never REPLACE: a conflict keeps the first row (the triggers refuse an edit).
const INSERT_ONCE = `INSERT INTO sale_capture_cutover
                       (id, tenders_since, receipt_since, recorded_at, source)
                     VALUES (1, ?, ?, ?, ?)
                     ON CONFLICT (id) DO NOTHING`;

interface StoredRow {
  tenders_since: unknown;
  receipt_since: unknown;
  recorded_at: unknown;
  source: unknown;
}

function isSource(value: unknown): value is CaptureCutoverSource {
  return value === 'first_start' || value === 'env_seed';
}

/** The stored row; null when there is none or it is not well-formed (then both cut-offs are off). */
export function readCaptureCutover(db: Pick<DatabaseHandle, 'prepare'>): CaptureCutover | null {
  const row = (db.prepare(SELECT_ROW) as Statement<StoredRow>).get();
  if (row === undefined) return null;
  const { tenders_since, receipt_since, recorded_at, source } = row;
  if (typeof tenders_since !== 'string' || parseTendersSince(tenders_since) === null) return null;
  if (typeof receipt_since !== 'string' || parseReceiptSince(receipt_since) === null) return null;
  if (typeof recorded_at !== 'string' || !isSource(source)) return null;
  return {
    tendersSince: tenders_since,
    receiptSince: receipt_since,
    recordedAt: recorded_at,
    source,
  };
}

export interface RecordCaptureCutoverDeps {
  db: Pick<DatabaseHandle, 'prepare' | 'transaction'>;
  /** The process environment; only the two variables above are read. */
  env: Readonly<Record<string, string | undefined>>;
  now: () => Date;
  logger: CaptureCutoverLogger;
}

function isSet(raw: string | undefined): raw is string {
  return raw !== undefined && raw.trim() !== '';
}

function warnUnparseable(env: RecordCaptureCutoverDeps['env'], logger: CaptureCutoverLogger): void {
  const tenders = env[TENDERS_SINCE_ENV];
  if (isSet(tenders) && parseTendersSince(tenders) === null) {
    logger.warn(CAPTURE_CUTOVER_LOG.tendersUnparseable);
  }
  const receipt = env[RECEIPT_SINCE_ENV];
  if (isSet(receipt) && parseReceiptSince(receipt) === null) {
    logger.warn(CAPTURE_CUTOVER_LOG.receiptUnparseable);
  }
}

/** Whether a later start's environment differs from the stored row (see the module note). */
function envDiffers(env: RecordCaptureCutoverDeps['env'], stored: CaptureCutover): boolean {
  const tenders = env[TENDERS_SINCE_ENV];
  const receipt = env[RECEIPT_SINCE_ENV];
  if (!isSet(tenders) && !isSet(receipt)) return stored.source === 'env_seed';
  const differs = (raw: string | undefined, parsed: string | null, column: string): boolean =>
    isSet(raw) && (parsed === null || Date.parse(parsed) !== Date.parse(column));
  return (
    differs(tenders, parseTendersSince(tenders), stored.tendersSince) ||
    differs(receipt, parseReceiptSince(receipt), stored.receiptSince)
  );
}

type WriteOutcome = { stored: CaptureCutover | null; written: CutoverDecision | null };

function readOrWrite(deps: RecordCaptureCutoverDeps): WriteOutcome {
  const { db, env, now } = deps;
  return db.transaction((): WriteOutcome => {
    const existing = readCaptureCutover(db);
    if (existing !== null) return { stored: existing, written: null };
    const finalized = (db.prepare(SELECT_FINALIZED_AT) as Statement<{ finalized_at: unknown }>)
      .all()
      .flatMap((r) => (typeof r.finalized_at === 'string' ? [r.finalized_at] : []));
    const at = now();
    const decision = decideCutover({
      now: at,
      maxFinalizedAt: newestFinalizedAtMs(finalized),
      envTenders: env[TENDERS_SINCE_ENV],
      envReceipt: env[RECEIPT_SINCE_ENV],
    });
    const { changes } = (db.prepare(INSERT_ONCE) as Statement<never>).run(
      decision.tendersSince,
      decision.receiptSince,
      at.toISOString(),
      decision.source,
    );
    return { stored: readCaptureCutover(db), written: changes === 1 ? decision : null };
  })();
}

/**
 * Read the row, or write it once (Rules 1 and 2) and return what is stored. Runs at boot, right
 * after the migrations (`bootstrap/capture-cutover.ts`). Throws on a database error, or when no
 * well-formed row can be stored (the caller logs and goes on; the engine then runs off).
 */
export function recordCaptureCutoverOnce(deps: RecordCaptureCutoverDeps): CaptureCutover {
  const { env, logger } = deps;
  warnUnparseable(env, logger);
  const { stored, written } = readOrWrite(deps);
  if (stored === null) throw new Error('sale_capture_cutover holds no readable row');
  if (written !== null) {
    logger.info({ source: written.source }, CAPTURE_CUTOVER_LOG.recorded);
    if (written.aheadOfClock) logger.warn(CAPTURE_CUTOVER_LOG.aheadOfClock);
  } else if (envDiffers(env, stored)) {
    logger.warn(CAPTURE_CUTOVER_LOG.envIgnored);
  }
  return stored;
}

/**
 * The engine's cut-offs: the stored row, read on the open handle. No row, or a read that
 * throws, gives both off with one warning (today's default, which is body-stable).
 */
export function readEngineCutoffs(
  db: Pick<DatabaseHandle, 'prepare'>,
  logger: Pick<CaptureCutoverLogger, 'warn'>,
): EngineCutoffs {
  let stored: CaptureCutover | null = null;
  try {
    stored = readCaptureCutover(db);
  } catch {
    stored = null;
  }
  if (stored === null) {
    logger.warn(CAPTURE_CUTOVER_LOG.missingOff);
    return { tendersSince: null, receiptSince: null };
  }
  return { tendersSince: stored.tendersSince, receiptSince: stored.receiptSince };
}
