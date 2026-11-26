import type { CartRefusal } from './refusal.js';
import type { PaymentIntentEnvelope } from './handoff-envelope.js';
import type { CartState } from './cart-state.js';
import type { PromotionPreview } from '../offers/types.js';
import type { CartParkBridgeAPI } from './park-types.js';

// ── cart.create ───────────────────────────────────────────────────────────────

export interface CartCreateRequest {
  readonly idempotency_key: string;
}

export type CartCreateResponse = { readonly kind: 'ok'; readonly cart_id: string } | CartRefusal;

// ── cart.lines.add ────────────────────────────────────────────────────────────

export interface CartLinesAddRequest {
  readonly cart_id: string;
  readonly item_ref: string;
  readonly quantity: number;
  readonly idempotency_key: string;
}

export type CartLinesAddResponse =
  | {
      readonly kind: 'ok';
      readonly line_id: string;
      readonly merged: boolean;
      readonly version: number;
      /** Resolved display name snapshot (T052 — renderer line list). */
      readonly display_name: string;
      /** Unit price in integer minor units (T052). */
      readonly unit_price_minor: number;
      /** Line subtotal in integer minor units (T052). */
      readonly line_subtotal_minor: number;
      /** Bridge-confirmed quantity after add/merge. */
      readonly quantity: number;
    }
  | CartRefusal;

// ── cart.lines.update ─────────────────────────────────────────────────────────

export interface CartLinesUpdateRequest {
  readonly cart_id: string;
  readonly line_id: string;
  readonly op: 'increment' | 'decrement' | 'set';
  readonly delta?: number;
  readonly absolute?: number;
  readonly version: number;
  readonly idempotency_key: string;
}

export type CartLinesUpdateResponse =
  | { readonly kind: 'ok'; readonly version: number }
  | CartRefusal;

// ── cart.lines.remove ─────────────────────────────────────────────────────────

export interface CartLinesRemoveRequest {
  readonly cart_id: string;
  readonly line_id: string;
  readonly version: number;
  readonly idempotency_key: string;
}

export type CartLinesRemoveResponse = { readonly kind: 'ok' } | CartRefusal;

// ── cart.lines.setNote ────────────────────────────────────────────────────────

export interface CartLinesSetNoteRequest {
  readonly cart_id: string;
  readonly line_id: string;
  readonly note: string | null;
  readonly version: number;
  readonly idempotency_key: string;
}

export type CartLinesSetNoteResponse =
  | { readonly kind: 'ok'; readonly version: number }
  | CartRefusal;

// ── cart.discountPlaceholders.add ─────────────────────────────────────────────
//
// RT-608 (RT-28, spec 005 FR-023 revised): every manual discount needs manager
// authority, with no threshold. No approver and no credential cross this
// bridge (C10; contracts/bridge-api.md): a manager / admin session applies
// directly and is the approver; a cashier carries an `approval_id` that main
// issued for kind `cart.discount.manual` on
// `discountApprovalSubjectRef({ cart_id, line_id, placeholder_kind })`
// (`shared/cart/discount-approval.ts`). Any renderer-supplied
// `attribution_operator_id` is dropped.

export interface CartDiscountPlaceholdersAddRequest {
  readonly cart_id: string;
  readonly line_id: string;
  readonly placeholder_kind: string;
  readonly idempotency_key: string;
  /**
   * RT-608 — a cashier's add carries the manager approval granted for exactly
   * this cart, line and kind; a manager or admin applies directly and sends none.
   */
  readonly approval_id?: string;
  /**
   * RT-854 (doc 28 §4) — a code from the closed list
   * (`MANUAL_DISCOUNT_REASON_CODES`). Required on the manager / admin direct
   * path; a cashier's add may restate its approval's reason, and must match it.
   */
  readonly reason_code?: string;
}

export type CartDiscountPlaceholdersAddResponse =
  | {
      readonly kind: 'ok';
      readonly placeholder_id: string;
      readonly requires_manager_attribution: boolean;
    }
  | CartRefusal;

// ── cart.discountPlaceholders.remove ──────────────────────────────────────────

export interface CartDiscountPlaceholdersRemoveRequest {
  readonly cart_id: string;
  readonly placeholder_id: string;
  readonly idempotency_key: string;
}

export type CartDiscountPlaceholdersRemoveResponse = { readonly kind: 'ok' } | CartRefusal;

