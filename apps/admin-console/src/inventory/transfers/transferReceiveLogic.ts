/**
 * RT-1515 (PR 3) pure helpers for receiving a shipment Transfer and closing it
 * (a close of a fully received Transfer, or a short-close of what never
 * arrives). No React, no fetch.
 *
 * Backend-Core owns every rule. These checks only keep the operator from
 * sending a command the contract already refuses. Quantities are exact decimal
 * strings: they are compared as scaled BigInts and never parsed as floats. A
 * receipt may not exceed a line's In transit quantity; an excess is recorded
 * separately as an approved stock adjustment, never on the Transfer, and this
 * console builds no adjustment flow.
 *
 * Helpers return catalog message keys, never copy (RT-399).
 */
import type { MessageKey } from "@/i18n";
import type {
  CloseShipmentTransferCommand,
  RecordShipmentTransferReceiptCommand,
  ShipmentTransfer,
  ShipmentTransferLine,
} from "@/lib/inventory-queries";
import { POSITIVE_QUANTITY } from "../statusMoveLogic";
import { REASON_MAX_LENGTH } from "./transferWriteLogic";

// --- Exact decimal comparison -------------------------------------------------------

const DECIMAL = /^([0-9]+)(?:\.([0-9]+))?$/;

/** The decimal as an integer scaled by 10^`scale`, or null when it is not a plain decimal. */
function scaled(value: string, scale: number): bigint | null {
  const match = DECIMAL.exec(value.trim());
  if (!match) return null;
  return BigInt(match[1] + (match[2] ?? "").padEnd(scale, "0"));
}

function fractionLength(value: string): number {
  return DECIMAL.exec(value.trim())?.[2]?.length ?? 0;
}

/**
 * Compares two unsigned exact-decimal strings ("4" equals "4.0000", "0.5" is
 * above "0.4999"): -1, 0 or 1; null when either is not a plain decimal.
 */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 | null {
  const scale = Math.max(fractionLength(a), fractionLength(b));
  const left = scaled(a, scale);
  const right = scaled(b, scale);
  if (left === null || right === null) return null;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Whether the Transfer line still has a quantity In transit. */
export function hasInTransit(line: Pick<ShipmentTransferLine, "inTransitQuantity">): boolean {
  return compareDecimal(line.inTransitQuantity, "0") === 1;
}

/** The lines a receipt or a short-close is about: those still In transit. */
export function inTransitLines(transfer: ShipmentTransfer): ShipmentTransferLine[] {
  return transfer.lines.filter(hasInTransit);
}

// --- Receive ------------------------------------------------------------------------

export type Disposition = "sellable" | "damaged";
export const DISPOSITIONS: readonly Disposition[] = ["sellable", "damaged"];

/** One line of the form; a blank quantity means "not in this receipt". */
export interface ReceiveLineDraft {
  lineId: string;
  /** Exactly as typed; trimmed on send, never parsed as a float. */
  quantity: string;
  disposition: Disposition;
  /** A destination location id, or "" for the destination's primary location. */
  locationId: string;
}

export interface ReceiveDraft {
  lines: readonly ReceiveLineDraft[];
  note: string;
}

export interface ReceiveErrors {
  form?: MessageKey;
  note?: MessageKey;
  perLine: Record<string, MessageKey>;
}

const filled = (line: ReceiveLineDraft) => line.quantity.trim() !== "";

function quantityError(line: ReceiveLineDraft, inTransit: string): MessageKey | undefined {
  const quantity = line.quantity.trim();
  if (!POSITIVE_QUANTITY.test(quantity)) return "transfers.receive.error.quantity";
  return compareDecimal(quantity, inTransit) === 1 ? "transfers.receive.error.over" : undefined;
}

/** `transferLines` is the Transfer as last read: the In transit figure is the server's. */
export function validateReceive(
  draft: ReceiveDraft,
  transferLines: readonly ShipmentTransferLine[],
): ReceiveErrors {
  const perLine: Record<string, MessageKey> = {};
  const inTransit = new Map(transferLines.map((l) => [l.id, l.inTransitQuantity]));
  const chosen = draft.lines.filter(filled);
  for (const line of chosen) {
    const found = quantityError(line, inTransit.get(line.lineId) ?? "0");
    if (found) perLine[line.lineId] = found;
  }
  const errors: ReceiveErrors = { perLine };
  if (chosen.length === 0) errors.form = "transfers.receive.error.noLines";
  if (draft.note.trim().length > REASON_MAX_LENGTH) errors.note = "transfers.receive.error.note";
  return errors;
}

export function hasReceiveErrors(errors: ReceiveErrors): boolean {
  return Boolean(errors.form || errors.note || Object.keys(errors.perLine).length > 0);
}

/**
 * The strict command: only lines with a quantity. A location is sent only when
 * the destination offers a choice (more than one active location) and one was
 * chosen; otherwise null, the destination's primary location.
 */
export function buildReceiveCommand(
  draft: ReceiveDraft,
  multiLocation: boolean,
): RecordShipmentTransferReceiptCommand {
  const note = draft.note.trim();
  return {
    lines: draft.lines.filter(filled).map((line) => ({
      transferLineId: line.lineId,
      quantity: line.quantity.trim(),
      disposition: line.disposition,
      stockLocationId: multiLocation && line.locationId ? line.locationId : null,
    })),
    note: note || null,
  };
}

// --- Close and short-close ----------------------------------------------------------

/** A short-close reason is required: 1 to 500 characters once trimmed. */
export function shortCloseReasonError(reason: string): MessageKey | undefined {
  const length = reason.trim().length;
  return length === 0 || length > REASON_MAX_LENGTH
    ? "transfers.shortClose.error.reason"
    : undefined;
}

/** Null closes a fully received Transfer; a reason short-closes what is still In transit. */
export function buildCloseCommand(reason: string | null): CloseShipmentTransferCommand {
  const trimmed = reason?.trim();
  return { shortCloseReason: trimmed || null };
}
