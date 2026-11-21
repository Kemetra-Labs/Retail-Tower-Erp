/**
 * RT-1312 Phase 3(c) — what the till uploads (`posQuarantineSale`) for one
 * stranded sale. Pure: no I/O, no clock (the caller passes `now`).
 *
 * `saleBody` is the capture WIRE body, rebuilt exactly the way the drain builds
 * it for `captureSale` (`buildCapturePayload`, then `toCashierWireBody` for a
 * device-path sale or `toWireBody` for an envelope sale), because a Console
 * repair re-ingests it through the capture rules and reads the cashier from its
 * `operatorUserId`. The till keeps no sent bytes, so it is a rebuild (the
 * contract says so).
 *
 * A sale the till cannot build a sendable body for is SKIPPED, never uploaded
 * (decision P1): an unsendable tender or discount, a corrupt amount, an
 * unreadable snapshot (`not_sendable`), or a sale whose cashier cannot be
 * proven (`cashier_unresolved`, the drain's route `hold`: a provable cashier
 * sale is never sent under a different identity). Such a sale stays counted in
 * the heartbeat.
 *
 * The reason is the till's claim (decision: Backend-Core does not trust it).
 * `httpStatus` is only ever a status the till is certain of: the dead-letter
 * reasons `payload_divergence` (set only by a capture 409) and
 * `cashier_claim_refused` (set only by a device-path 403) name theirs; `refused`
 * (any other non-retryable 4xx) and a held sale have none, and the till has
 * never recorded an error code, so `errorCode` is always null.
 */
import {
  buildCapturePayload,
  DiscountNotSendableError,
  TenderNotSendableError,
  type BuildCapturePayloadOptions,
  type CaptureSalePayload,
} from '../sales-sync/capture-payload.js';
import {
  DEFAULT_CURRENCY_CODE,
  toCashierWireBody,
  toWireBody,
} from '../sales-sync/create-sale-sync-client.js';
import type { ResolvedDiscountRoles } from '../sales-sync/discount-role-resolutions.js';
import type { SaleRoute } from '../sales-sync/selling-user-id.js';
import type { SaleRow } from '../sales/repositories/sales.repository.js';
import type { QuarantineUploadBody, QuarantineUploadReason } from './quarantine-upload-client.js';

/** Why the sale is stranded: a dead-letter (with the stored reason), or held after a re-pair. */
export type QuarantineSource =
  | {
      readonly kind: 'dead_letter';
      /** `sale_sync_state.last_error_category` of the dead-letter. */
      readonly category: string;
      /** When the till dead-lettered it (the state row's last write). */
      readonly tillRecordedAt: string;
    }
  | { readonly kind: 'held' };

export type QuarantineSkipReason =
  | 'unknown_reason'
  | 'held_without_previous_terminal'
  | 'cashier_unresolved'
  | 'not_sendable'
  | 'invalid_key';

type QuarantineBuildResult =
  | { readonly kind: 'ok'; readonly upload: QuarantineUploadBody }
  | { readonly kind: 'skip'; readonly reason: QuarantineSkipReason };

interface BuildQuarantineUploadInput {
  readonly sale: SaleRow;
  readonly source: QuarantineSource;
  /** The sale's own route (`createSellingUserIdResolver`, asked with the sale's terminal). */
  readonly route: SaleRoute;
  /** The CURRENT pairing's terminal id. */
  readonly currentTerminalId: string;
  /** The RT-79 / RT-540 / RT-363 cutoffs the drain builds with, so the body is the same one. */
  readonly cutoffs: Pick<
    BuildCapturePayloadOptions,
    'tendersSince' | 'receiptSince' | 'tenderRefsSince'
  >;
  readonly resolvedRoles: ResolvedDiscountRoles;
  /** ISO instant; the `tillRecordedAt` of a held sale (it has no recorded hold time). */
  readonly now: string;
  readonly currencyCode?: string;
}

/** The contract's `idempotencyKey` pattern: printable ASCII, 16 to 128 characters. */
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{16,128}$/;

