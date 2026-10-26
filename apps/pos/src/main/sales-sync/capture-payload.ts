/**
 * 011-sale-sync-capture-up T023 — `buildCapturePayload`.
 *
 * Maps a durable `SaleRow` → the `CaptureSalePayload` body POSTed to DP2
 * `captureSale` (`POST /api/pos/v1/sales`). Pure: no I/O, no clock, no float.
 *
 * Invariants (spec FR-2/FR-9/FR-10):
 *   • `externalId` is DETERMINISTIC from the sale — derived from the existing
 *     008 idempotency anchor `envelope_handoff_action_id` — so every retry of the
 *     same sale carries the same key and the backend dedup `(tenant, sourceSystem,
 *     externalId)` collapses retries to one record.
 *   • Money is the Sale's integer minor units VERBATIM. The `sales` columns are
 *     already `INTEGER` at rest (migrations 0020/0028); there is no float anywhere.
 *   • Tenders (RT-79, RT-10 D1/D2) are emitted ONLY when a rollout cutoff is
 *     configured AND the sale was finalized at/after it. Default (no cutoff) is
 *     byte-identical to the pre-RT-79 payload and never reads
 *     `tender_lines_summary_json`. With a FUTURE cutoff (later than the restart that
 *     loads it) every retry of a given sale sends an identical body; a changed body
 *     under the same Idempotency-Key is a 409 payload-hash mismatch on the server.
 *   • Lines come from the frozen `lines_json` snapshot (LineSnapshot[]).
 *   • RT-225 (`sales.yaml` 1.6.0-draft): `admissionCheckAt` = the sale's
 *     `settled_at`, present only when `finalized_at` is more than 5 s and at most
 *     7 days after it (`deriveAdmissionCheckAt`). It is decided from the stored
 *     Sale alone — `settled_at` and `finalized_at` are written once, in the same
 *     transaction that enqueues the sale, and the row is immutable — so the value
 *     is fixed when the sale is first queued and every retry under the same
 *     Idempotency-Key sends the same body (adding it on a retry would be a 409).
 *     Only the device-path wire body carries it (`toCashierWireBody`).
 *   • RT-540 (`sales.yaml` 1.9.0-draft, RT-537): the optional `receipt` snapshot — the
 *     facts the original receipt printed — sent from the durable Sale only, and only
 *     for a sale finalized at/after the rollout cutoff (`receiptSince`, the RT-79
 *     pattern: a body that changes under one Idempotency-Key is a 409). Sent whole or
 *     not at all (`deriveReceipt`); line order is the order of `lines[]`. The sale
 *     number is sent as stored — its generation is not touched here.
 *   • RT-858 (`sales.yaml` 1.14.0-draft, RT-740 option C-A): a line frozen with a
 *     manual `discount` (RT-856) is sent at its NET `lineAmountMinor` (gross −
 *     `amount_minor`) with the `discount` and its attribution
 *     (`readCaptureDiscount`). The amount is re-derived with the RT-699 math on the
 *     frozen gross and must equal the frozen one; anything else is
 *     `DiscountNotSendableError`. Every discounted sale was held until RT-858, so
 *     none was ever POSTed: an undiscounted line, and so an undiscounted body, is
 *     byte-identical to before.
 *   • RT-858 (doc 28 OZ-1 = Z-A): a discounted sale whose total is 0 sends one
 *     `cash` tender of 0, so Backend-Core records a zero-total sale, not a
 *     tender-unknown one. It applies where tenders are sent (the RT-79 cutoff).
 */

import type { SaleRow } from '../sales/repositories/sales.repository.js';
import {
  computeManualDiscount,
  isManualDiscountReasonCode,
  type ManualDiscountKind,
  type ManualDiscountReasonCode,
} from '../../shared/cart/manual-discount.js';
import type { SaleLineDiscountAuthoritySource } from '../../shared/sales/sale-line-discount.js';
import { CAPTURE_APPROVER_ROLES, saleHasLineDiscount } from './discount-hold.js';

