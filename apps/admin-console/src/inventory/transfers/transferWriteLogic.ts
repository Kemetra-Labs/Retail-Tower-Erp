/**
 * RT-1515 (PR 2) pure helpers for the shipment-Transfer writes: create a Draft,
 * approve, cancel and dispatch. No React, no fetch.
 *
 * Backend-Core owns every rule (who may write, which state allows which
 * action, the ERP mappings, the tracked-product rules). These checks only keep
 * the operator from sending a command the contract already refuses; a refusal
 * that does get through is worded here by its `error.code`, and the server's
 * own `message` text is never shown (owner decision, RT-1515).
 *
 * Idempotency (RT-436 pattern): a retry of the SAME command reuses its key and
 * its body; any edit, a success or an `idempotency_key_conflict` starts a new
 * key. The approve body carries a time, so the held command is resent as built:
 * a retry must not change the body under the same key.
 *
 * Helpers return catalog message keys, never copy (RT-399).
 */
import type { MessageKey } from "@/i18n";
import type {
  ApproveShipmentTransferCommand,
  CancelShipmentTransferCommand,
  CreateShipmentTransferCommand,
  DispatchShipmentTransferCommand,
} from "@/lib/inventory-queries";
import { type KeyedCommand, classifyWrite, isKeyConflict, keyFor } from "../../tracking/writeLogic";
import type { WriteOutcome } from "../../tracking/writeLogic";
import { MOVE_ROLES, NOTE_MAX_LENGTH, POSITIVE_QUANTITY } from "../statusMoveLogic";

export { classifyWrite, isKeyConflict };
export type { WriteOutcome };

/** Roles the write operations accept (the API still decides, store scope included). */
export function canWriteTransfers(role: string | null | undefined): boolean {
  return (MOVE_ROLES as readonly string[]).includes(role ?? "");
}

export const MAX_LINES = 100;
export const REASON_MAX_LENGTH = NOTE_MAX_LENGTH;
const UNIT_MAX_LENGTH = 32;

// --- Create -------------------------------------------------------------------------

type TrackingMode = "none" | "batch" | "serial";

/** One line of the form; `unit` is the source store's stocking unit, unknown until it is read. */
export interface LineDraft {
  /** A local id for keys and error lookup; never sent. */
  id: number;
  productId: string;
  name: string;
  trackingMode: TrackingMode;
  /** The chosen batch for a batch product; null for an untracked one. */
  identityId: string | null;
  /** Exactly as typed; trimmed on send, never parsed as a number. */
  quantity: string;
  unit: string | null | undefined;
}

export interface CreateDraft {
  sourceStoreId: string;
  destinationStoreId: string;
  reason: string;
  lines: readonly LineDraft[];
}

export interface LineErrors {
  identity?: MessageKey;
  quantity?: MessageKey;
  unit?: MessageKey;
  duplicate?: MessageKey;
}

export interface CreateErrors {
  source?: MessageKey;
  destination?: MessageKey;
  lines?: MessageKey;
  reason?: MessageKey;
  perLine: Record<number, LineErrors>;
}

/** A line's identity in the Transfer: one line per product (and batch). */
function lineIdentity(line: Pick<LineDraft, "productId" | "identityId">): string {
  return `${line.productId}|${line.identityId ?? ""}`;
}

/** Whether another line already holds this product (and batch). */
export function isDuplicateLine(
  lines: readonly LineDraft[],
  candidate: Pick<LineDraft, "productId" | "identityId">,
): boolean {
  return lines.some((l) => lineIdentity(l) === lineIdentity(candidate));
}

function unitError(unit: string | null | undefined): MessageKey | undefined {
  const trimmed = unit?.trim();
  return !trimmed || trimmed.length > UNIT_MAX_LENGTH ? "transfers.create.error.unit" : undefined;
}