const REFUSED_REASON: QuarantineUploadReason = {
  kind: 'refused',
  httpStatus: null,
  errorCode: null,
};

const DEAD_LETTER_REASONS: Readonly<Record<string, QuarantineUploadReason>> = {
  permanent: REFUSED_REASON,
  payload_divergence: { kind: 'payload_divergence', httpStatus: 409, errorCode: null },
  cashier_claim_refused: { kind: 'cashier_claim_refused', httpStatus: 403, errorCode: null },
};

const HELD_REASON: QuarantineUploadReason = {
  kind: 'held_previous_pairing',
  httpStatus: null,
  errorCode: null,
};

function skip(reason: QuarantineSkipReason): QuarantineBuildResult {
  return { kind: 'skip', reason };
}

/**
 * What the capture drain refuses to send: a tender or discount it cannot send
 * faithfully, and (the drain would hold it) a snapshot that is not valid JSON.
 * Anything else is a bug or a dependency failure, and reaches the caller.
 */
function isUnsendable(err: unknown): boolean {
  return (
    err instanceof TenderNotSendableError ||
    err instanceof DiscountNotSendableError ||
    err instanceof SyntaxError
  );
}

/** The wire body, or null when the sale cannot be sent faithfully. */
function wireBodyOf(
  input: BuildQuarantineUploadInput,
  route: Exclude<SaleRoute, { kind: 'hold' }>,
): { externalId: string; sourceSystem: string; body: Record<string, unknown> } | null {
  let payload: CaptureSalePayload;
  try {
    payload = buildCapturePayload(input.sale, {
      tendersSince: input.cutoffs.tendersSince,
      receiptSince: input.cutoffs.receiptSince,
      tenderRefsSince: input.cutoffs.tenderRefsSince,
      resolvedRoles: input.resolvedRoles,
    });
  } catch (err) {
    if (isUnsendable(err)) return null;
    throw err;
  }
  const currency = input.currencyCode ?? DEFAULT_CURRENCY_CODE;
  try {
    // The wire transform refuses a corrupt amount (the client maps it to `permanent`).
    const body: Record<string, unknown> = {
      ...(route.kind === 'device'
        ? toCashierWireBody(payload, currency, route.operatorUserId)
        : toWireBody(payload, currency)),
    };
    return { externalId: payload.externalId, sourceSystem: payload.sourceSystem, body };
  } catch {
    return null;
  }
}

/** The reason and recorded time of the stranded sale, or a skip. */
function reasonOf(
  input: BuildQuarantineUploadInput,
): { reason: QuarantineUploadReason; tillRecordedAt: string } | QuarantineSkipReason {
  const { source } = input;
  if (source.kind === 'held') return { reason: HELD_REASON, tillRecordedAt: input.now };
  const reason = DEAD_LETTER_REASONS[source.category];
  return reason === undefined
    ? 'unknown_reason'
    : { reason, tillRecordedAt: source.tillRecordedAt };
}

export function buildQuarantineUpload(input: BuildQuarantineUploadInput): QuarantineBuildResult {
  const why = reasonOf(input);
  if (typeof why === 'string') return skip(why);
  const previousTerminalId =
    input.sale.terminal_id === input.currentTerminalId ? null : input.sale.terminal_id;
  if (input.source.kind === 'held' && previousTerminalId === null) {
    return skip('held_without_previous_terminal');
  }
  if (input.route.kind === 'hold') return skip('cashier_unresolved');

  const wire = wireBodyOf(input, input.route);
  if (wire === null) return skip('not_sendable');
  // The till sends the sale's externalId as its capture Idempotency-Key.
  if (!IDEMPOTENCY_KEY.test(wire.externalId)) return skip('invalid_key');

  return {
    kind: 'ok',
    upload: {
      sourceSystem: wire.sourceSystem,
      externalId: wire.externalId,
      idempotencyKey: wire.externalId,
      reason: why.reason,
      tillRecordedAt: why.tillRecordedAt,
      previousTerminalId,
      saleBody: wire.body,
    },
  };
}
