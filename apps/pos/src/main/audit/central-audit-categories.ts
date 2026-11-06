/**
 * RT-1231 (RT-160 D-2) — the audit categories this terminal uploads to
 * Backend-Core `POST /api/pos/v1/audit-events`.
 *
 * Only the privileged, security and exception actions reach central audit
 * (RT-1230 comments 15798 and 15800, contract `pos-audit-events` 1.3.0-draft).
 * Every other category stays POS-local: the sender marks it local-only and
 * never sends it. That includes routine `shift.open` / `shift.close`, which
 * the contract still accepts but D-2 keeps local, and ordinary sale, payment,
 * lock and unlock facts.
 *
 * Every value here must be in the vendored contract's `action_category` enum
 * (checked by `central-audit-categories.test.ts`). A category the contract does
 * not accept is never added here: it would only be refused with
 * `schema_violation`. `drawer.no_sale` is added with the feature (decision 3).
 */
import type { ActionCategory } from '../../shared/audit/event-shape.js';
import type { PaymentAuditCategory } from '../../shared/payments/types.js';

/** Audit categories that may be written to `audit_events` on this terminal. */
export type LocalAuditCategory = ActionCategory | PaymentAuditCategory;

export const CENTRAL_AUDIT_CATEGORIES = [
  // Already accepted before RT-1230 (unchanged).
  'operator.session.takeover',
  'cashier.pin.reset',
  'cashier.pin.unlock',
  'shift.forced_close',
  // RT-740: every manual discount is manager-authorized (a privileged override).
  'cart.discount.manager_authorized',
  // RT-1230 decision 1: manager approval and manager recovery.
  'manager_approval.granted',
  'manager_approval.refused',
  'payment.recovery_completed',
  'payment.recovery_cancelled',
  'cart.held_cancelled_by_manager',
  'cart.cancel.post_handoff',
  // RT-1230 decision 2: the money-affecting overrides.
  'sale.receipt.manual_override',
  'sale.void.requested',
  'tender.reversed',
  'tender.reversal_pending',
  // RT-1230: new to Backend-Core.
  'payment.force_failed',
] as const satisfies readonly LocalAuditCategory[];

export type CentralAuditCategory = (typeof CENTRAL_AUDIT_CATEGORIES)[number];

const CENTRAL = new Set<string>(CENTRAL_AUDIT_CATEGORIES);

/** True when the category goes to Backend-Core central audit (RT-160 D-2). */
export function isCentralAuditCategory(category: string): category is CentralAuditCategory {
  return CENTRAL.has(category);
}
