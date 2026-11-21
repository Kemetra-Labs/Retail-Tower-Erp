/**
 * RT-530 — the Backend-Core sale-void client.
 *
 *   POST /api/pos/v1/sales/{saleRef}/void
 *
 * Auth, two alternatives (contract 1.26.0-draft). A manager or admin void uses the
 * `operatorAuthorization` scheme: `Authorization: Bearer <pos_operator envelope>`, the envelope of
 * the operator who REQUESTED the void (the server binds `approval.requesterUserId` to the
 * envelope's operator). A cashier's void (RT-1403, RT-530 c12029) uses the `device` scheme: the
 * paired terminal's device bearer plus the cashier's `operatorUserId` in the body, accepted only
 * while that cashier holds a live admission on this device. Either credential is an explicit
 * argument of the call, never read here, never logged, stored or bridged; no credential, no
 * request.
 *
 * Outcome mapping (contract 1.8.0-draft, `sales.controller.ts`):
 *   201 / 200          -> recorded (a replay when `Idempotent-Replayed` or 200);
 *                         the body must name THIS sale and carry an `eventRef`,
 *                         else `unknown` (a resend replays it)
 *   400                -> validation_error
 *   403 void_*         -> that code (terminal: the approval did not hold)
 *   403 refused        -> unknown (claim_refused): the device path's cashier claim was refused
 *                         before the void was read; proves nothing about the void
 *   404                -> sale_not_found
 *   409 already_reversed -> already_reversed; any other 409 -> conflict
 *   422 void_*         -> that code
 *   401, other 403, 429, 5xx, network, timeout, no credential -> unknown
 *
 * `unknown` is never success and never terminal: nothing proves the server did
 * or did not record the void; the same bytes under the same key are re-sent.
 * Never throws.
 */
import type { ServerVoidRefusal } from '../../shared/sale-void/types.js';
import { isUuid, parseJsonBody, readErrorCode } from '../returns/returns-wire.js';

const SALES_PATH = '/api/pos/v1/sales';

/** The request timeout of every void exchange. */
export const SALE_VOID_REQUEST_TIMEOUT_MS = 15_000;

export type RecordVoidOutcome =
  | { readonly kind: 'recorded'; readonly replayed: boolean; readonly eventRef: string }
  | { readonly kind: 'refused'; readonly reason: ServerVoidRefusal }
  /** `category` is a closed-set note of why the answer is unknown. */
  | { readonly kind: 'unknown'; readonly category: UnknownCategory };

export type UnknownCategory =
  | 'no_credential'
  | 'no_connection'
  | 'unauthorized'
  | 'server_error'
  | 'unreadable_answer'
  /**
   * RT-1403: the device path's generic 403 `refused` (no live cashier admission, an ineligible
   * cashier). It proves nothing about the void (the server refused the CLAIM before looking at
   * it, so an earlier send may still have been recorded): the row stays unknown and is
   * re-sent only while the cashier is the signed-in sender.
   */
  | 'claim_refused';

export interface RecordVoidRequest {
  readonly saleRef: string;
  /** The exact JSON body (re-sent byte-identical). */
  readonly bodyJson: string;
  /** The void's `externalId` (`pos-pulse-void:<uuid>`), also its Idempotency-Key. */
  readonly idempotencyKey: string;
}

/** The requester's opaque operator envelope, or null (-> no request). */
export type RequesterEnvelope = string | null;

export interface SaleVoidClient {
  recordVoid(request: RecordVoidRequest, envelope: RequesterEnvelope): Promise<RecordVoidOutcome>;
  /**
   * RT-1403 (RT-530 c12029): a CASHIER's void, sent with the paired terminal's DEVICE bearer.
   * `request.bodyJson` must carry the cashier's `operatorUserId` (`buildVoidBodyJson(..,
   * 'device')`): its presence is what selects the device credential on Backend-Core. A null
   * or empty token is `no_credential`, no request. Same outcome table as `recordVoid`.
   */
  recordVoidAsCashier(
    request: RecordVoidRequest,
    deviceToken: string | null,
  ): Promise<RecordVoidOutcome>;
}