// ── cart.void ─────────────────────────────────────────────────────────────────
//
// Pre-handoff void only (a frozen cart is refused; post-handoff is
// `cancelPostHandoff`). No attribution crosses this bridge (RT-184): main
// records the session operator as the acting operator and no approver.

export interface CartVoidRequest {
  readonly cart_id: string;
  readonly idempotency_key: string;
}

export type CartVoidResponse = { readonly kind: 'ok' } | CartRefusal;

// ── cart.cancelPostHandoff ────────────────────────────────────────────────────
//
// Cancels a cart already in `frozen_handed_off` (spec 005 FR-033). Main is
// the authority: it gates the role (manager/admin act directly; a cashier is
// refused `manager_attribution_required`), refuses while a payment for the
// cart is started or settled, and emits the `cart.cancel.post_handoff` audit
// event atomically with the cancellation. The renderer supplies only the cart,
// the frozen envelope's `handoff_action_id`, and a fresh idempotency key — no
// attribution crosses this bridge.

export interface CartCancelPostHandoffRequest {
  readonly cart_id: string;
  readonly handoff_action_id: string;
  readonly idempotency_key: string;
  /**
   * RT-443 (MA-2) — a cashier's cancel carries the manager approval granted
   * for it (`approval.request`, kind `cart.cancel_post_handoff`); a manager or
   * admin cancels directly and sends none.
   */
  readonly approval_id?: string;
}

export type CartCancelPostHandoffResponse = { readonly kind: 'ok' } | CartRefusal;

// ── cart.returnToSale (RT-26) ─────────────────────────────────────────────────
// Checkout Back/Esc. Main returns the SAME `frozen_handed_off` cart to `editing`
// only while the cart has no tender activity and no settled / force-failed
// payment; a zero-funds started attempt is cancelled in the same transaction,
// and the persisted envelope is cleared so it can never be paid. Lines, notes,
// versions and the cart id are untouched. The renderer supplies only the cart,
// the frozen envelope's `handoff_action_id` (binds the request to the exact
// handoff it is leaving) and an idempotency key — reused on retry so a lost
// response replays instead of being refused.

export interface CartReturnToSaleRequest {
  readonly cart_id: string;
  readonly handoff_action_id: string;
  readonly idempotency_key: string;
}

export type CartReturnToSaleResponse = { readonly kind: 'ok' } | CartRefusal;

// ── cart.returnToSaleEligibility (RT-26) ──────────────────────────────────────
// Read-only twin of `cart.returnToSale`: the same gates and the same payments
// proof, no writes. `returnable: false` covers a cart that is not frozen on this
// handoff as well as one with tender history / a settled or force-failed
// payment. Checkout keeps Back disabled until this says `true`.

export interface CartReturnToSaleEligibilityRequest {
  readonly cart_id: string;
  readonly handoff_action_id: string;
}

export type CartReturnToSaleEligibilityResponse =
  | { readonly kind: 'ok'; readonly returnable: boolean }
  | CartRefusal;

// ── cart.promotionPreview (RT-1339, RT-286 S7) ────────────────────────────────
// Read-only: the automatic offers the cart's live lines earn now (the Offer Pack and
// trusted time, evaluated by main). The renderer asks after every material cart change
// and shows the result; it never computes an offer or edits one.

export interface CartPromotionPreviewRequest {
  readonly cart_id: string;
}

export type CartPromotionPreviewResponse =
  | { readonly kind: 'ok'; readonly preview: PromotionPreview }
  | CartRefusal;

// ── cart.undoLast (RT-254, contract RT-245) ───────────────────────────────────
// Immediate Undo of the cart's LAST action. The renderer names only the action
// it just completed (`target_action_id` = that call's idempotency key) and a
// FRESH idempotency key for the Undo itself; main proves the target is still
// the cart's newest action and chooses the exact inverse: a new line is
// soft-removed, a merge is decremented by exactly its persisted quantity, a
// delete is restored on the same row. The renderer never picks the inverse.
// Any target that is no longer eligible refuses `undo_not_available`.

export interface CartUndoLastRequest {
  readonly cart_id: string;
  readonly target_action_id: string;
  readonly idempotency_key: string;
}

export type CartUndoEffect = 'removed' | 'decremented' | 'restored';

export type CartUndoLastResponse =
  | {
      readonly kind: 'ok';
      readonly effect: CartUndoEffect;
      readonly line_id: string;
      /** The line's version after the Undo (the next mutation must send it). */
      readonly version: number;
    }
  | CartRefusal;