/** A single line in the capture payload. Money is integer minor units. */
export interface CaptureSaleLine {
  lineRef: string;
  productRef: string;
  /** Human-readable line label, frozen from the cart snapshot's `display_name`. */
  lineName: string;
  quantity: number;
  unitPriceMinor: number;
  /** The line's NET: gross − `discount.amountMinor` when discounted (RT-858). */
  lineAmountMinor: number;
  /** RT-858: the line's manual discount (RT-740 C-A); absent when not discounted. */
  discount?: CaptureSaleLineDiscount;
}

/**
 * RT-858: the frozen line discount as captured. `value` is a whole percent, or
 * the amount in minor units; `amountMinor` is the money taken off the line
 * gross. The placeholder and approver operator ids stay on the till.
 */
export interface CaptureSaleLineDiscount {
  kind: ManualDiscountKind;
  value: number;
  amountMinor: number;
  reasonCode: ManualDiscountReasonCode;
  authoritySource: SaleLineDiscountAuthoritySource;
  approverRole: 'manager' | 'admin';
}

/** One way the sale was paid. `amountMinor` is NET of change. No card data/reference (D-A). */
export interface CaptureSaleTender {
  method: 'cash' | 'card_external';
  amountMinor: number;
}

/** The `captureSale` request body. Money is integer minor units. */
export interface CaptureSalePayload {
  externalId: string;
  sourceSystem: 'pos-pulse';
  tenantId: string;
  branchId: string;
  terminalId: string;
  operatorId: string;
  occurredAt: string;
  totalMinor: number;
  lines: CaptureSaleLine[];
  /** RT-79: present only for a post-cutoff sale with sendable tender lines. */
  tenders?: CaptureSaleTender[];
  /**
   * RT-225: the sale's settled time, for the server's cashier admission-window
   * check only (`deriveAdmissionCheckAt`). Sent on the device path only.
   */
  admissionCheckAt?: string;
  /** RT-540: the receipt snapshot; present only for a post-cutoff sale whose facts are all sendable. */
  receipt?: CaptureSaleReceipt;
}

/**
 * RT-540: the facts the original receipt printed that are not otherwise sale facts
 * (`CaptureSaleReceipt`). Presentation only — never an authorization, scope or money
 * input. `changeGivenMinor` is integer minor units, present only when change was given.
 */
export interface CaptureSaleReceipt {
  saleNumber: string;
  /** Only when it differs from `saleNumber`. */
  receiptNumber?: string;
  terminalLabel: string;
  operatorDisplayName: string;
  settledAt: string;
  branchName: string;
  branchAddress: string;
  taxRegistrationId: string;
  changeGivenMinor?: number;
}

export interface BuildCapturePayloadOptions {
  /** ISO instant; sales finalized at/after it carry `tenders`. null/undefined = off. */
  tendersSince?: string | null | undefined;
  /** RT-540: ISO instant; sales finalized at/after it carry `receipt`. null/undefined = off. */
  receiptSince?: string | null | undefined;
}

/**
 * A tendered sale that must never be sent (voucher, unknown method, corrupt amounts,
 * unreadable summary). The engine dead-letters it with this reason rather than
 * sending a fabricated method (RT-10 D2).
 */
export class TenderNotSendableError extends Error {
  constructor(reason: string) {
    super(`tender not sendable: ${reason}`);
    this.name = 'TenderNotSendableError';
  }
}

/**
 * RT-858: a frozen line discount that cannot be sent faithfully (malformed, or
 * its amount not the RT-699 math on the line gross). The engine dead-letters it
 * like `TenderNotSendableError`: the server would refuse it 400 / 422 anyway.
 * A discount with no recorded approver role never gets here: the drain holds it.
 */