export interface CreateSaleVoidClientDeps {
  readonly baseUrl: string;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

type HttpAnswer = { readonly status: number; readonly headers: Headers; readonly json: unknown };

const FORBIDDEN_CODES: ReadonlySet<string> = new Set([
  'void_approval_required',
  'void_requester_mismatch',
  'void_requester_not_eligible',
  'void_self_approval',
  'void_approver_not_eligible',
]);

const UNPROCESSABLE_CODES: ReadonlySet<string> = new Set([
  'void_approval_invalid',
  'void_outside_business_day',
]);

/** A status whose refusal does not depend on the answer's `error.code`. */
const FIXED_REFUSALS: Readonly<Record<number, ServerVoidRefusal>> = {
  400: 'validation_error',
  404: 'sale_not_found',
};

/**
 * A status whose refusal is the answer's own `error.code` when it is one of
 * `codes`, else `otherwise` (null: the answer proves nothing).
 */
interface CodedRefusals {
  readonly codes: ReadonlySet<string>;
  readonly otherwise: ServerVoidRefusal | null;
}

const CODED_REFUSALS: Readonly<Record<number, CodedRefusals>> = {
  403: { codes: FORBIDDEN_CODES, otherwise: null },
  409: { codes: new Set(['already_reversed']), otherwise: 'conflict' },
  422: { codes: UNPROCESSABLE_CODES, otherwise: 'validation_error' },
};

/** A refusal for a non-2xx answer, or null when the answer proves nothing. */
export function classifyVoidRefusal(status: number, code: string | null): ServerVoidRefusal | null {
  const fixed = FIXED_REFUSALS[status];
  if (fixed !== undefined) return fixed;
  const coded = CODED_REFUSALS[status];
  if (coded === undefined) return null;
  return code !== null && coded.codes.has(code) ? (code as ServerVoidRefusal) : coded.otherwise;
}

function asRecord(json: unknown): Record<string, unknown> | null {
  return typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : null;
}

const sameRef = (a: unknown, b: string): boolean =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** The void event reference when the answer is this sale's `void` terminal event. */
function readEventRef(json: unknown, saleRef: string): string | null {
  const body = asRecord(json);
  if (body === null || body['kind'] !== 'void') return null;
  const eventRef = body['eventRef'];
  const named = typeof eventRef === 'string' && isUuid(eventRef);
  return named && sameRef(body['saleRef'], saleRef) ? eventRef : null;
}

function toOutcome(answer: HttpAnswer, saleRef: string): RecordVoidOutcome {
  if (answer.status === 200 || answer.status === 201) {
    const eventRef = readEventRef(answer.json, saleRef);
    if (eventRef === null) return { kind: 'unknown', category: 'unreadable_answer' };
    const replayed = answer.status === 200 || answer.headers.get('Idempotent-Replayed') === 'true';
    return { kind: 'recorded', replayed, eventRef };
  }
  const code = readErrorCode(answer.json);
  // RT-1403: the device path's generic 403 `refused` (one body for every cause) is not a refusal
  // of THIS void: the claim was refused before the void was read.
  if (answer.status === 403 && code === 'refused')
    return { kind: 'unknown', category: 'claim_refused' };
  const reason = classifyVoidRefusal(answer.status, code);
  if (reason !== null) return { kind: 'refused', reason };
  return { kind: 'unknown', category: answer.status === 401 ? 'unauthorized' : 'server_error' };
}

export function createSaleVoidClient(deps: CreateSaleVoidClientDeps): SaleVoidClient {
  const root = deps.baseUrl.replace(/\/$/, '');
  const timeoutMs = deps.timeoutMs ?? SALE_VOID_REQUEST_TIMEOUT_MS;

  async function exchange(request: RecordVoidRequest, token: string): Promise<HttpAnswer | null> {
    try {
      const response = await deps.fetch(`${root}${SALES_PATH}/${request.saleRef}/void`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': request.idempotencyKey,
          Authorization: `Bearer ${token}`,
        },
        body: request.bodyJson,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = parseJsonBody(await response.text());
      return { status: response.status, headers: response.headers, json };
    } catch {
      return null;
    }
  }

  async function send(
    request: RecordVoidRequest,
    token: string | null,
  ): Promise<RecordVoidOutcome> {
    if (token === null || token.length === 0) {
      return { kind: 'unknown', category: 'no_credential' };
    }
    if (!isUuid(request.saleRef)) return { kind: 'refused', reason: 'sale_not_found' };
    const answer = await exchange(request, token);
    return answer === null
      ? { kind: 'unknown', category: 'no_connection' }
      : toOutcome(answer, request.saleRef);
  }

  return {
    recordVoid: (request, envelope) => send(request, envelope),
    recordVoidAsCashier: (request, deviceToken) => send(request, deviceToken),
  };
}
