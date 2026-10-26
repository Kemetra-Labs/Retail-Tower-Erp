/**
 * RT-436 pure helpers for the status-disposition action (RT-435
 * `createStatusMove`). No React, no fetch.
 *
 * The backend is the authority on every rule here: which reason code allows
 * which (from, to) pair, who may move stock out of a sensitive status, tracked
 * products, ERP netting. The filtering below only keeps the operator from
 * building a command the contract already says is refused; a refusal that does
 * get through is shown exactly as the server sent it (`message` + `code`).
 *
 * RT-399: helpers return catalog message keys, never copy.
 */
import type { MessageKey } from "@/i18n";
import type {
  CreateStatusMoveCommand,
  InventoryReasonCode,
  InventoryStatus,
} from "@/lib/inventory-queries";

/** Roles the status-move operation accepts (store_manager only inside its store scope). */
export const MOVE_ROLES = ["owner", "tenant_admin", "store_manager"] as const;

/** Moving stock OUT of damaged / expired is owner / tenant_admin only (960, 961, D2). */
const SENSITIVE_SOURCE_ROLES = ["owner", "tenant_admin"] as const;

/**
 * The statuses a disposition can move between. `quality_hold` and `recall_hold`
 * belong to the tracking-hold workflow (RT-449) and are never offered here.
 */
export const DISPOSITION_STATUSES = [
  "sellable",
  "return_inspection",
  "damaged",
  "expired",
] as const satisfies readonly InventoryStatus[];

export type DispositionStatus = (typeof DISPOSITION_STATUSES)[number];

const SENSITIVE_SOURCES: readonly DispositionStatus[] = ["damaged", "expired"];

/** Navigation gate: mirrors the API's roles. Not an authorization decision. */
export function canMoveStock(role: string | null | undefined): boolean {
  return (MOVE_ROLES as readonly string[]).includes(role ?? "");
}

/** The statuses this role may move stock out of (a convenience; the API decides). */
export function fromStatusesFor(role: string | null | undefined): DispositionStatus[] {
  const sensitiveOk = (SENSITIVE_SOURCE_ROLES as readonly string[]).includes(role ?? "");
  return DISPOSITION_STATUSES.filter((s) => sensitiveOk || !SENSITIVE_SOURCES.includes(s));
}

/** Every disposition status except the source. */
export function toStatusesFor(from: DispositionStatus): DispositionStatus[] {
  return DISPOSITION_STATUSES.filter((s) => s !== from);
}

/** The pair-specific reason codes of `createStatusMove`; `correction` fits any pair. */
const PAIR_REASONS: Record<string, InventoryReasonCode> = {
  "sellable>damaged": "damage",
  "sellable>expired": "expiry",
  "return_inspection>sellable": "inspection_restock",
  "return_inspection>damaged": "inspection_damage",
};

/** The reason codes offered for a pair: its own code first, then `correction`. */
export function reasonsFor(from: DispositionStatus, to: DispositionStatus): InventoryReasonCode[] {
  if (from === to) return [];
  const own = PAIR_REASONS[`${from}>${to}`];
  return own ? [own, "correction"] : ["correction"];
}

/** `correction` needs an operator note. */
export function noteRequired(reason: InventoryReasonCode | ""): boolean {
  return reason === "correction";
}

const REASON_KEYS: Record<string, MessageKey> = {
  damage: "inventory.move.reason.damage",
  expiry: "inventory.move.reason.expiry",
  inspection_restock: "inventory.move.reason.inspection_restock",
  inspection_damage: "inventory.move.reason.inspection_damage",
  correction: "inventory.move.reason.correction",
};

export function reasonKey(code: InventoryReasonCode | string): MessageKey {
  return Object.hasOwn(REASON_KEYS, code) ? REASON_KEYS[code] : "inventory.value.unknown";
}

/** Contract `PositiveDecimalQuantity`: unsigned, not zero, <= 15 integer and <= 4 fraction digits. */
const POSITIVE_QUANTITY = /^(?!0+(?:\.0+)?$)[0-9]{1,15}(\.[0-9]{1,4})?$/;