function lineErrorsOf(line: LineDraft, firstOf: ReadonlyMap<string, number>): LineErrors {
  const errors: LineErrors = {};
  if (line.trackingMode === "batch" && !line.identityId) {
    errors.identity = "transfers.create.error.identity";
  }
  if (!POSITIVE_QUANTITY.test(line.quantity.trim())) {
    errors.quantity = "transfers.create.error.quantity";
  }
  const unit = unitError(line.unit);
  if (unit) errors.unit = unit;
  if (firstOf.get(lineIdentity(line)) !== line.id) {
    errors.duplicate = "transfers.create.error.duplicate";
  }
  return errors;
}

function headerErrors(draft: CreateDraft): Omit<CreateErrors, "perLine"> {
  const errors: Omit<CreateErrors, "perLine"> = {};
  if (!draft.sourceStoreId) errors.source = "transfers.create.error.source";
  if (!draft.destinationStoreId) errors.destination = "transfers.create.error.destination";
  else if (draft.destinationStoreId === draft.sourceStoreId) {
    errors.destination = "transfers.create.error.sameStore";
  }
  if (draft.lines.length === 0) errors.lines = "transfers.create.error.noLines";
  else if (draft.lines.length > MAX_LINES) errors.lines = "transfers.create.error.tooManyLines";
  if (draft.reason.trim().length > REASON_MAX_LENGTH) {
    errors.reason = "transfers.create.error.reason";
  }
  return errors;
}

export function validateCreate(draft: CreateDraft): CreateErrors {
  const firstOf = new Map<string, number>();
  for (const line of draft.lines) {
    if (!firstOf.has(lineIdentity(line))) firstOf.set(lineIdentity(line), line.id);
  }
  const perLine: Record<number, LineErrors> = {};
  for (const line of draft.lines) {
    const found = lineErrorsOf(line, firstOf);
    if (Object.keys(found).length > 0) perLine[line.id] = found;
  }
  return { ...headerErrors(draft), perLine };
}

export function hasCreateErrors(errors: CreateErrors): boolean {
  return Object.keys(errors.perLine).length > 0 || Object.keys(errors).length > 1;
}

/** The strict command: tenant and actor are server-side, never sent. */
export function buildCreateCommand(draft: CreateDraft): CreateShipmentTransferCommand {
  const reason = draft.reason.trim();
  return {
    sourceStoreId: draft.sourceStoreId,
    destinationStoreId: draft.destinationStoreId,
    lines: draft.lines.map((line) => ({
      tenantProductRef: line.productId,
      quantity: line.quantity.trim(),
      stockingUnit: (line.unit ?? "").trim(),
      trackingIdentityId: line.trackingMode === "batch" ? line.identityId : null,
    })),
    reason: reason || null,
  };
}

// --- Approve, cancel, dispatch --------------------------------------------------------

/** The reservation windows offered, in days from the moment of submit. */
export const EXPIRY_DAYS = [1, 3, 7] as const;
export type ExpiryDays = (typeof EXPIRY_DAYS)[number];
export const DEFAULT_EXPIRY_DAYS: ExpiryDays = 3;

const DAY_MS = 86_400_000;

/** The reservation expiry for a window starting at `now`, as an ISO date-time. */
export function expiryAt(days: ExpiryDays, now: Date): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

export function buildApproveCommand(days: ExpiryDays, now: Date): ApproveShipmentTransferCommand {
  return { reservationExpiresAt: expiryAt(days, now) };
}

/** A cancellation reason is required: 1 to 500 characters once trimmed. */
export function cancelReasonError(reason: string): MessageKey | undefined {
  const length = reason.trim().length;
  return length === 0 || length > REASON_MAX_LENGTH ? "transfers.cancel.error.reason" : undefined;
}

export function buildCancelCommand(reason: string): CancelShipmentTransferCommand {
  return { reason: reason.trim() };
}

/** The dispatch note is optional, at most 500 characters. */
export function noteError(note: string): MessageKey | undefined {
  return note.trim().length > REASON_MAX_LENGTH ? "transfers.dispatch.error.note" : undefined;
}

export function buildDispatchCommand(note: string): DispatchShipmentTransferCommand {
  const trimmed = note.trim();
  return { note: trimmed || null };
}

