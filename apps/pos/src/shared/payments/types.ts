/**
 * T072 — 006 Slice 3b shared payment types.
 *
 * Closed enums + canonical unions consumed by both the main process and
 * the renderer through `src/shared/bridge-api.ts`. The values mirror
 * `specs/006-payments-tender/data-model.md` + `contracts/bridge-api.md`
 * and are the single source of truth for the Slice-3 surface.
 *
 * Constitution §VII (no leakage): only display-safe / structural values
 * appear here. Voucher tokens, intent tokens, PINs, Clerk JWTs, and
 * device tokens are never typed in this module.
 *
 * **Closed-set discipline.** Each exported `as const` tuple drives a
 * derived union; tests assert exhaustive membership at runtime. Adding
 * a value requires updating both the tuple here and every consumer's
 * exhaustive-switch table.
 */

// ── PaymentAttempt FSM states (5) ────────────────────────────────────────────

export const PAYMENT_ATTEMPT_STATES = [
  'started',
  'settled',
  'cancelled',
  'failed',
  'force_failed',
] as const;
export type PaymentAttemptState = (typeof PAYMENT_ATTEMPT_STATES)[number];

// ── TenderLine FSM states (5) ────────────────────────────────────────────────

export const TENDER_LINE_STATES = [
  'applying',
  'applied',
  'refused',
  'reversed',
  'reversal_pending',
] as const;
export type TenderLineState = (typeof TENDER_LINE_STATES)[number];

// ── TenderType (3) ───────────────────────────────────────────────────────────

export const TENDER_TYPES = ['cash', 'external_card_terminal', 'internal_voucher'] as const;
export type TenderType = (typeof TENDER_TYPES)[number];

// ── FailureReason (14) — FR-006 closed enum ──────────────────────────────────

