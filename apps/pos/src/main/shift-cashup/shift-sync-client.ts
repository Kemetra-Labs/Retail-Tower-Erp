/**
 * RT-17 slice 3 part 2 — `createShiftSyncClient`: sends ONE queued shift fact
 * to Backend-Core on the DEVICE path (`pos-shifts.openapi.yaml` 1.1.0-draft,
 * `openShift` / `recordCashMovement` / `closeShift`).
 *
 * What is sent. The fact's STORED request body, byte for byte, and its STORED
 * `Idempotency-Key` (both decided once, when the fact was recorded; RT-17
 * 10931 / 10934), with `Authorization: Bearer <device token>`. The path comes
 * from the fact's kind and its shift id. The client never builds, parses or
 * re-serialises a body, so every retry is the same request.
 *
 * Never sent:
 *   • an `envelope` row (a manager-envelope repair of a dead letter, 10919
 *     decision 4, or — RT-554 — a manager's forced close). Its body has no
 *     `operatorUserId`; it is never sent with the device bearer → `not_sent`
 *     `envelope_path` from the device methods. `sendEnvelope` is its own
 *     method, below;
 *   • a fact handed to the method of another kind → `not_sent` `kind_mismatch`;
 *   • without a device token (unpaired, revoked, a failing secret-store read)
 *     → `not_sent` `no_device_credential`;
 *   • under any terminal but the fact's own (RT-221): the current pairing is
 *     read before and between two token reads and once more, synchronously,
 *     right before the request, as the sale client does (Codex P2 on #547). A
 *     re-pair during the reads → `not_sent` `terminal_changed`.
 *
 * Outcome mapping (from the status; the body is read only to label a refusal):
 *   200 / 201 → `ok`, a first record or a replay (`Idempotent-Replayed`);
 *   425 / 429 → `transient` with the parsed `Retry-After` (RT-194);
 *   5xx, an unexpected 2xx / 3xx → `transient`;
 *   transport fault or timeout → `no_connection`;
 *   401 → `device_unauthorized` (the device credential; the fact stays queued);
 *   403 → `rejected` `cashier_claim_refused` (the generic `refused`; never a
 *     revocation; the body is not read);
 *   400 / 404 / 409 / 422 → `rejected` with the contract's `error.code` when
 *     it is one the contract documents for that status, else `rejected`
 *     (any other 4xx too). RT-1442: 409 `shift_force_closed` is one of them;
 *     the engine treats it (and a movement's `shift_closed`) as final for the
 *     shift, not as a dead letter that blocks the terminal.
 *
 * RT-215: every answer is reported to the device-401 detector through
 * `withDeviceCallObservation`, tagged `sale_sync` (`SHIFT_SYNC_DEVICE_SOURCE`).
 * The tag names the device-path outbox sync family, which the shift drain
 * joins: a new tag would change the closed `DeviceRevokedSource` set carried
 * by the `pairing.device_revoked` audit payload and the RT-215 detector in
 * `src/main/pairing/`, and the sale-sync tag already means "a device-only
 * fetch whose every answer counts".
 *
 * Never logged, never in a result: the token, the body, server text (P7).
 *
 * RT-1209: the HTTP exchange (bearer, timeout, bounded body, transport faults) runs on the shared
 * Backend-Core transport (`../http/transport.ts`); the outcome mapping above is unchanged. The
 * transport reads every answer body and reports a body that cannot be read as `null`, the same as
 * no answer at all. This client reads the body only to label a refusal, so it keeps the response
 * the fetch resolved with and maps a body-read failure from that status (a refusal: `rejected`).
 * Two deliberate differences: a refusal body over 2 MB (declared or streamed) is not read, so it is
 * the generic `rejected`; and every answer body is now read before mapping, so a slow body delays
 * the result (still bounded by the request timeout, so the drain bound holds), never changes it.
 */
import { createBackendTransport, type BackendAnswer, type FetchLike } from '../http/transport.js';
import {
  withDeviceCallObservation,
  type DeviceAuthDetector,
} from '../pairing/device-auth-detector.js';
import { parseRetryAfterMs } from '../sales-sync/retry-after.js';
import type { QueuedShiftFact, ShiftSyncDeadLetterReason } from './shift-cashup-repo.js';
import type { ShiftFactKind } from './shift-wire.js';

