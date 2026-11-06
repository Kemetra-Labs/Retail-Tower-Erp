/**
 * RT-1230 (RT-160 D-2; owner decisions on Jira RT-1230 comments 15798 and
 * 15800): payload rules for the privileged, security and exception POS audit
 * categories that reach central audit. Contract:
 * `pos-audit-events.openapi.yaml` 1.3.0-draft.
 *
 * Each shape is the one the POS writes today (`apps/pos`), derived from where
 * the POS builds the payload:
 *   - manager approval: `operator/manager-approval-service.ts` `request`
 *   - manager recovery: `recovery/manager-recovery.ts`
 *   - post-handoff cancel: `cart/cart-bridge.ts` (`cart.cancel.post_handoff`)
 *   - receipt override: `receipts/receipts-bridge.ts` `manualOverride`
 *   - sale void: `sale-void/sale-void-audit.ts` `requested`
 *   - force-fail: `payments/handlers/payments-force-fail.ts`
 *   - tender reversal: `payments/audit-emitter.ts`
 *
 * Every key set is closed (`.strict()`): an unknown key is refused, so no free
 * text (a note, a name, a label) can ride along. Ids use the POS bridge id
 * alphabet, codes are machine codes, money is integer minor units and times
 * are ISO 8601. A payload that breaks its rule is a `schema_violation`.
 */
import { z } from "zod";

/** The POS bridge id alphabet (as in `discount-audit-payload.ts`): no spaces, ASCII only. */
const Id = z.string().regex(/^[A-Za-z0-9_:.-]{1,128}$/);
/** A manager action kind, e.g. `recovery.cancel_attempt` (POS `MANAGER_ACTION_KINDS`). */
const ActionKind = z.string().regex(/^[a-z][a-z0-9_]{0,39}(\.[a-z][a-z0-9_]{0,39}){0,3}$/);
/** The approval reason code (POS `APPROVAL_REASON_CODE_PATTERN`); never the free-text note. */
const ReasonCode = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const Timestamp = z.string().datetime({ offset: true });
const MinorUnits = z.number().int().nonnegative().refine(Number.isSafeInteger);
/**
 * True when `value` (already `YYYY-MM-DD`) is a date that exists. An
 * out-of-range month or day (`2026-13-01`, `2026-01-00`) is an Invalid Date,
 * whose `toISOString()` throws, so it is checked first: a refinement that
 * throws would turn a `schema_violation` into an `invalid_input`.
 */
function isExistingCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** A calendar date `YYYY-MM-DD` that exists (the void's store business day). */
const CalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isExistingCalendarDate);
const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);
/** The RT-114 approval policy version (POS `APPROVAL_POLICY_VERSION`, e.g. `rt114-2026-10-07`). */
const PolicyVersion = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
const TenderType = z.enum(["cash", "external_card_terminal", "internal_voucher"]);

const managerApprovalRefused = z.object({ action_kind: ActionKind, subject_ref: Id }).strict();
const recoveryCompleted = z
  .object({ payment_attempt_id: Id, cart_id: Id, approval_id: Id })
  .strict();
const tenderReversalPending = z
  .object({
    tender_line_id: Id,
    payment_attempt_id: Id,
    tender_type: TenderType,
    reversal_pending_since: Timestamp,
    attribution_operator_id: Id,
  })
  .strict();

/** The RT-1230 categories and their payload rules, in contract order. */
const PRIVILEGED_PAYLOAD_SCHEMAS = new Map<string, z.ZodTypeAny>([
  [
    "manager_approval.granted",
    managerApprovalRefused.extend({ approval_id: Id, reason_code: ReasonCode }).strict(),
  ],
  ["manager_approval.refused", managerApprovalRefused],
  ["payment.recovery_completed", recoveryCompleted],
  [
    "payment.recovery_cancelled",
    recoveryCompleted
      .extend({ cash_returned_confirmed: z.boolean(), card_void_confirmed_on_terminal: z.boolean() })
      .strict(),
  ],
  [
    "cart.held_cancelled_by_manager",
    z
      .object({ cart_id: Id, approval_id: Id, kind: z.enum(["draft", "handed_off"]), parked: z.boolean() })
      .strict(),
  ],
  [
    "cart.cancel.post_handoff",
    z.object({ cart_id: Id, handoff_action_id: Id, approval_id: Id.optional() }).strict(),
  ],
  ["sale.receipt.manual_override", z.object({ sale_id: Id, print_event_id: Id }).strict()],
  [
    "sale.void.requested",
    z
      .object({
        void_id: Id,
        sale_id: Id,
        amount_minor: MinorUnits,
        currency_code: CurrencyCode,
        business_date: CalendarDate,
        approval_id: Id,
        policy_version: PolicyVersion,
        approved_at: Timestamp,
        requester_user_id: Id,
      })
      .strict(),
  ],
  [
    "payment.force_failed",
    z
      .object({
        force_failed_at: Timestamp,
        force_fail_attribution_operator_id: Id,
        original_cashier_operator_id: Id,
      })
      .strict(),
  ],
  [
    "tender.reversed",
    tenderReversalPending
      .omit({ reversal_pending_since: true })
      .extend({
        reversed_at: Timestamp,
        manual_void_required: z.boolean(),
        reversal_pending_since: Timestamp.optional(),
      })
      .strict(),
  ],
  ["tender.reversal_pending", tenderReversalPending],
]);

/** The RT-1230 categories (the keys of `PRIVILEGED_PAYLOAD_SCHEMAS`). */
export const PRIVILEGED_AUDIT_CATEGORIES = [...PRIVILEGED_PAYLOAD_SCHEMAS.keys()];

/**
 * True when `category` is not an RT-1230 category (no rule here), or when
 * `payload` satisfies its rule.
 */
export function isPrivilegedPayloadValid(category: string, payload: Record<string, unknown>): boolean {
  const schema = PRIVILEGED_PAYLOAD_SCHEMAS.get(category);
  return schema === undefined || schema.safeParse(payload).success;
}