export const FAILURE_REASONS = [
  'cart_lost',
  'operator_session_terminated',
  'dependency_unavailable',
  'internal_error',
  'stale_handoff',
  'tender_underpaid',
  'non_cash_overpayment_refused',
  'voucher_not_found',
  'voucher_expired',
  'voucher_cancelled',
  'voucher_already_redeemed',
  'voucher_tenant_mismatch',
  'voucher_branch_mismatch',
  'split_tender_rollback',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

// ── RefusalReason — closed union for bridge-side `{ kind: 'refused', reason }` ─

export const REFUSAL_REASONS = [
  // Session / role / ownership (mirrors 004 / 005 patterns).
  'no_session',
  'role_denied',
  'wrong_owner',
  'tenant_isolation',
  // Envelope / cart linkage.
  'cart_lost',
  'stale_handoff',
  // Attempt-level invariants.
  'attempt_already_started_on_terminal',
  'attempt_terminal',
  'tender_underpaid',
  // RT-339: a cash apply on an attempt with nothing left to pay.
  'attempt_fully_tendered',
  // RT-437 (D-F2): a cash amount above max(cash cap, remaining) — `cash-bound.ts`.
  'cash_amount_out_of_range',
  // RT-441 (RT-116 §5.2): force-fail refused — the attempt holds live tender;
  // manager recovery reverses or completes it instead.
  'recovery_required',
  // RT-614 (RT-28 step 3b): the persisted envelope holds a manual-discount
  // placeholder no manager authorised — `cart-payment-eligibility.ts`.
  'unauthorized_discount',
  'internal_error',
  // Idempotency (R-10).
  'idempotency_payload_mismatch',
  // Per-line refusals.
  'invalid_input',
  'non_cash_overpayment_refused',
  'tender_not_yet_supported',
  // RT-700 (P-26-1): a card tender while `POS_PULSE_FEATURE_CARD_TENDER` is off.
  'card_tender_disabled',
  // RT-998 (RT-276 c14719): cash while the shift cash-up is on and the terminal
  // has no open shift — `cash-shift-gate.ts`. Nothing is recorded or settled.
  'shift_not_open',
  'line_not_applied',
  'dependency_unavailable',
  // Voucher refusals — typed Slice-3 for forward use; Slice-4 wires the validate / redeem paths.
  'voucher_not_found',
  'voucher_expired',
  'voucher_cancelled',
  'voucher_already_redeemed',
  'voucher_tenant_mismatch',
  'voucher_branch_mismatch',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

// ── Refusal envelope (mirrors 005 cart-refusal shape per AD-3 / R-2) ─────────

export interface PaymentRefusal {
  readonly kind: 'refused';
  readonly reason: RefusalReason;
}

// ── Audit-event categories introduced by 006 (4 attempt-level + 4 per-line) ──

export const PAYMENT_AUDIT_CATEGORIES = [
  'payment.settled',
  'payment.cancelled',
  'payment.failed',
  'payment.force_failed',
  'tender.applied',
  'tender.refused',
  'tender.reversed',
  // Slice 4 only — typed here for the audit-emitter; emission is gated.
  'tender.reversal_pending',
  // RT-442 (RT-116 S5, §3.1 / §3.3) — an attempt holding live tender outlives
  // its session as the terminal's stuck attempt, and re-attaches for its owner.
  'payment.held_on_session_end',
  'payment.reattached',
] as const;
export type PaymentAuditCategory = (typeof PAYMENT_AUDIT_CATEGORIES)[number];

// ── Renderer-minimised projections (FR-017) ──────────────────────────────────

/**
 * Per-line view sent to the renderer through `payments.subscribe` /
 * `payments.read` / `tender.read`. **No voucher_redemption_intent_token**;
 * voucher_authority_redemption_id is the only voucher-side string that
 * crosses (opaque, FR-017).
 */
export interface TenderLineRendererView {
  readonly tender_line_id: string;
  readonly tender_type: TenderType;
  readonly amount_applied_minor: number;
  readonly change_due_minor?: number;
  readonly external_reference?: string;
  readonly voucher_authority_redemption_id?: string;
  readonly state: TenderLineState;
  readonly applied_at?: string;
  readonly refused_at?: string;
  readonly reversed_at?: string;
  readonly reversal_pending_since?: string;
  readonly refusal_reason?: RefusalReason;
  readonly apply_order: number;
}

/**
 * Attempt-level renderer view. Holds the immutable envelope subtotal +
 * the per-line array. Voucher tokens never appear here (FR-017).
 */
export interface PaymentAttemptRendererView {
  readonly payment_attempt_id: string;
  readonly state: PaymentAttemptState;
  readonly envelope_subtotal_minor: number;
  readonly started_at: string;
  readonly settled_at?: string;
  readonly cancelled_at?: string;
  readonly failed_at?: string;
  readonly force_failed_at?: string;
  readonly tender_lines: readonly TenderLineRendererView[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 006-payments-tender Slice 3 — payments.* + tender.* bridge types (T071)
// ─────────────────────────────────────────────────────────────────────────────
//
// Mirrors specs/006-payments-tender/contracts/bridge-api.md (DRAFT — §A4-A
// cleared 2026-05-21). Slice-3 subset only: no `vouchers.*` (added later,
// additively). `payments.forceFail` is never on this bridge (RT-1232).

// ── payments.start ───────────────────────────────────────────────────────────

export interface PaymentsStartRequest {
  /** From 005's `cart.handoff` return value. */
  envelope_handoff_action_id: string;
  envelope_cart_id: string;
  envelope_subtotal_minor: number;
  envelope_version: 'v1';
  /** Client-generated UUID v4 (R-10). */
  idempotency_key: string;
}

export type PaymentsStartResponse = { kind: 'ok'; payment_attempt_id: string } | PaymentRefusal;

// ── payments.confirm ─────────────────────────────────────────────────────────

export interface PaymentsConfirmRequest {
  payment_attempt_id: string;
  idempotency_key: string;
}

export type PaymentsConfirmResponse = { kind: 'ok'; settled_at: string } | PaymentRefusal;

// ── payments.cancel ──────────────────────────────────────────────────────────

export interface PaymentsCancelRequest {
  payment_attempt_id: string;
  idempotency_key: string;
}

export type PaymentsCancelResponse =
  | {
      kind: 'ok';
      cancelled_at: string;
      /** TenderLines successfully reversed (LIFO per FR-006B). */
      reversed_tender_line_ids: readonly string[];
      /** TenderLines awaiting deferred reversal (Slice 4 voucher path). */
      reversal_pending_tender_line_ids: readonly string[];
    }
  | PaymentRefusal;

// ── payments.forceFail (main-side only — NOT on the renderer bridge) ─────────
//
// RT-1232: these types are used by the main-process handler
// (`src/main/payments/handlers/payments-force-fail.ts`). There is no preload
// method and no IPC channel; `PaymentsBridgeAPI` has no `forceFail` key.
//
// Manager / admin incident-response action that transitions a stuck
// `started` attempt to `force_failed` (FR-021 / plan AD-5). The audit
// row carries dual attribution (manager actor + original cashier).
// **Manager identity NEVER appears in cashier-visible surfaces** —
// `force_fail_attribution_operator_id` is stripped from any renderer
// projection of the attempt; consumers of this response see only the
// generic timestamp.

export interface PaymentsForceFailRequest {
  payment_attempt_id: string;
  idempotency_key: string;
}

export type PaymentsForceFailResponse = { kind: 'ok'; force_failed_at: string } | PaymentRefusal;

// ── payments.read ────────────────────────────────────────────────────────────

export interface PaymentsReadRequest {
  payment_attempt_id: string;
}

export type PaymentsReadResponse =
  | { kind: 'ok'; payment_attempt: PaymentAttemptRendererView }
  | PaymentRefusal;

// ── payments.subscribe ───────────────────────────────────────────────────────

export interface PaymentsSubscribeRequest {
  payment_attempt_id: string;
}

/**
 * Subscribe-stream payload. Same projection as `payments.read` per
 * contracts/bridge-api.md §"payments.subscribe".
 */
export type PaymentsSubscribeResponse =
  | { kind: 'ok'; payment_attempt: PaymentAttemptRendererView }
  | PaymentRefusal;

// ── tender.apply ─────────────────────────────────────────────────────────────

export interface TenderApplyRequest {
  payment_attempt_id: string;
  tender_type: TenderType;
  amount_applied_minor: number;
  /** Only for `external_card_terminal` (regex `^[A-Z0-9]{0,6}$`). */
  external_reference?: string;
  /** Only for `internal_voucher` (Slice 4 path). */
  voucher_code?: string;
  /**
   * RT-1331 (decision 1A), `internal_voucher` only: the forfeited amount the cashier
   * confirmed, copied from the `forfeit_confirmation_required` answer. Main applies the
   * line only when it equals the forfeit V-A reports on this call.
   */
  voucher_forfeit_ack_minor?: number;
  idempotency_key: string;
}

/**
 * RT-1331 (decision 1A): a voucher redemption consumes the whole voucher, so a voucher
 * worth more than the amount applied forfeits the rest. Main answers this INSTEAD of
 * applying the line until the request carries a matching `voucher_forfeit_ack_minor`.
 * Nothing is persisted, audited or logged for it. The amount is the one owner-approved
 * exception to the voucher value staying off the wire (V-A contract, RT-1098 c16402).
 */
interface VoucherForfeitConfirmationRequired {
  kind: 'forfeit_confirmation_required';
  forfeited_amount_minor: number;
}

export type TenderApplyResponse =
  | {
      kind: 'ok';
      tender_line_id: string;
      applied_at: string;
      /** Cash overpayment only. */
      change_due_minor?: number;
    }
  | VoucherForfeitConfirmationRequired
  | PaymentRefusal;

// ── tender.reverse ───────────────────────────────────────────────────────────

export interface TenderReverseRequest {
  tender_line_id: string;
  idempotency_key: string;
}

export type TenderReverseResponse =
  | {
      kind: 'ok';
      reversed_at: string;
      /** `reversed` for cash + external_card_terminal in Slice 3. */
      state: 'reversed' | 'reversal_pending';
    }
  | PaymentRefusal;

// ── tender.read ──────────────────────────────────────────────────────────────

export interface TenderReadRequest {
  tender_line_id: string;
}

export type TenderReadResponse =
  | { kind: 'ok'; tender_line: TenderLineRendererView }
  | PaymentRefusal;

// ── vouchers.validate (Slice 4 / Wave 4) ─────────────────────────────────────
//
// Bridge surface for the voucher-authority-client (V-A) `posValidateVoucher`
// operation. The bridge persists a `payment_tender_lines` row with
// `state='applied'` + `voucher_redemption_intent_token` on success
// (data-model §"PaymentTenderLine" Invariant 4). On any V-A refusal the
// row is persisted with `state='refused'` + `refusal_reason`. The
// `voucher_redemption_intent_token` is **main-side only** and MUST NOT
// appear in the response (FR-017 / F-A4B brief §3.4).
//
// `applied_amount_minor` is the cashier-supplied amount; V-A caps refuse
// rather than truncate (research §R-7). `remaining_balance_minor` is
// computed main-side from `payment_attempts.envelope_subtotal_minor` and
// the current line breakdown — the renderer does NOT compute or send it.

export interface VouchersValidateRequest {
  payment_attempt_id: string;
  voucher_code: string;
  amount_applied_minor: number;
  /** RT-1331: the confirmed forfeit; see `TenderApplyRequest.voucher_forfeit_ack_minor`. */
  voucher_forfeit_ack_minor?: number;
  idempotency_key: string;
}

export type VouchersValidateResponse =
  | {
      kind: 'ok';
      tender_line_id: string;
      applied_amount_minor: number;
      applied_at: string;
    }
  | VoucherForfeitConfirmationRequired
  | PaymentRefusal;

// ── Namespace surfaces ───────────────────────────────────────────────────────

export interface PaymentsBridgeAPI {
  /** Starts a new payment attempt against a frozen `PaymentIntentEnvelope v1`. */
  start(req: PaymentsStartRequest): Promise<PaymentsStartResponse>;
  /** Evaluates the settlement invariant + transitions to `settled`. */
  confirm(req: PaymentsConfirmRequest): Promise<PaymentsConfirmResponse>;
  /** Reverses applied TenderLines LIFO + transitions to `cancelled`. */
  cancel(req: PaymentsCancelRequest): Promise<PaymentsCancelResponse>;
  /** Push-stream subscription to attempt-level + per-line state. */
  subscribe(req: PaymentsSubscribeRequest): Promise<PaymentsSubscribeResponse>;
  /** One-shot read of the same renderer projection as `subscribe`. */
  read(req: PaymentsReadRequest): Promise<PaymentsReadResponse>;
}

export interface TenderBridgeAPI {
  /** Applies a tender line to a `started` payment attempt. */
  apply(req: TenderApplyRequest): Promise<TenderApplyResponse>;
  /** Reverses an `applied` tender line (idempotent via `idempotency_key`). */
  reverse(req: TenderReverseRequest): Promise<TenderReverseResponse>;
  /** One-shot read of a single line — same projection as `payments.subscribe`. */
  read(req: TenderReadRequest): Promise<TenderReadResponse>;
}

/**
 * 006 Wave 4 — voucher bridge namespace (Contract V-A). Only `validate`
 * is renderer-facing; `redeem` is invoked inside `payments.confirm` and
 * `reverse` inside `tender.reverse`. Both server-side flows are
 * intentionally absent from this surface so the renderer cannot
 * unilaterally redeem or reverse a voucher (FR-017 + AD-3).
 */
export interface VouchersBridgeAPI {
  /** Validates a voucher code with V-A and persists the resulting line. */
  validate(req: VouchersValidateRequest): Promise<VouchersValidateResponse>;
}
