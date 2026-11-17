/**
 * RT-1440 (U1): the client-side gates of the close-without-a-count action. Pure, no React.
 *
 * These only decide whether the control is SHOWN (D1: owner and `tenant_admin`; never inside a
 * support session). "With all-store access" is not a fact the context exposes, so a
 * `tenant_admin` restricted to some stores sees the control and the server answers the uniform
 * 404 (shown as "not available for your access"). The Console never grants more than the server
 * contract and never judges a shift itself: the verdict, the blockers and the effects are the
 * server's.
 */
import type { MessageKey } from "@/i18n";

/** The contract's `forcedReason` bound (1 to 200 characters). */
export const REASON_MAX = 200;

const ALLOWED_ROLES: ReadonlySet<string> = new Set(["owner", "tenant_admin"]);

export function canForceClose(roleCode: string | null | undefined, inSupportSession: boolean): boolean {
  return !inSupportSession && typeof roleCode === "string" && ALLOWED_ROLES.has(roleCode);
}

export function reasonProblem(raw: string): MessageKey | null {
  const reason = raw.trim();
  if (reason.length === 0) return "forceActions.close.reason.required";
  return reason.length > REASON_MAX ? "forceActions.close.reason.tooLong" : null;
}

export interface CommitState {
  /** The server's verdict for this shift, from the latest preview. */
  eligible: boolean;
  reason: string;
  acknowledged: boolean;
  pending: boolean;
  /** The preview is being read again (a reconnect, or after a stale answer): wait for it. */
  fetching: boolean;
}

/** The commit button is enabled only when every input the server's contract needs is present. */
export function commitReady({ eligible, reason, acknowledged, pending, fetching }: CommitState): boolean {
  return eligible && acknowledged && !pending && !fetching && reasonProblem(reason) === null;
}

/** Effect codes the contract names (`ForceClosePreview.effects`), one catalog key each. */
const WILL_CHANGE: Readonly<Record<string, MessageKey>> = {
  shift_closed_not_counted: "forceActions.close.effect.willChange.shift_closed_not_counted",
  no_cash_up_recorded: "forceActions.close.effect.willChange.no_cash_up_recorded",
  terminal_may_open_new_shift: "forceActions.close.effect.willChange.terminal_may_open_new_shift",
  device_retire_replace_move_unblocked:
    "forceActions.close.effect.willChange.device_retire_replace_move_unblocked",
  timezone_change_unblocked: "forceActions.close.effect.willChange.timezone_change_unblocked",
};

const WILL_NOT_CHANGE: Readonly<Record<string, MessageKey>> = {
  sales_unchanged: "forceActions.close.effect.willNotChange.sales_unchanged",
  refunds_unchanged: "forceActions.close.effect.willNotChange.refunds_unchanged",
  cash_movements_unchanged: "forceActions.close.effect.willNotChange.cash_movements_unchanged",
  stock_unchanged: "forceActions.close.effect.willNotChange.stock_unchanged",
  erp_documents_unchanged: "forceActions.close.effect.willNotChange.erp_documents_unchanged",
};

/** The server's effect list as catalog keys, in its order. A code this build does not know is dropped, never shown raw. */
export function effectKeys(list: "willChange" | "willNotChange", codes: readonly string[]): MessageKey[] {
  const table = list === "willChange" ? WILL_CHANGE : WILL_NOT_CHANGE;
  return codes.filter((c) => Object.hasOwn(table, c)).map((c) => table[c]);
}

/** True when the server lists an effect code this build has no copy for: the dialog says so instead of hiding it. */
export function hasUnknownEffect(list: "willChange" | "willNotChange", codes: readonly string[]): boolean {
  const table = list === "willChange" ? WILL_CHANGE : WILL_NOT_CHANGE;
  return codes.some((c) => !Object.hasOwn(table, c));
}