export class DiscountNotSendableError extends Error {
  constructor(reason: string) {
    super(`discount not sendable: ${reason}`);
    this.name = 'DiscountNotSendableError';
  }
}

export const SOURCE_SYSTEM = 'pos-pulse' as const;

/** The frozen line snapshot shape persisted in `sales.lines_json` (008 T028a). */
interface PersistedLineSnapshot {
  line_id: string;
  item_ref: string;
  display_name: string;
  quantity: number;
  unit_price_minor: number;
  line_subtotal_minor: number;
  /** RT-856: the frozen manual discount (`SaleLineDiscount`), when the line has one. */
  discount?: unknown;
}

const AUTHORITY_SOURCES: ReadonlySet<unknown> = new Set(['cashier_approval', 'manager_session']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The frozen discount's attribution, or null when a field is outside its closed set. */
function attributionOf(
  frozen: Record<string, unknown>,
): Pick<CaptureSaleLineDiscount, 'reasonCode' | 'authoritySource' | 'approverRole'> | null {
  const { reason_code, authority_source, approver_role } = frozen;
  if (!isManualDiscountReasonCode(reason_code)) return null;
  if (!AUTHORITY_SOURCES.has(authority_source) || !CAPTURE_APPROVER_ROLES.has(approver_role)) {
    return null;
  }
  return {
    reasonCode: reason_code,
    authoritySource: authority_source as SaleLineDiscountAuthoritySource,
    approverRole: approver_role as CaptureSaleLineDiscount['approverRole'],
  };
}

/**
 * RT-858: the line's capture discount, or undefined when it has none. The
 * amount is recomputed from the frozen kind and value on the frozen gross with
 * the RT-699 math (percent half up, once per line; amount verbatim, at most the
 * gross) and must equal the frozen `amount_minor`, so POS and Backend-Core can
 * never disagree on the net. Throws `DiscountNotSendableError` otherwise.
 */
function readCaptureDiscount(line: PersistedLineSnapshot): CaptureSaleLineDiscount | undefined {
  const frozen = frozenDiscountOf(line);
  if (frozen === undefined) return undefined;
  const priced = pricedDiscount(line.line_subtotal_minor, frozen);
  if (priced === null || priced.amountMinor !== frozen['amount_minor']) {
    throw new DiscountNotSendableError(`line ${line.line_id} amount`);
  }
  const attribution = attributionOf(frozen);
  if (attribution === null) throw new DiscountNotSendableError(`line ${line.line_id} attribution`);
  return { ...priced, ...attribution };
}

/** The line's frozen discount object; undefined when it has none, a throw when it is not an object. */
function frozenDiscountOf(line: PersistedLineSnapshot): Record<string, unknown> | undefined {
  const frozen = line.discount;
  if (frozen === undefined || frozen === null) return undefined;
  if (!isRecord(frozen)) throw new DiscountNotSendableError(`line ${line.line_id} malformed`);
  return frozen;
}

function isDiscountKind(kind: unknown): kind is ManualDiscountKind {
  return kind === 'percent' || kind === 'amount';
}

/** The frozen kind and value with the RT-699 amount on the gross, or null when refused. */
function pricedDiscount(
  gross: number,
  frozen: Record<string, unknown>,
): Pick<CaptureSaleLineDiscount, 'kind' | 'value' | 'amountMinor'> | null {
  const { kind, value } = frozen;
  if (!isDiscountKind(kind) || typeof value !== 'number') return null;
  const result = computeManualDiscount(gross, { kind, value });
  return result === null ? null : { kind, value, amountMinor: result.amount_minor };
}

function captureLine(s: PersistedLineSnapshot): CaptureSaleLine {
  const discount = readCaptureDiscount(s);
  return {
    lineRef: s.line_id,
    productRef: s.item_ref,
    lineName: s.display_name,
    quantity: s.quantity,
    unitPriceMinor: s.unit_price_minor,
    lineAmountMinor:
      discount === undefined ? s.line_subtotal_minor : s.line_subtotal_minor - discount.amountMinor,
    ...(discount === undefined ? {} : { discount }),
  };
}

/** The frozen summary line shape (`buildRedactedTenderLinesSummary`). */
interface PersistedTenderLine {
  tender_type?: unknown;
  amount_applied_minor?: unknown;
  change_due_minor?: unknown;
}

const TENDER_METHOD: Readonly<Record<string, CaptureSaleTender['method']>> = {
  cash: 'cash',
  external_card_terminal: 'card_external',
};

/**
 * RFC 3339 instant with an EXPLICIT zone (`Z` or `+hh:mm`). `Date.parse` alone would also
 * accept date-only, zone-less (terminal-local) and locale formats, turning the gate on
 * for an unintended cutoff.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * `Date.parse` silently rolls calendar-invalid fields over (Feb 30 -> Mar 2), so check
 * each field is in range before trusting it.
 */
function isCalendarValid(m: RegExpExecArray): boolean {
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offsetOk = m[7] === undefined || (Number(m[7]) <= 23 && Number(m[8]) <= 59);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetOk
  );
}