/** The RT-215 detector tag of the shift drain's device fetch (see the header). */
export const SHIFT_SYNC_DEVICE_SOURCE = 'sale_sync' as const;

const SHIFTS_PATH = '/api/pos/v1/shifts';
/** The default request timeout (also the bound of a stopping worker's drain). */
export const SHIFT_SYNC_REQUEST_TIMEOUT_MS = 15_000;
/** The largest answer body read, in bytes (a shift answer or refusal is a few KB at most). */
const SHIFT_SYNC_MAX_BODY_BYTES = 2_000_000;

/** One fact to send, with the terminal it was recorded on (the drain's scope). */
export interface ShiftSyncSend {
  terminalId: string;
  fact: QueuedShiftFact;
}

export type ShiftSyncNotSentReason =
  | 'envelope_path'
  | 'no_envelope_credential'
  | 'kind_mismatch'
  | 'no_device_credential'
  | 'terminal_changed';

export type ShiftSyncResult =
  | { kind: 'ok' }
  | { kind: 'transient'; retryAfterMs?: number }
  | { kind: 'no_connection' }
  | { kind: 'device_unauthorized' }
  /**
   * RT-554: the manager envelope was refused (401). A retry, never a dead
   * letter: signing in again mints a new one (the re-auth refreshes the JWT only).
   */
  | { kind: 'envelope_unauthorized' }
  | { kind: 'rejected'; reason: ShiftSyncDeadLetterReason }
  | { kind: 'not_sent'; reason: ShiftSyncNotSentReason };

/** One method per contract operation; each resolves, never rejects. */
export interface ShiftSyncClient {
  openShift(input: ShiftSyncSend): Promise<ShiftSyncResult>;
  recordCashMovement(input: ShiftSyncSend): Promise<ShiftSyncResult>;
  closeShift(input: ShiftSyncSend): Promise<ShiftSyncResult>;
  /**
   * RT-554: sends ONE `envelope` row (any kind) under the current manager /
   * admin's envelope. Absent on a client built without an envelope reader.
   */
  sendEnvelope?: (input: ShiftSyncSend) => Promise<ShiftSyncResult>;
}

export interface CreateShiftSyncClientDeps {
  /** Backend-Core base URL. */
  baseUrl: string;
  /** The device-path fetch (production: the global fetch). */
  fetch: FetchLike;
  /** RT-215: the device-401 detector every answer is reported to. */
  detector: Pick<DeviceAuthDetector, 'observe'>;
  /** The paired terminal's device token, read fresh per send; null when none. */
  getDeviceToken: () => Promise<string | null>;
  /** The current pairing's `terminal_id`, synchronously; null when unpaired. */
  currentTerminalId: () => string | null;
  /**
   * RT-554: the CURRENT session's manager / admin envelope (016 seam), read
   * fresh per send; null when none (no session, a cashier, locked). Absent:
   * envelope rows are never sent. Never logged, never in a result.
   */
  getEnvelope?: () => string | null;
  timeoutMs?: number;
  /** Epoch-ms clock for an HTTP-date `Retry-After`. Defaults to `Date.now`. */
  nowMs?: () => number;
}

/** The contract path of a fact: the kind decides the operation, the shift id the resource. */
export function shiftFactPath(fact: Pick<QueuedShiftFact, 'factKind' | 'shiftId'>): string {
  if (fact.factKind === 'open') return SHIFTS_PATH;
  const operation = fact.factKind === 'movement' ? 'cash-movements' : 'close';
  return `${SHIFTS_PATH}/${encodeURIComponent(fact.shiftId)}/${operation}`;
}

/**
 * The refusal codes the contract documents per status (`OpenShiftConflict`,
 * `CashMovementConflict`, `CloseShiftConflict`, `CloseShiftUnprocessable`,
 * `ShiftNotFound`, `ValidationFailure`), as 0043 dead-letter reasons.
 */
const CONTRACT_CODES: ReadonlyMap<number, ReadonlySet<string>> = new Map([
  [400, new Set(['validation_error'])],
  [404, new Set(['shift_not_found'])],
  [
    409,
    new Set([
      'idempotency_key_conflict',
      'shift_payload_conflict',
      'shift_already_open',
      'shift_closed',
      // RT-1442 (RT-742 Late facts): a manager closed the shift without a count.
      'shift_force_closed',
    ]),
  ],
  [422, new Set(['shift_cashup_inconsistent', 'currency_mismatch', 'refund_ref_invalid'])],
]);

