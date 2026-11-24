/**
 * RT-114 §3 — the closed catalogue of manager-approved action kinds. It grows
 * by contract only. MA-1 (RT-438) keys the credential policy on it; MA-2
 * (RT-443) binds each approval to one kind.
 *
 * `shift.variance_accept` is the RT-17 shift variance, the first consumer of
 * the manager PIN; it keeps its RT-17 behaviour (manager-approval-policy.ts).
 * `drawer.no_sale` and `price.override` are reserved by RT-114 and not listed
 * until their contracts exist.
 */
export const MANAGER_ACTION_KINDS = [
  'cart.cancel_post_handoff',
  // RT-530 — voiding a finalized sale: a bound approval, four-eyes against the
  // requester AND the sale's selling operator, same business day only.
  'sale.void',
  // RT-1403 S2 — cash that left the drawer outside the void payout gate: bound to the void and its
  // cash, single use, approved by a manager other than the requester (the void's four-eyes rule).
  'sale.void_cash_exception',
  // RT-1498 S4/S5 — resolving a permanently-unknown return (close it as "not recorded", or hand it
  // to support): ONE kind with the chosen disposition bound into the approval's subject
  // (`<returnId>_close` / `<returnId>_escalate`), so an approval for one is not valid for the other
  // (owner decision RT-1498 c18144 item 1). Four-eyes: another manager than the requester; single use.
  'return.resolve_unknown',
  'cart.discount.manual',
  'shift.pay_in',
  'shift.pay_out',
  'shift.variance_accept',
  'cashier.pin.unlock_lockout',
  'recovery.unlock_other',
  'recovery.complete_attempt',
  'recovery.cancel_attempt',
  'recovery.cancel_held_cart',
  // RT-1563 — a manager cancels many PARKED drafts with one approval. The subject is a batch snapshot
  // main took (`recovery.prepareCancelHeldCarts`): its digest binds the carts and their versions, so
  // the renderer cannot change which carts the PIN covers.
  'recovery.cancel_held_carts',
  'session.self_unlock',
] as const;

export type ManagerActionKind = (typeof MANAGER_ACTION_KINDS)[number];

export function isManagerActionKind(value: unknown): value is ManagerActionKind {
  return typeof value === 'string' && (MANAGER_ACTION_KINDS as readonly string[]).includes(value);
}