// ── cart.handoff ──────────────────────────────────────────────────────────────

export interface CartHandoffRequest {
  readonly cart_id: string;
  readonly per_line_versions: ReadonlyArray<{ readonly line_id: string; readonly version: number }>;
  readonly idempotency_key: string;
}

export type CartHandoffResponse =
  | { readonly kind: 'ok'; readonly envelope: PaymentIntentEnvelope }
  | CartRefusal;

// ── cart.subscribe ────────────────────────────────────────────────────────────

export interface CartSubscribeRequest {
  readonly cart_id: string;
}

export interface CartSubscribeUpdate {
  readonly cart_id: string;
  readonly state: string;
  readonly last_action_id: string;
}

export type CartSubscribeResponse =
  | { readonly kind: 'ok'; readonly update: CartSubscribeUpdate }
  | CartRefusal;

// ── cart.snapshot ─────────────────────────────────────────────────────────────
//
// V5 active cart read. Read-only: the renderer supplies ONLY the id of a cart
// it already holds; main resolves scope/ownership from the trusted session.
// The top-level projection (lines, placeholders) carries no
// tenant/branch/terminal/operator/session identity, no catalogue item_ref, no
// attribution and no action ids. Since RT-1178 each line also carries the two
// cashier-awareness flags of its product, read from the local catalogue at
// snapshot time (display only, I-17). The `envelope` is the exception: for an
// unpaid handed-off cart it is the same envelope `cart.handoff` returned
// (lines with item_ref and action ids, the handoff action, and session scope
// ids), with manager attribution removed. See the §A4 record
// `specs/023-pos-ui-clean-room/security-review/s-cart-snapshot-review.md`.

export interface CartSnapshotRequest {
  readonly cart_id: string;
}

/** One active (non-removed) line, exactly as persisted. Money in integer minor units. */
export interface CartSnapshotLine {
  readonly line_id: string;
  readonly display_name: string;
  readonly quantity: number;
  readonly unit_price_minor: number;
  readonly line_subtotal_minor: number;
  readonly note: string | null;
  /** Persisted optimistic-concurrency version; the next mutation must send it. */
  readonly version: number;
  /**
   * RT-1178: the line's product flags from the local catalogue, read at
   * snapshot time whatever the product's `active` state. False when the
   * product is not in the local catalogue. Display only (I-17).
   */
  readonly controlled_substance: boolean;
  readonly prescription_required: boolean;
}

/** Opaque discount placeholder reference (no magnitude, no attribution). */
export interface CartSnapshotDiscountPlaceholder {
  readonly placeholder_id: string;
  readonly line_id: string;
}

export interface CartSnapshot {
  readonly cart_id: string;
  readonly state: CartState;
  readonly lines: ReadonlyArray<CartSnapshotLine>;
  readonly discount_placeholders: ReadonlyArray<CartSnapshotDiscountPlaceholder>;
  /**
   * True when main's payments record shows this handed-off cart as settled:
   * a completed sale. It then carries no envelope and must never be offered
   * to payment again. Always false for carts that are not handed off.
   */
  readonly paid: boolean;
  /**
   * The frozen envelope for an unpaid `frozen_handed_off` cart (the same
   * object `cart.handoff` returned, manager attribution removed), so a
   * reopened handed-off sale can continue to payment. `null` in every other
   * state, and for a paid cart.
   */
  readonly envelope: PaymentIntentEnvelope | null;
}

export type CartSnapshotResponse =
  | { readonly kind: 'ok'; readonly snapshot: CartSnapshot }
  | CartRefusal;

/**
 * 005-sales-cart: typed cart.* namespace for the preload bridge.
 * Every handler is role-gated on the main-process side (AD-1).
 * Phase 2 stubs return refused/not_implemented.
 */