export type TransferAction = "approve" | "cancel" | "dispatch" | "receive" | "close" | "shortClose";

/** A short-close writes a loss off, so it is the discrepancy approval: owner or tenant_admin only. */
const SHORT_CLOSE_ROLES = ["owner", "tenant_admin"] as const;

export function canShortClose(role: string | null | undefined): boolean {
  return (SHORT_CLOSE_ROLES as readonly string[]).includes(role ?? "");
}

/**
 * The actions a Transfer in `state` offers a role: approve only a draft, cancel a
 * draft or approved Transfer, dispatch only an approved one; receive while goods
 * are on the road (in transit or partially received), with a short-close of what
 * never arrives for owner and tenant_admin only; close a fully received
 * Transfer; nothing after that. A navigation convenience; the API decides.
 */
export function actionsFor(state: string, role: string | null | undefined): TransferAction[] {
  if (!canWriteTransfers(role)) return [];
  if (state === "draft") return ["approve", "cancel"];
  if (state === "approved") return ["dispatch", "cancel"];
  if (state === "in_transit" || state === "partially_received") {
    return canShortClose(role) ? ["receive", "shortClose"] : ["receive"];
  }
  if (state === "received") return ["close"];
  return [];
}

// --- Idempotency ----------------------------------------------------------------------

export interface HeldWrite<C> extends KeyedCommand {
  /** The command as first built, resent unchanged on a retry. */
  command: C;
}

/**
 * The key and command for `input`: the held pair when the input is unchanged
 * (a retry after no answer cannot record it twice), else a new key and a body
 * built now. `input` is what the operator chose, not the built body.
 */
export function holdFor<C>(
  held: HeldWrite<C> | null,
  input: unknown,
  build: () => C,
): HeldWrite<C> {
  const keyed = keyFor(held, input);
  return held && keyed === held ? held : { ...keyed, command: build() };
}

// --- Refusals -------------------------------------------------------------------------

export type Refused = Extract<WriteOutcome, { kind: "rejected" }>;

export interface Refusal {
  key: MessageKey;
  /** Set only for a code this console has no copy for: shown as machine data. */
  unknownCode?: string;
  /** The server's wait for a 429, in seconds. */
  wait?: number;
}

const CODE_KEYS: Record<string, MessageKey> = {
  validation_error: "transfers.write.error.validation",
  unauthorized: "transfers.write.error.session",
  forbidden: "transfers.write.error.forbidden",
  not_found: "transfers.write.error.notFound",
  rate_limited: "transfers.write.error.rateLimited",
  shipment_transfer_not_in_state: "transfers.write.error.notInState",
  cross_legal_entity_transfer: "transfers.write.error.crossLegalEntity",
  tracking_identity_required: "transfers.write.error.identityRequired",
  tracking_identity_held_or_expired: "transfers.write.error.identityHeldOrExpired",
  serial_transfer_not_supported: "transfers.write.error.serialNotSupported",
  transfer_warehouse_unmapped: "transfers.write.error.warehouseUnmapped",
  transfer_item_unmapped: "transfers.write.error.itemUnmapped",
  idempotency_key_conflict: "transfers.write.error.keyConflict",
  over_receipt_requires_approval: "transfers.write.error.overReceipt",
  short_close_reason_required: "transfers.write.error.shortCloseReason",
};

const STATUS_CODES: Record<number, string> = {
  400: "validation_error",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  429: "rate_limited",
};

/** The copy for a refusal: by `error.code` first, by the status only when no code came. */
export function refusalOf(outcome: Refused): Refusal {
  const code = outcome.code || STATUS_CODES[outcome.status];
  const wait = outcome.status === 429 || code === "rate_limited" ? outcome.retryAfter : undefined;
  if (code && Object.hasOwn(CODE_KEYS, code)) return { key: CODE_KEYS[code], wait };
  return {
    key: "transfers.write.error.generic",
    unknownCode: outcome.code || undefined,
  };
}
