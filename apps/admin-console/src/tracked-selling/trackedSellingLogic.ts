/**
 * RT-455 part 1 pure helpers for the tenant's tracked-selling switch (RT-451
 * owner decisions OD-T1..OD-T7, comments 16215 and 16217). No React, no fetch.
 *
 * Every rule (whether the preconditions hold, who may switch, what switching
 * does) stays in Backend-Core. These helpers mirror the contract's roles so the
 * Console does not offer what the API refuses, and turn the server's answers
 * into the states the screen shows.
 *
 * RT-399: helpers return catalog message keys, never copy.
 */
import type { MessageKey } from "@/i18n";
import type {
  TrackedSellingPrecondition,
  TrackedSellingSetting,
} from "@/lib/tracked-selling-queries";

// --- Roles ----------------------------------------------------------------------

/** `getTrackedSellingSetting`: owner, tenant_admin, store_manager (403 otherwise). */
const READ_ROLES = ["owner", "tenant_admin", "store_manager"] as const;

/** `setTrackedSellingSetting` and the full read: owner or tenant_admin (OD-T2, OD-T6). */
const MANAGE_ROLES = ["owner", "tenant_admin"] as const;

/** The view a role reads: the whole setting, or on/off only (OD-T6). */
export type TrackedSellingView = "manage" | "status";

export function canReadTrackedSelling(role: string | null | undefined): boolean {
  return (READ_ROLES as readonly string[]).includes(role ?? "");
}

export function trackedSellingViewFor(
  role: string | null | undefined,
): TrackedSellingView | undefined {
  if ((MANAGE_ROLES as readonly string[]).includes(role ?? "")) return "manage";
  return canReadTrackedSelling(role) ? "status" : undefined;
}

// --- Read ---------------------------------------------------------------------------

/**
 * The read as the screen needs it. `unavailable` is the contract's
 * non-disclosing 404, answered while the deployment gate is off: the setting is
 * hidden, and so are the tracking pages.
 */
export type TrackedSellingRead =
  | { kind: "ok"; setting: TrackedSellingSetting }
  | { kind: "unavailable" }
  | { kind: "error"; status: number; requestId?: string };

/** The contract's error envelope `{ error: { code, request_id } }`, or nothing. */
function envelopeOf(error: unknown): { code?: unknown; request_id?: unknown } {
  const inner = (error as { error?: unknown } | undefined)?.error;
  return typeof inner === "object" && inner !== null ? inner : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const requestIdOf = (error: unknown) => stringOf(envelopeOf(error).request_id);
const errorCodeOf = (error: unknown) => stringOf(envelopeOf(error).code);

function isSetting(data: unknown): data is TrackedSellingSetting {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { enabled?: unknown }).enabled === "boolean"
  );
}

export function classifyRead(res: {
  status: number;
  data?: unknown;
  error?: unknown;
}): TrackedSellingRead {
  if (res.status === 200 && isSetting(res.data)) return { kind: "ok", setting: res.data };
  if (res.status === 404) return { kind: "unavailable" };
  // A 200 that is not the contract's shape is a failed read, never "off".
  return {
    kind: "error",
    status: res.status === 200 ? 0 : res.status,
    requestId: requestIdOf(res.error),
  };
}

/**
 * Whether the tracking pages show (OD-T4): only once the server answered that
 * the switch is on. Loading, a failed read, the gate's 404 and "off" all hide
 * them, so the Console never shows tracking for a tenant it cannot confirm.
 */
export function trackedSellingOn(read: TrackedSellingRead | undefined): boolean {
  return read?.kind === "ok" && read.setting.enabled;
}

/** OD-T7: switched on while a precondition no longer holds; shown as a warning. */
export function showPreconditionWarning(setting: TrackedSellingSetting): boolean {
  return setting.enabled && setting.preconditionsMet === false;
}

// --- Preconditions -----------------------------------------------------------------

/** The contract's six Q13 preconditions, in its order. */
export const PRECONDITIONS: readonly TrackedSellingPrecondition[] = [
  "sale_effects_active",
  "status_moves_available",
  "erp_tracking_import",
  "erp_batch_posting_verified",
  "identity_anchor",
  "tracking_grain_reconciliation",
];

const PRECONDITION_KEYS: Record<TrackedSellingPrecondition, MessageKey> = {
  sale_effects_active: "trackedSelling.precondition.sale_effects_active",
  status_moves_available: "trackedSelling.precondition.status_moves_available",
  erp_tracking_import: "trackedSelling.precondition.erp_tracking_import",
  erp_batch_posting_verified: "trackedSelling.precondition.erp_batch_posting_verified",
  identity_anchor: "trackedSelling.precondition.identity_anchor",
  tracking_grain_reconciliation: "trackedSelling.precondition.tracking_grain_reconciliation",
};

/** A precondition's plain-words label; a code outside the contract has none. */
export function preconditionKey(code: string): MessageKey | undefined {
  return Object.hasOwn(PRECONDITION_KEYS, code)
    ? PRECONDITION_KEYS[code as TrackedSellingPrecondition]
    : undefined;
}

// --- Write --------------------------------------------------------------------------

export const PRECONDITIONS_UNMET = "tracked_selling_preconditions_unmet";

/**
 * What a switch command came back as. `unmet` is the 409 (nothing written; the
 * read is refreshed so the list names what is missing). `unavailable` is the
 * gate's 404. `failed` has no answer: whether the switch changed is unknown,
 * and repeating it is safe because setting the current value again is a no-op.
 */
export type SwitchOutcome =
  | { kind: "saved"; setting: TrackedSellingSetting }
  | { kind: "unmet"; requestId?: string }
  | { kind: "unavailable" }
  | { kind: "sessionExpired" }
  | { kind: "forbidden"; requestId?: string }
  | { kind: "rateLimited"; retryAfter?: number }
  | { kind: "rejected"; status: number; code?: string; requestId?: string }
  | { kind: "failed" };

export function classifyWrite(res: {
  status: number;
  data?: unknown;
  error?: unknown;
  retryAfter?: number;
}): SwitchOutcome {
  const requestId = requestIdOf(res.error);
  if (res.status === 200 && isSetting(res.data)) return { kind: "saved", setting: res.data };
  if (res.status === 409 && errorCodeOf(res.error) === PRECONDITIONS_UNMET) {
    return { kind: "unmet", requestId };
  }
  if (res.status === 404) return { kind: "unavailable" };
  if (res.status === 401) return { kind: "sessionExpired" };
  if (res.status === 403) return { kind: "forbidden", requestId };
  if (res.status === 429) return { kind: "rateLimited", retryAfter: res.retryAfter };
  if (res.status >= 400 && res.status < 500) {
    return { kind: "rejected", status: res.status, code: errorCodeOf(res.error), requestId };
  }
  // A 5xx, or a 200 without the contract's shape: the outcome is not known.
  return { kind: "failed" };
}
