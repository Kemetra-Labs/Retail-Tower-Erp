/**
 * RT-1515 (PR 1) pure helpers for the read-only shipment-Transfer views. No
 * React, no fetch.
 *
 * Truth rules (as the other inventory views): quantities are the API's exact
 * decimal strings, shown as sent, never parsed or summed here. In Transit is a
 * line quantity the API computes, never a location or a status (G4-1). An ERP
 * leg state is data reported by the API; it never moves the Transfer's state.
 * No Available-to-Sell figure is shown: none exists yet (RT-1515 owner decision).
 *
 * Error copy is keyed by the envelope's `error.code` first and by the HTTP
 * status only when the body carried no code (UX-12.33). Helpers return catalog
 * message keys, never copy (RT-399).
 */
import type { MessageKey } from "@/i18n";
import type {
  ShipmentLegIntegrationState,
  ShipmentTransfer,
  ShipmentTransferFilter,
  ShipmentTransferReceipt,
  ShipmentTransferState,
} from "@/lib/inventory-queries";
import { type ReadErrorKind, isUuid } from "../inventoryLogic";
import type { InventoryError } from "../useInventory";

/** The contract's states, in lifecycle order (the state filter's options). */
export const TRANSFER_STATES: readonly ShipmentTransferState[] = [
  "draft",
  "approved",
  "in_transit",
  "partially_received",
  "received",
  "closed",
  "cancelled",
];

const DIRECTIONS = ["outbound", "inbound", "any"] as const;
export type TransferDirection = (typeof DIRECTIONS)[number];

const STATE_KEYS: Record<ShipmentTransferState, MessageKey> = {
  draft: "transfers.state.draft",
  approved: "transfers.state.approved",
  in_transit: "transfers.state.in_transit",
  partially_received: "transfers.state.partially_received",
  received: "transfers.state.received",
  closed: "transfers.state.closed",
  cancelled: "transfers.state.cancelled",
};

export function transferStateKey(state: string): MessageKey {
  return Object.hasOwn(STATE_KEYS, state)
    ? STATE_KEYS[state as ShipmentTransferState]
    : "transfers.value.unknown";
}

/**
 * Status is data, not decoration (UX-10.29): only goods on the road read in
 * the pending role; settled and not-yet-moving states stay quiet. A state this
 * console does not know reads in the danger role, as Unknown does.
 */
export function transferStateTone(state: string): string {
  if (state === "in_transit" || state === "partially_received") return "badge--pending";
  return Object.hasOwn(STATE_KEYS, state) ? "" : "badge--danger";
}

const LEG_KEYS: Record<ShipmentLegIntegrationState, MessageKey> = {
  not_posted: "transfers.leg.not_posted",
  pending: "transfers.leg.pending",
  confirmed: "transfers.leg.confirmed",
  rejected: "transfers.leg.rejected",
  reconciliation_required: "transfers.leg.reconciliation_required",
};

/** A leg's ERP posting state; the dispatch leg is null until the goods leave. */
export function legStateKey(state: string | null | undefined): MessageKey {
  if (state === null || state === undefined) return "transfers.leg.notDispatched";
  return Object.hasOwn(LEG_KEYS, state)
    ? LEG_KEYS[state as ShipmentLegIntegrationState]
    : "transfers.value.unknown";
}

const LEG_TONES: Record<string, string> = {
  pending: "badge--pending",
  confirmed: "badge--success",
  rejected: "badge--danger",
  reconciliation_required: "badge--warning",
};

/** The colour that reinforces a leg state's text; not posted or not dispatched stays neutral. */
export function legStateTone(state: string | null | undefined): string {
  if (state === null || state === undefined || state === "not_posted") return "";
  return LEG_TONES[state] ?? "badge--danger";
}

// --- Filters (kept in the URL so a reload keeps the operator's place) ----------

