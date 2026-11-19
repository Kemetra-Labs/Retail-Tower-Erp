/**
 * Shipment Transfer rules — Jira RT-1513 (RT-291 Gate 5; contract RT-1512, `inventory/inventory.yaml`
 * 1.21.0-draft; posting-feed.yaml 1.17.0-draft). Pure: no database, no clock, no Nest. The lifecycle
 * (802), the In Transit arithmetic (G4-1, 736), the receipt and short-close plans (810-813) and the
 * frozen wire bodies of the two ERP legs (876, 877, 888, 889).
 *
 * In Transit is NOT a Stock Location or an inventory status: it is the per-line quantity
 * `dispatched - received - short_closed`, held on the Transfer lines. Quantities are scaled bigints
 * (numeric(19,4)), never `Number`.
 */
import { parseQuantity } from '../../common/quantity/decimal-quantity';

export const TRANSFER_STATES = [
  'draft',
  'approved',
  'in_transit',
  'partially_received',
  'received',
  'closed',
  'cancelled',
] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

export type TransferCommand = 'approve' | 'cancel' | 'dispatch' | 'receive' | 'close';

/** An ERP Stock Entry carries at most this many rows (the contract's 100-line limit). */
export const TRANSFER_LINE_MAX = 100;
/** An ERP leg carries at most 13 integer digits (posting-feed.yaml `TransferDispatchLine.quantity`). */
const ERP_QUANTITY_MAX_INTEGER_DIGITS = 13;
export const TRANSFER_SOURCE_SYSTEM = 'retail-tower';

/** A refusal with a stable machine code of the existing error envelope (a 409, or the code named). */
export class TransferRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ALLOWED_FROM: Readonly<Record<TransferCommand, readonly TransferState[]>> = {
  approve: ['draft'],
  // Cancel is only before dispatch (798): goods already in transit leave through a receipt or a short-close.
  cancel: ['draft', 'approved'],
  dispatch: ['approved'],
  receive: ['in_transit', 'partially_received'],
  close: ['received', 'partially_received', 'in_transit'],
};

const TARGET: Readonly<Partial<Record<TransferCommand, TransferState>>> = {
  approve: 'approved',
  cancel: 'cancelled',
  dispatch: 'in_transit',
  close: 'closed',
};

/** The state a command leaves the Transfer in. `receive` is decided by the lines (see `stateAfterReceipt`). */
export function applyCommand(state: TransferState, command: TransferCommand): TransferState | null {
  if (!ALLOWED_FROM[command].includes(state)) {
    throw new TransferRuleError(
      'shipment_transfer_not_in_state',
      `${command} is not allowed while the Transfer is ${state}.`,
    );
  }
  return TARGET[command] ?? null;
}

// ---- Lines and In Transit --------------------------------------------------------------------------------------

export interface LineQuantities {
  readonly id: string;
  readonly lineSeq: number;
  readonly quantity: string;
  readonly dispatchedQuantity: string;
  readonly receivedQuantity: string;
  readonly shortClosedQuantity: string;
}

/** `dispatched - received - short_closed`, exact. Never negative (a CHECK backs it). */
export function inTransitOf(line: LineQuantities): bigint {
  return (
    parseQuantity(line.dispatchedQuantity) -
    parseQuantity(line.receivedQuantity) -
    parseQuantity(line.shortClosedQuantity)
  );
}

/** A quantity an ERP leg can carry: at most 13 integer digits (the numeric(19,4) column allows 15). */
export function assertErpQuantity(scaled: bigint, field: string): void {
  if (scaled >= 10n ** BigInt(ERP_QUANTITY_MAX_INTEGER_DIGITS) * 10_000n) {
    throw new TransferRuleError(
      'validation_error',
      `${field} exceeds ${ERP_QUANTITY_MAX_INTEGER_DIGITS} integer digits, the limit of one ERP Stock Entry row.`,
    );
  }
}

// ---- Receipts (803, 804, 809-813) ------------------------------------------------------------------------------

export interface ReceiptRequestLine {
  readonly transferLineId: string;
  readonly quantity: string;
}

export interface ReceiptPlanLine {
  readonly transferLineId: string;
  readonly quantity: bigint;
  /** The line's received total after this receipt. */
  readonly receivedAfter: bigint;
}