const OK_STATUSES: ReadonlySet<number> = new Set([200, 201]);
const RETRY_AFTER_STATUSES: ReadonlySet<number> = new Set([425, 429]);

type StatusClass = 'ok' | 'retry_after' | 'transient' | 'unauthorized' | 'refused' | 'rejected';

/** The class of an HTTP status (no body needed). */
function classifyStatus(status: number): StatusClass {
  if (OK_STATUSES.has(status)) return 'ok';
  if (RETRY_AFTER_STATUSES.has(status)) return 'retry_after';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'refused';
  if (status >= 500) return 'transient';
  return status >= 400 ? 'rejected' : 'transient';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `error.code` of a parsed `ApiError` body, or null. Pure; never throws. */
function errorCodeOf(json: unknown): string | null {
  const error = isRecord(json) ? json['error'] : undefined;
  const code = isRecord(error) ? error['code'] : undefined;
  return typeof code === 'string' ? code : null;
}

/** One HTTP answer: the status, the parsed body (undefined when unread) and `Retry-After`. */
interface ShiftAnswer {
  readonly status: number;
  readonly json: unknown;
  readonly retryAfter: string | null;
}

/** The dead-letter reason of a refusal: a documented code of its status, else `rejected`. */
function refusalReason(answer: ShiftAnswer): ShiftSyncDeadLetterReason {
  const code = errorCodeOf(answer.json);
  const documented = CONTRACT_CODES.get(answer.status)?.has(code ?? '') === true;
  return documented ? (code as ShiftSyncDeadLetterReason) : 'rejected';
}

/**
 * The answer of one exchange: the transport's; else (its body could not be read) the status and
 * `Retry-After` of the response the fetch resolved with, body unread; null when none arrived.
 */
function answerOf(sent: BackendAnswer | null, arrived: Response | undefined): ShiftAnswer | null {
  if (sent !== null) {
    const retryAfter = sent.headers?.['retry-after'] ?? null;
    return { status: sent.status, json: sent.json, retryAfter };
  }
  if (arrived === undefined) return null;
  return {
    status: arrived.status,
    json: undefined,
    retryAfter: arrived.headers.get('Retry-After'),
  };
}

/** The credential an answer is mapped for: its 401 and 403 mean different things. */
type SendPath = 'device' | 'envelope';

type TokenRead =
  | { kind: 'token'; token: string }
  | { kind: 'not_sent'; reason: ShiftSyncNotSentReason };

export function createShiftSyncClient(deps: CreateShiftSyncClientDeps): ShiftSyncClient {
  const timeoutMs = deps.timeoutMs ?? SHIFT_SYNC_REQUEST_TIMEOUT_MS;
  const nowMs = deps.nowMs ?? Date.now;
  // RT-215: every answer of this device-only fetch counts for the detector.
  const deviceFetch = withDeviceCallObservation(
    deps.fetch,
    deps.detector,
    SHIFT_SYNC_DEVICE_SOURCE,
  );

  /** The current pairing is `terminalId` right now (fail closed). */
  function onTerminal(terminalId: string): boolean {
    try {
      return deps.currentTerminalId() === terminalId;
    } catch {
      return false;
    }
  }

  /** The device token; null when none or the read fails. */
  async function readToken(): Promise<string | null> {
    try {
      const token = await deps.getDeviceToken();
      return token === null || token.length === 0 ? null : token;
    } catch {
      return null;
    }
  }

  /** The token of the fact's terminal: terminal, token, terminal, token again. */
  async function tokenOf(terminalId: string): Promise<TokenRead> {
    const changed: TokenRead = { kind: 'not_sent', reason: 'terminal_changed' };
    if (!onTerminal(terminalId)) return changed;
    const token = await readToken();
    if (token === null) return { kind: 'not_sent', reason: 'no_device_credential' };
    if (!onTerminal(terminalId)) return changed;
    return (await readToken()) === token ? { kind: 'token', token } : changed;
  }

  /** RT-194 `Retry-After`; a failing clock leaves the normal backoff in charge. */
  function retryAfter(answer: ShiftAnswer): ShiftSyncResult {
    try {
      const retryAfterMs = parseRetryAfterMs(answer.retryAfter, nowMs());
      return retryAfterMs === undefined
        ? { kind: 'transient' }
        : { kind: 'transient', retryAfterMs };
    } catch {
      return { kind: 'transient' };
    }
  }

  type Outcomes = Readonly<Record<StatusClass, (answer: ShiftAnswer) => ShiftSyncResult>>;
  const shared: Pick<Outcomes, 'ok' | 'retry_after' | 'transient' | 'rejected'> = {
    ok: () => ({ kind: 'ok' }),
    retry_after: retryAfter,
    transient: () => ({ kind: 'transient' }),
    rejected: (answer) => ({ kind: 'rejected', reason: refusalReason(answer) }),
  };
  const outcomes: Readonly<Record<SendPath, Outcomes>> = {
    device: {
      ...shared,
      unauthorized: () => ({ kind: 'device_unauthorized' }),
      refused: () => ({ kind: 'rejected', reason: 'cashier_claim_refused' }),
    },
    envelope: {
      ...shared,
      unauthorized: () => ({ kind: 'envelope_unauthorized' }),
      refused: () => ({ kind: 'rejected', reason: 'rejected' }),
    },
  };

  async function post(input: {
    fact: QueuedShiftFact;
    token: string;
    path: SendPath;
  }): Promise<ShiftSyncResult> {
    const { fact } = input;
    // An envelope answer is not a device answer: only the device path feeds the RT-215 detector.
    const fetchImpl = input.path === 'device' ? deviceFetch : deps.fetch;
    // Keep the response the fetch resolved with: an answer whose body breaks is still an answer.
    const probe: { arrived?: Response } = {};
    const transport = createBackendTransport({
      baseUrl: deps.baseUrl,
      fetch: async (url, init) => {
        probe.arrived = await fetchImpl(url, init);
        return probe.arrived;
      },
      timeoutMs,
      maxBodyBytes: SHIFT_SYNC_MAX_BODY_BYTES,
    });
    const sent = await transport.send({
      method: 'POST',
      path: shiftFactPath(fact),
      bearer: input.token,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': fact.idempotencyKey },
      body: fact.requestBody,
      readHeaders: ['Retry-After'],
    });
    const answer = answerOf(sent, probe.arrived);
    if (answer === null) return { kind: 'no_connection' };
    return outcomes[input.path][classifyStatus(answer.status)](answer);
  }

  /** Why `fact` cannot go out through the method of `kind` on the device path, or null. */
  function refusalToSend(input: {
    kind: ShiftFactKind;
    fact: QueuedShiftFact;
  }): ShiftSyncNotSentReason | null {
    if (input.fact.authPath !== 'device') return 'envelope_path';
    return input.fact.factKind === input.kind ? null : 'kind_mismatch';
  }

  async function send(kind: ShiftFactKind, input: ShiftSyncSend): Promise<ShiftSyncResult> {
    const refused = refusalToSend({ kind, fact: input.fact });
    if (refused !== null) return { kind: 'not_sent', reason: refused };
    const read = await tokenOf(input.terminalId);
    if (read.kind === 'not_sent') return read;
    // T3: no await between this check and the request.
    if (!onTerminal(input.terminalId)) return { kind: 'not_sent', reason: 'terminal_changed' };
    return post({ fact: input.fact, token: read.token, path: 'device' });
  }

  /** The manager envelope; null when none or the read fails. */
  function readEnvelope(): string | null {
    try {
      const envelope = deps.getEnvelope?.() ?? null;
      return envelope === null || envelope.length === 0 ? null : envelope;
    } catch {
      return null;
    }
  }

  async function sendEnvelope(input: ShiftSyncSend): Promise<ShiftSyncResult> {
    if (input.fact.authPath !== 'envelope') return { kind: 'not_sent', reason: 'kind_mismatch' };
    if (!onTerminal(input.terminalId)) return { kind: 'not_sent', reason: 'terminal_changed' };
    const envelope = readEnvelope();
    if (envelope === null) return { kind: 'not_sent', reason: 'no_envelope_credential' };
    // No await between this check and the request (as on the device path).
    if (!onTerminal(input.terminalId)) return { kind: 'not_sent', reason: 'terminal_changed' };
    return post({ fact: input.fact, token: envelope, path: 'envelope' });
  }

  return {
    openShift: (input) => send('open', input),
    recordCashMovement: (input) => send('movement', input),
    closeShift: (input) => send('close', input),
    sendEnvelope,
  };
}