export interface CartBridgeAPI {
  /** Creates a new draft cart bound to the current operator session. */
  create(req: CartCreateRequest): Promise<CartCreateResponse>;
  lines: {
    /** Adds a line item; merges if same item_ref exists (Q4). */
    add(req: CartLinesAddRequest): Promise<CartLinesAddResponse>;
    /** Changes quantity of an existing line. */
    update(req: CartLinesUpdateRequest): Promise<CartLinesUpdateResponse>;
    /** Soft-removes a line. */
    remove(req: CartLinesRemoveRequest): Promise<CartLinesRemoveResponse>;
    /** Sets or clears the free-text note on a line. */
    setNote(req: CartLinesSetNoteRequest): Promise<CartLinesSetNoteResponse>;
  };
  discountPlaceholders: {
    /**
     * Adds a discount placeholder; may require manager attribution. The
     * approver is the authenticated session operator, never renderer-supplied.
     */
    add(req: CartDiscountPlaceholdersAddRequest): Promise<CartDiscountPlaceholdersAddResponse>;
    /** Removes a discount placeholder; mirrors attribution rule of add. */
    remove(
      req: CartDiscountPlaceholdersRemoveRequest,
    ): Promise<CartDiscountPlaceholdersRemoveResponse>;
  };
  /** Voids a pre-handoff cart. Main refuses a `frozen_handed_off` cart (`frozen`). */
  void(req: CartVoidRequest): Promise<CartVoidResponse>;
  /**
   * Cancels a `frozen_handed_off` cart: the audited, manager-authorised
   * post-handoff path. Main refuses a cashier and any cart with a started or
   * settled payment. Optional on the TYPE only (same precedent as
   * `snapshot?`): the production preload always wires it, and the sole
   * caller fails closed when it is absent — never falling back to `void`.
   */
  cancelPostHandoff?(req: CartCancelPostHandoffRequest): Promise<CartCancelPostHandoffResponse>;
  /**
   * RT-26 — Checkout Back/Esc: returns the SAME `frozen_handed_off` cart to
   * `editing`. Main refuses once any tender exists for the cart or a payment
   * settled / was force-failed; a zero-funds started attempt is cancelled and
   * the envelope invalidated in the same transaction. Optional on the TYPE
   * only (same precedent as `cancelPostHandoff?`): the production preload
   * always wires it, and the sole caller fails closed when it is absent.
   */
  returnToSale?(req: CartReturnToSaleRequest): Promise<CartReturnToSaleResponse>;
  /**
   * RT-26 — read-only: would main allow `returnToSale` for this cart and
   * handoff now (no writes)? Checkout fails closed until it answers `true`.
   * Optional on the TYPE only, like `returnToSale?`.
   */
  returnToSaleEligibility?(
    req: CartReturnToSaleEligibilityRequest,
  ): Promise<CartReturnToSaleEligibilityResponse>;
  /**
   * RT-1339 (RT-286 S7) — read-only: the automatic offers the cart earns now (main evaluates the
   * Offer Pack; the renderer only shows the result). Optional on the TYPE only, like `returnToSale?`.
   */
  promotionPreview?(req: CartPromotionPreviewRequest): Promise<CartPromotionPreviewResponse>;
  /**
   * RT-254 — Undo the cart's LAST action (RT-245 contract). The renderer
   * names only the action it just completed and a fresh idempotency key; main
   * proves eligibility and chooses the inverse (remove / decrement / restore).
   * `undo_not_available` means dismiss the affordance — never compose an
   * inverse in the renderer. Optional on the TYPE only (same precedent as
   * `returnToSale?`): the production preload always wires it.
   */
  undoLast?(req: CartUndoLastRequest): Promise<CartUndoLastResponse>;
  /** Freezes the cart and constructs the PaymentIntentEnvelope. */
  handoff(req: CartHandoffRequest): Promise<CartHandoffResponse>;
  /** Push-style cart state updates (type-only in Phase 2; S1+ runtime). */
  subscribe(req: CartSubscribeRequest): Promise<CartSubscribeResponse>;
  /**
   * V5 active cart read — read-only, session-gated, display-safe snapshot of
   * a cart the renderer already holds. Never writes; never accepts identity.
   *
   * Optional on the TYPE only, following the additive-surface precedent of
   * `payments?` / `sales?` / `receipts?`: the production preload always wires
   * it, and the sole caller treats absence as a generic read failure (never an
   * empty cart, never a replacement cart). This keeps every existing fake
   * `CartBridgeAPI` in the legacy test suites compiling unchanged.
   */
  snapshot?(req: CartSnapshotRequest): Promise<CartSnapshotResponse>;
  /**
   * RT-440 (PK-2, spec 024 §3) — Park v1: park the current sale, list the
   * operator's parked sales, preview and resume one. Main-authoritative.
   * Optional on the TYPE only (the `snapshot?` precedent): the production
   * preload always wires it; PK-3 is its first caller.
   * RT-610: `previewResume` names each changed and unavailable line with its
   * stored product name and quantity (display only; read in main, never taken
   * from the renderer, never part of `diff_token`).
   */
  parked?: CartParkBridgeAPI;
}