/**
 * Plan one receipt. Every requested line must belong to the Transfer and appear once; a quantity above the
 * line's In Transit is the over-receipt refusal (813): nothing is written, and the excess is recorded, with
 * approval, as a separate adjustment at the destination, never on the Transfer. A short receipt fabricates
 * nothing: the open quantity stays In Transit.
 */
export function planReceipt(
  lines: readonly LineQuantities[],
  requested: readonly ReceiptRequestLine[],
): ReceiptPlanLine[] {
  const byId = new Map(lines.map((l) => [l.id, l] as const));
  const seen = new Set<string>();
  const plan: ReceiptPlanLine[] = [];
  for (const r of requested) {
    const line = byId.get(r.transferLineId);
    if (!line) {
      throw new TransferRuleError('validation_error', 'A receipt line names a line that is not on this Transfer.');
    }
    if (seen.has(r.transferLineId)) {
      throw new TransferRuleError('validation_error', 'A receipt may name each Transfer line only once.');
    }
    seen.add(r.transferLineId);
    const quantity = parseQuantity(r.quantity, 'quantity');
    if (quantity <= 0n) throw new TransferRuleError('validation_error', 'A receipt quantity must be strictly positive.');
    if (quantity > inTransitOf(line)) {
      throw new TransferRuleError(
        'over_receipt_requires_approval',
        'A receipt line exceeds the quantity in transit.',
      );
    }
    plan.push({ transferLineId: line.id, quantity, receivedAfter: parseQuantity(line.receivedQuantity) + quantity });
  }
  return plan;
}

/** `received` when every line's In Transit reaches zero after the receipt, else `partially_received`. */
export function stateAfterReceipt(
  lines: readonly LineQuantities[],
  plan: readonly ReceiptPlanLine[],
): TransferState {
  const taken = new Map(plan.map((p) => [p.transferLineId, p.quantity] as const));
  const open = lines.some((l) => inTransitOf(l) - (taken.get(l.id) ?? 0n) > 0n);
  return open ? 'partially_received' : 'received';
}

// ---- Close and short-close (812) -------------------------------------------------------------------------------

export interface ShortCloseLine {
  readonly transferLineId: string;
  readonly quantity: bigint;
}

/**
 * The close plan. A fully received Transfer closes with no reason; anything still in transit closes only as an
 * approved short-close with a reason, which writes each line's remaining In Transit off as a loss. Without a
 * reason while any quantity is in transit the close is refused (`short_close_reason_required`).
 */
export function planClose(
  lines: readonly LineQuantities[],
  shortCloseReason: string | null,
): { readonly shortClose: boolean; readonly lines: ShortCloseLine[] } {
  const open: ShortCloseLine[] = lines
    .map((l) => ({ transferLineId: l.id, quantity: inTransitOf(l) }))
    .filter((l) => l.quantity > 0n);
  if (open.length === 0) {
    if (shortCloseReason !== null) {
      throw new TransferRuleError('validation_error', 'shortCloseReason must be null: nothing is in transit.');
    }
    return { shortClose: false, lines: [] };
  }
  if (shortCloseReason === null || shortCloseReason.trim().length === 0) {
    throw new TransferRuleError(
      'short_close_reason_required',
      'Quantity is still in transit: a close needs a short-close reason.',
    );
  }
  return { shortClose: true, lines: open };
}

// ---- Legal entity (817, 963) ----------------------------------------------------------------------------------

/**
 * V1: one tenant has one ERP site and one Company (provisioning-feed: a second Company stops provisioning), so a
 * store's legal entity is its tenant. Both stores are resolved under the caller's tenant RLS, which makes a store
 * of another tenant a non-disclosing 404 before this check. The seam exists so the refusal is explicit and testable
 * the day a store can belong to another legal entity (the intercompany workflow is out of scope, S04-D04).
 */
export type LegalEntityOf = (storeId: string) => string;

export function assertSameLegalEntity(legalEntityOf: LegalEntityOf, sourceStoreId: string, destinationStoreId: string): void {
  if (legalEntityOf(sourceStoreId) !== legalEntityOf(destinationStoreId)) {
    throw new TransferRuleError(
      'cross_legal_entity_transfer',
      'The stores belong to different legal entities: that is an intercompany transfer, not a Transfer.',
    );
  }
}

// ---- Leg keys and the frozen ERP bodies (876, 877, 888, 889) ---------------------------------------------------