export const NOTE_MAX_LENGTH = 500;
const UNIT_MAX_LENGTH = 32;

export type MoveFieldError =
  | "inventory.move.error.quantity"
  | "inventory.move.error.reason"
  | "inventory.move.error.note"
  | "inventory.move.error.unit";

export interface MoveDraft {
  productId: string;
  from: DispositionStatus;
  to: DispositionStatus;
  reason: InventoryReasonCode | "";
  /** Exactly as typed; trimmed on send, never parsed as a number. */
  quantity: string;
  note: string;
  /** A non-primary location, or "" for the store's primary location. */
  locationId: string;
  stockingUnit: string | null | undefined;
}

export type MoveErrors = Partial<Record<"quantity" | "reason" | "note" | "unit", MoveFieldError>>;

export function validateMove(draft: MoveDraft): MoveErrors {
  const errors: MoveErrors = {};
  const unit = draft.stockingUnit?.trim();
  if (!unit || unit.length > UNIT_MAX_LENGTH) errors.unit = "inventory.move.error.unit";
  if (!POSITIVE_QUANTITY.test(draft.quantity.trim())) {
    errors.quantity = "inventory.move.error.quantity";
  }
  if (!draft.reason || !reasonsFor(draft.from, draft.to).includes(draft.reason)) {
    errors.reason = "inventory.move.error.reason";
  }
  const note = draft.note.trim();
  if (note.length > NOTE_MAX_LENGTH || (noteRequired(draft.reason) && !note)) {
    errors.note = "inventory.move.error.note";
  }
  return errors;
}

/** The strict `CreateStatusMoveCommand`: store, tenant and actor are server-side, never sent. */
export function buildCommand(draft: MoveDraft): CreateStatusMoveCommand {
  const note = draft.note.trim();
  return {
    tenantProductRef: draft.productId,
    quantity: draft.quantity.trim(),
    stockingUnit: (draft.stockingUnit ?? "").trim(),
    fromStatus: draft.from,
    toStatus: draft.to,
    reasonCode: draft.reason as InventoryReasonCode,
    ...(draft.locationId ? { stockLocationId: draft.locationId } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * Idempotency-Key for one command: a v4 UUID (36 printable ASCII characters,
 * inside the contract's 16-128). A retry of the SAME command reuses its key; any
 * edit, a success or a key conflict starts a new one.
 */
export function newMoveKey(): string {
  return crypto.randomUUID();
}

export interface KeyedCommand {
  fingerprint: string;
  key: string;
}

/** The key for `command`: the held one when the command is unchanged, else a new one. */
export function keyFor(held: KeyedCommand | null, command: CreateStatusMoveCommand): KeyedCommand {
  const fingerprint = JSON.stringify(command);
  return held?.fingerprint === fingerprint ? held : { fingerprint, key: newMoveKey() };
}

// --- Outcome -------------------------------------------------------------------------

interface BackendError {
  error?: { code?: string; message?: string; request_id?: string };
}

export type MoveOutcome =
  | { kind: "recorded" }
  | {
      kind: "rejected";
      status: number;
      /** The server's own words, shown verbatim. */
      message?: string;
      code?: string;
      requestId?: string;
      retryAfter?: number;
    };

export function classifyMoveResult(result: {
  status: number;
  error?: unknown;
  retryAfter?: number;
}): MoveOutcome {
  if (result.status === 200 || result.status === 201) return { kind: "recorded" };
  const body = (result.error as BackendError | undefined)?.error;
  return {
    kind: "rejected",
    status: result.status,
    message: body?.message,
    code: body?.code,
    requestId: body?.request_id,
    retryAfter: result.retryAfter,
  };
}

/** A conflict on the key itself: the next attempt must use a fresh key. */
export function isKeyConflict(outcome: MoveOutcome): boolean {
  return outcome.kind === "rejected" && outcome.code === "idempotency_key_conflict";
}