/**
 * Parse `POS_PULSE_FEATURE_SALE_TENDERS_SINCE`. Unset, blank, not an explicit-zone ISO
 * instant, or unparseable -> null (tenders OFF — fail-safe). A valid instant -> its
 * canonical UTC ISO string.
 */
export function parseTendersSince(raw: string | undefined): string | null {
  const ms = instantMs(raw?.trim() ?? '');
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * RT-540: parse `POS_PULSE_FEATURE_SALE_RECEIPT_SINCE` — the same explicit-zone grammar
 * and fail-safe as the tenders cutoff, but a separate switch: the receipt rollout is tied
 * to the Backend-Core RT-539 deploy, not to the tender switch.
 */
export function parseReceiptSince(raw: string | undefined): string | null {
  return parseTendersSince(raw);
}

function isSafeNonNegativeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Frozen `tender_lines_summary_json` -> contract tenders: cash NET of change,
 * `external_card_terminal` -> `card_external` (reference deliberately omitted), one
 * entry per method in first-seen order, zero-net entries dropped. Throws
 * `TenderNotSendableError` for anything that cannot be sent faithfully.
 */
function buildTenders(sale: SaleRow): CaptureSaleTender[] {
  let lines: unknown;
  try {
    lines = JSON.parse(sale.tender_lines_summary_json);
  } catch {
    throw new TenderNotSendableError('unreadable tender summary');
  }
  if (!Array.isArray(lines)) throw new TenderNotSendableError('tender summary is not a list');
  if (lines.length === 0) return []; // tender-unknown (RT-10 D8): nothing to reconcile

  const net = new Map<CaptureSaleTender['method'], number>();
  for (const raw of lines as unknown[]) {
    if (typeof raw !== 'object' || raw === null) {
      throw new TenderNotSendableError('malformed tender line');
    }
    const line = raw as PersistedTenderLine;
    const method =
      typeof line.tender_type === 'string' ? TENDER_METHOD[line.tender_type] : undefined;
    if (method === undefined) {
      throw new TenderNotSendableError(`unsupported tender type ${String(line.tender_type)}`);
    }
    const applied = line.amount_applied_minor;
    const change = line.change_due_minor ?? 0;
    if (!isSafeNonNegativeInt(applied) || !isSafeNonNegativeInt(change) || change > applied) {
      throw new TenderNotSendableError(`invalid ${method} amount`);
    }
    net.set(method, (net.get(method) ?? 0) + (applied - change));
  }
  const sum = [...net.values()].reduce((a, b) => a + b, 0);
  if (sum !== sale.subtotal_minor) {
    throw new TenderNotSendableError(
      `tenders sum ${String(sum)} != sale total ${String(sale.subtotal_minor)}`,
    );
  }
  return [...net]
    .filter(([, amountMinor]) => amountMinor > 0)
    .map(([method, amountMinor]) => ({
      method,
      amountMinor,
    }));
}

/** The sale's tenders: its frozen summary, or the RT-858 zero-total tender when that is empty. */
function tendersOf(sale: SaleRow): CaptureSaleTender[] {
  const tenders = buildTenders(sale);
  return tenders.length > 0 ? tenders : zeroTotalTenders(sale);
}

/**
 * RT-858 (doc 28 OZ-1 = Z-A): a discounted sale with total 0 (every line free)
 * sends one `cash` tender of 0, so Backend-Core records a zero-total sale
 * rather than a tender-unknown one. Only a discounted sale: those were all held
 * until RT-858, so no body already POSTed changes. Any other sale: none.
 */
function zeroTotalTenders(sale: SaleRow): CaptureSaleTender[] {
  return sale.subtotal_minor === 0 && saleHasLineDiscount(sale)
    ? [{ method: 'cash', amountMinor: 0 }]
    : [];
}

/** A rollout cutoff is on and the sale was finalized at/after it. */
function finalizedAtOrAfter(sale: SaleRow, cutoff: string | null | undefined): boolean {
  if (cutoff === null || cutoff === undefined) return false;
  const finalized = Date.parse(sale.finalized_at);
  return !Number.isNaN(finalized) && finalized >= Date.parse(cutoff);
}

/**
 * The required text facts of a `CaptureSaleReceipt` and their `sales.yaml` 1.9.0-draft
 * bounds: sendable text is 1..max characters (UTF-16 length is never below the contract's
 * code-point length, so a value within these bounds is within the contract's).
 */
const RECEIPT_TEXT_FACTS = [
  { column: 'sale_number', max: 96 },
  { column: 'terminal_label', max: 64 },
  { column: 'branch_name', max: 256 },
  { column: 'branch_address', max: 512 },
  { column: 'tenant_tax_registration_id', max: 64 },
] as const;
const RECEIPT_NUMBER_MAX = 96;

/**
 * The contract says the operator name is never an email address (OD-534-6) but not how the
 * server tells; any '@' is dropped rather than risk a 400 on an email-shaped name.
 */
function looksLikeEmail(name: string): boolean {
  return name.includes('@');
}

function withinBound(value: string, max: number): boolean {
  return value.trim() !== '' && value.length <= max;
}

/** The receipt number to send: only when it differs from the sale number (else omitted). */
function distinctReceiptNumber(sale: SaleRow): string | undefined {
  return sale.receipt_number !== '' && sale.receipt_number !== sale.sale_number
    ? sale.receipt_number
    : undefined;
}

/** Every fact the receipt needs is present and inside the contract's bounds. */
function receiptFactsSendable(sale: SaleRow): boolean {
  const operatorName = sale.selling_operator_display_name.trim();
  const receiptNumber = distinctReceiptNumber(sale);
  return (
    RECEIPT_TEXT_FACTS.every(({ column, max }) => withinBound(sale[column], max)) &&
    operatorName !== '' &&
    !looksLikeEmail(operatorName) &&
    instantMs(sale.settled_at) !== null &&
    (receiptNumber === undefined || withinBound(receiptNumber, RECEIPT_NUMBER_MAX)) &&
    isSafeNonNegativeInt(sale.total_change_due_minor)
  );
}

/**
 * RT-540: the sale's `receipt` snapshot, or undefined when the rollout cutoff is off, the
 * sale is older than it, or ANY required fact is missing or outside the contract's bounds
 * (an older row can carry '' for the address or tax id). The whole receipt or none: a
 * value the contract would refuse is a 400 — a dead-lettered sale — so it is never sent;
 * the sale itself still captures as today. Pure, from the immutable Sale row only, so
 * every retry under the same Idempotency-Key sends the same body.
 */
function deriveReceipt(
  sale: SaleRow,
  receiptSince: string | null | undefined,
): CaptureSaleReceipt | undefined {
  if (!finalizedAtOrAfter(sale, receiptSince) || !receiptFactsSendable(sale)) return undefined;
  const receiptNumber = distinctReceiptNumber(sale);
  const change = sale.total_change_due_minor;
  return {
    saleNumber: sale.sale_number,
    ...(receiptNumber === undefined ? {} : { receiptNumber }),
    terminalLabel: sale.terminal_label,
    operatorDisplayName: sale.selling_operator_display_name,
    settledAt: sale.settled_at,
    branchName: sale.branch_name,
    branchAddress: sale.branch_address,
    taxRegistrationId: sale.tenant_tax_registration_id,
    ...(change > 0 ? { changeGivenMinor: change } : {}),
  };
}

/** RT-225: `admissionCheckAt` is sent only when the finalize lag is MORE than this. */
export const ADMISSION_CHECK_MIN_GAP_MS = 5_000;
/** RT-225 (owner decision, 7-day cap): and only when it is AT MOST this (server: else 400). */
export const ADMISSION_CHECK_MAX_GAP_MS = 7 * 24 * 60 * 60 * 1_000;

/** An explicit-zone, calendar-valid RFC 3339 instant in ms; null otherwise. */
function instantMs(value: string): number | null {
  const match = ISO_INSTANT.exec(value);
  if (match === null || !isCalendarValid(match)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * RT-225 — the sale's `admissionCheckAt`: its `settled_at` (the moment the
 * cashier settled it, under the admission live then) when the sale was finalized
 * more than 5 s and at most 7 days later — typically by boot recovery, which
 * stamps `finalized_at` at boot. Otherwise null: an ordinary sale keeps exactly
 * today's body, and a value the server would refuse (later than `occurredAt`, or
 * more than 7 days before it) is never sent. An unreadable instant is null too
 * (fail safe). Pure: a function of the immutable Sale row only.
 */
export function deriveAdmissionCheckAt(sale: SaleRow): string | null {
  const settled = instantMs(sale.settled_at);
  const finalized = instantMs(sale.finalized_at);
  if (settled === null || finalized === null) return null;
  const gap = finalized - settled;
  return gap > ADMISSION_CHECK_MIN_GAP_MS && gap <= ADMISSION_CHECK_MAX_GAP_MS
    ? sale.settled_at
    : null;
}

/**
 * Deterministic external id from the sale. The handoff action id is 008's
 * one-Sale-per-handoff idempotency anchor (unique index), so it is a stable,
 * collision-free basis. Namespaced to make the POS origin explicit on the wire.
 */
export function deriveExternalId(sale: SaleRow): string {
  return `pos-pulse:${sale.envelope_handoff_action_id}`;
}

export function buildCapturePayload(
  sale: SaleRow,
  options: BuildCapturePayloadOptions = {},
): CaptureSalePayload {
  const snapshots = JSON.parse(sale.lines_json) as PersistedLineSnapshot[];
  const lines: CaptureSaleLine[] = snapshots.map(captureLine);

  const tenders = finalizedAtOrAfter(sale, options.tendersSince) ? tendersOf(sale) : [];
  const admissionCheckAt = deriveAdmissionCheckAt(sale);
  const receipt = deriveReceipt(sale, options.receiptSince);

  return {
    externalId: deriveExternalId(sale),
    sourceSystem: SOURCE_SYSTEM,
    tenantId: sale.tenant_id,
    branchId: sale.branch_id,
    terminalId: sale.terminal_id,
    operatorId: sale.selling_operator_id,
    occurredAt: sale.finalized_at,
    totalMinor: sale.subtotal_minor,
    lines,
    ...(tenders.length > 0 ? { tenders } : {}),
    ...(admissionCheckAt === null ? {} : { admissionCheckAt }),
    ...(receipt === undefined ? {} : { receipt }),
  };
}