/** The filter the URL asks for; a value the contract would refuse is dropped, never sent. */
export function filterFromParams(params: URLSearchParams): ShipmentTransferFilter {
  const filter: ShipmentTransferFilter = {};
  const storeId = params.get("store") ?? undefined;
  if (isUuid(storeId)) {
    filter.storeId = storeId;
    const direction = params.get("direction");
    if ((DIRECTIONS as readonly string[]).includes(direction ?? "")) {
      filter.direction = direction as TransferDirection;
    }
  }
  const state = params.get("state");
  if ((TRANSFER_STATES as readonly string[]).includes(state ?? "")) {
    filter.state = state as ShipmentTransferState;
  }
  return filter;
}

/** The URL params for a filter; `direction` only travels with a store. */
export function paramsFromFilter(filter: ShipmentTransferFilter): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter.storeId) {
    params.store = filter.storeId;
    if (filter.direction && filter.direction !== "any") params.direction = filter.direction;
  }
  if (filter.state) params.state = filter.state;
  return params;
}

export function hasFilter(filter: ShipmentTransferFilter): boolean {
  return Boolean(filter.storeId || filter.state);
}

// --- Errors ----------------------------------------------------------------------

const CODE_KINDS: Record<string, ReadErrorKind> = {
  validation_error: "rejected",
  unauthorized: "session",
  forbidden: "forbidden",
  not_found: "not-found",
  rate_limited: "rate-limited",
};

/** The error's kind from its `error.code`; the status-derived kind only when no code is known. */
export function transferErrorOf(error: InventoryError): InventoryError {
  const byCode =
    error.code && Object.hasOwn(CODE_KINDS, error.code) ? CODE_KINDS[error.code] : undefined;
  return byCode ? { ...error, kind: byCode } : error;
}

/**
 * The list's first page answered 404: the API's non-disclosing answer while
 * shipment Transfers are not switched on for the tenant (or, with a store
 * filter, while that store is not one the caller may see).
 */
export function isNotAvailable(error: InventoryError | undefined): boolean {
  return error !== undefined && transferErrorOf(error).kind === "not-found";
}

// --- Detail ----------------------------------------------------------------------

export interface TimelineEntry {
  key: MessageKey;
  at: string;
}

/** The lifecycle timestamps the Transfer actually carries, in lifecycle order. */
export function timelineOf(transfer: ShipmentTransfer): TimelineEntry[] {
  const entries: (TimelineEntry | undefined)[] = [
    { key: "transfers.detail.createdAt", at: transfer.createdAt },
    transfer.approval
      ? { key: "transfers.detail.approvedAt", at: transfer.approval.at }
      : undefined,
    transfer.dispatch
      ? { key: "transfers.detail.dispatchedAt", at: transfer.dispatch.at }
      : undefined,
    transfer.shortClose
      ? { key: "transfers.detail.shortClosedAt", at: transfer.shortClose.approvedAt }
      : undefined,
    transfer.closure ? { key: "transfers.detail.closedAt", at: transfer.closure.at } : undefined,
    transfer.cancellation
      ? { key: "transfers.detail.cancelledAt", at: transfer.cancellation.cancelledAt }
      : undefined,
  ];
  return entries.filter((e): e is TimelineEntry => e !== undefined);
}

export interface ReceiptRow {
  receipt: ShipmentTransferReceipt;
  /** The receipt line's position in the receipt; receipt-level cells span the receipt. */
  index: number;
  lineSeq: number | undefined;
  quantity: string;
  inventoryStatus: string;
}

/** One row per received line, the line named by its sequence on the Transfer. */
export function receiptRowsOf(
  receipts: readonly ShipmentTransferReceipt[],
  transfer: ShipmentTransfer | undefined,
): ReceiptRow[] {
  const seqOf = new Map(transfer?.lines.map((l) => [l.id, l.lineSeq]) ?? []);
  return receipts.flatMap((receipt) =>
    receipt.lines.map((line, index) => ({
      receipt,
      index,
      lineSeq: seqOf.get(line.transferLineId),
      quantity: line.quantity,
      inventoryStatus: line.inventoryStatus,
    })),
  );
}