/** `transfer_dispatch:<transferId>`: the leg-level provenance key of the dispatch (888). */
export function dispatchExternalId(transferId: string): string {
  return `transfer_dispatch:${transferId}`;
}

/** `transfer_receipt:<receiptId>`: the leg-level provenance key of one receipt (889). */
export function receiptExternalId(receiptId: string): string {
  return `transfer_receipt:${receiptId}`;
}

interface DispatchBodyLine {
  readonly lineSeq: number;
  readonly transferLineRef: string;
  readonly erpnextItemRef: string;
  readonly erpnextBatchRef: string | null;
  readonly quantity: string;
  readonly unit: string;
}

export interface DispatchBodyInput {
  readonly transferRef: string;
  readonly sourceStoreId: string;
  readonly destinationStoreId: string;
  readonly sourceWarehouseRef: string;
  readonly transitWarehouseRef: string;
  /** The dispatch's `occurred_at`, UTC with six fractional digits (914), never the time of posting. */
  readonly postingDatetime: string;
  readonly lines: readonly DispatchBodyLine[];
}

const ref = (doctype: 'Item' | 'Warehouse' | 'Batch', name: string): { doctype: string; name: string } => ({ doctype, name });

/** The part of a wire line the dispatch and the receipt share (item, batch, quantity, unit and the Transfer line). */
function legLine(l: DispatchBodyLine): Record<string, unknown> {
  return {
    transferLineRef: l.transferLineRef,
    erpnextItemRef: ref('Item', l.erpnextItemRef),
    erpnextBatchRef: l.erpnextBatchRef === null ? null : ref('Batch', l.erpnextBatchRef),
    quantity: l.quantity,
    unit: l.unit,
  };
}

/** The wire `TransferDispatchPosting` (posting-feed.yaml 1.17.0-draft), strict and frozen. */
export function dispatchBody(input: DispatchBodyInput): Record<string, unknown> {
  if (input.lines.length < 1 || input.lines.length > TRANSFER_LINE_MAX) {
    throw new RangeError(`a dispatch holds 1..${TRANSFER_LINE_MAX} lines`);
  }
  return {
    transferRef: input.transferRef,
    sourceStoreId: input.sourceStoreId,
    destinationStoreId: input.destinationStoreId,
    sourceWarehouseRef: ref('Warehouse', input.sourceWarehouseRef),
    transitWarehouseRef: ref('Warehouse', input.transitWarehouseRef),
    postingDatetime: input.postingDatetime,
    lines: input.lines.map((l) => ({ lineSeq: l.lineSeq, ...legLine(l) })),
  };
}

interface ReceiveBodyLine extends DispatchBodyLine {
  /** The `lineSeq` of the dispatch row this quantity is received against. */
  readonly dispatchLineSeq: number;
}

export interface ReceiveBodyInput {
  readonly transferRef: string;
  readonly receiptRef: string;
  readonly destinationStoreId: string;
  readonly transitWarehouseRef: string;
  readonly destinationWarehouseRef: string;
  /** The CONFIRMED dispatch Stock Entry `{doctype, name}`: the Connector never looks it up (886). */
  readonly dispatchDocument: { readonly doctype: string; readonly name: string };
  readonly postingDatetime: string;
  readonly lines: readonly ReceiveBodyLine[];
}

/** The wire `TransferReceivePosting`, strict and frozen. */
export function receiveBody(input: ReceiveBodyInput): Record<string, unknown> {
  if (input.lines.length < 1 || input.lines.length > TRANSFER_LINE_MAX) {
    throw new RangeError(`a receipt holds 1..${TRANSFER_LINE_MAX} lines`);
  }
  return {
    transferRef: input.transferRef,
    receiptRef: input.receiptRef,
    destinationStoreId: input.destinationStoreId,
    transitWarehouseRef: ref('Warehouse', input.transitWarehouseRef),
    destinationWarehouseRef: ref('Warehouse', input.destinationWarehouseRef),
    dispatchDocumentRef: { doctype: input.dispatchDocument.doctype, name: input.dispatchDocument.name },
    postingDatetime: input.postingDatetime,
    lines: input.lines.map((l) => ({ lineSeq: l.lineSeq, dispatchLineSeq: l.dispatchLineSeq, ...legLine(l) })),
  };
}

