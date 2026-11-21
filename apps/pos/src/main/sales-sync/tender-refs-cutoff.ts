/**
 * RT-363 (G1, RT-264) fix-forward — the one-tender-per-line capture instant, recorded ONCE in
 * the local database (migration 0066, `sale_tender_refs_cutover`), the way RT-1379 records the
 * tender and receipt instants (`capture-cutover.ts`, migration 0062).
 *
 * A sale finalized at/after this instant (and past the tenders instant) sends one `tenders`
 * entry per tender line with `tenderRef` and `sequence` (`buildCapturePayload`,
 * `tenderRefsSince`). The body is rebuilt on every send and Backend-Core answers 409 to a
 * different body under the same Idempotency-Key, so once a sale may have been sent the instant
 * must never move. It used to be read from the environment at every start, so a variable that
 * was removed, lost or moved changed the body of a sale still retrying.
 *
 * Opt-in, unlike 0062. The per-line body must not reach Backend-Core before its same-method
 * flag `POS_SALE_TENDERS_SAME_METHOD_ENABLED` is on (RT-360), so the first start of a build
 * writes nothing: no row means off.
 *   Rule 1 — the first start whose environment holds a valid `POS_PULSE_FEATURE_SALE_TENDER_REFS_SINCE`
 *     (the existing explicit-zone grammar) writes the row, in one transaction:
 *     `T = max(value, now, newest parseable sales.finalized_at + 1 ms)`. The variable only says
 *     "not before"; T is never earlier than the clock or than a sale that may already have
 *     been attempted.
 *   Rule 2 — after that the stored row wins, whatever the environment says. Removing or losing
 *     the variable changes nothing. A value later than the stored instant, or one that is not
 *     a valid instant, is ignored with one warning (`tender_refs_env_ignored`); an equal or
 *     earlier one is already honoured and logs nothing.
 *   Rule 3 — the row is append-only (triggers refuse UPDATE and DELETE; the writer inserts with
 *     ON CONFLICT DO NOTHING). There is no kill switch: turning the per-line body off later is
 *     by hand (the 0066 rollback note), after the outbox has drained.
 *
 * Logs carry no instant (closed-set events only).
 */
import type { DatabaseHandle } from '../db/client.js';
import { newestSaleFinalizedAtMs } from './capture-cutover.js';
import { parseTenderRefsSince } from './capture-payload.js';

export const TENDER_REFS_SINCE_ENV = 'POS_PULSE_FEATURE_SALE_TENDER_REFS_SINCE';

export const TENDER_REFS_LOG = {
  recorded: 'sale_sync:tender_refs_cutover_recorded',
  envIgnored: 'sale_sync:tender_refs_env_ignored',
  unparseable: 'sale_sync:tender_refs_since_unparseable_refs_off',
  readFailedOff: 'sale_sync:tender_refs_cutover_read_failed_off',
} as const;

/** The logger surface used here (pino's `info` / `warn` with a message only); never given an instant. */
interface TenderRefsLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

interface TenderRefsDecisionInput {
  now: Date;
  /** The newest parseable `sales.finalized_at`, in ms (`newestFinalizedAtMs`); null = none. */
  maxFinalizedAt: number | null;
  /** The raw environment value. */
  env: string | undefined;
}

/** Rule 1: the instant to store, or null when the environment does not opt in. Pure. */
export function decideTenderRefsSince(input: TenderRefsDecisionInput): string | null {
  const requested = parseTenderRefsSince(input.env);
  if (requested === null) return null;
  const floorMs = Math.max(
    input.now.getTime(),
    input.maxFinalizedAt === null ? Number.NEGATIVE_INFINITY : input.maxFinalizedAt + 1,
  );
  return new Date(Math.max(Date.parse(requested), floorMs)).toISOString();
}

/** The narrow better-sqlite3 statement surface this module uses (sql.js in tests). */
interface Statement<Row> {
  get(): Row | undefined;
  run(...params: unknown[]): { changes: number };
}

const SELECT_ROW = 'SELECT tender_refs_since FROM sale_tender_refs_cutover WHERE id = 1';
// Never REPLACE: a conflict keeps the first row (the triggers refuse an edit).
const INSERT_ONCE = `INSERT INTO sale_tender_refs_cutover (id, tender_refs_since, recorded_at, source)
                     VALUES (1, ?, ?, 'env_opt_in')
                     ON CONFLICT (id) DO NOTHING`;

/** The stored instant; null when there is no row, or it is not a well-formed instant (then off). */
function readStored(db: Pick<DatabaseHandle, 'prepare'>): {
  stored: string | null;
  present: boolean;
} {
  const row = (db.prepare(SELECT_ROW) as Statement<{ tender_refs_since: unknown }>).get();
  if (row === undefined) return { stored: null, present: false };
  const raw = row.tender_refs_since;
  return { stored: typeof raw === 'string' ? parseTenderRefsSince(raw) : null, present: true };
}

interface RecordTenderRefsDeps {
  db: Pick<DatabaseHandle, 'prepare' | 'transaction'>;
  /** The process environment; only the variable above is read. */
  env: Readonly<Record<string, string | undefined>>;
  now: () => Date;
  logger: TenderRefsLogger;
}

/** Whether the environment asks for an instant the stored row does not honour (Rule 2). */
function envNotHonoured(raw: string | undefined, stored: string | null): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  const requested = parseTenderRefsSince(raw);
  return requested === null || stored === null || Date.parse(requested) > Date.parse(stored);
}

function writeOnce(deps: RecordTenderRefsDeps, raw: string | undefined): boolean {
  const { db, now } = deps;
  return db.transaction((): boolean => {
    if (readStored(db).present) return false;
    const at = now();
    const since = decideTenderRefsSince({
      now: at,
      maxFinalizedAt: newestSaleFinalizedAtMs(db),
      env: raw,
    });
    if (since === null) return false;
    const { changes } = (db.prepare(INSERT_ONCE) as Statement<never>).run(since, at.toISOString());
    return changes === 1;
  })();
}

/**
 * Read the row, or write it once (Rule 1) when the environment opts in, and return the stored
 * instant (null = off). Runs at boot, right after the migrations (`bootstrap/capture-cutover.ts`).
 * Throws on a database error (the caller logs and the engine then runs with the cutoff off).
 */
export function recordTenderRefsCutoverOnce(deps: RecordTenderRefsDeps): string | null {
  const { db, env, logger } = deps;
  const raw = env[TENDER_REFS_SINCE_ENV];
  const isSet = raw !== undefined && raw.trim() !== '';
  if (isSet && parseTenderRefsSince(raw) === null && !readStored(db).present) {
    logger.warn(TENDER_REFS_LOG.unparseable);
    return null;
  }
  const written = writeOnce(deps, raw);
  const { stored } = readStored(db);
  if (written) logger.info(TENDER_REFS_LOG.recorded);
  else if (envNotHonoured(raw, stored)) logger.warn(TENDER_REFS_LOG.envIgnored);
  return stored;
}

/**
 * The engine's and the quarantine uploader's cutoff: the stored instant, read on the open
 * handle. No row is the normal off state and logs nothing; a read that throws, or a row that
 * is not a valid instant, is off with one warning (body-stable).
 */
export function readTenderRefsSince(
  db: Pick<DatabaseHandle, 'prepare'>,
  logger: Pick<TenderRefsLogger, 'warn'>,
): string | null {
  try {
    const { stored, present } = readStored(db);
    if (present && stored === null) logger.warn(TENDER_REFS_LOG.readFailedOff);
    return stored;
  } catch {
    logger.warn(TENDER_REFS_LOG.readFailedOff);
    return null;
  }
}
