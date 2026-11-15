import type { OperatorSessionRecord } from '../operator/session-manager.js';
import type {
  CartDiscountPlaceholdersAddRequest,
  CartDiscountPlaceholdersAddResponse,
  CartHandoffRequest,
  CartHandoffResponse,
  CartLinesAddRequest,
  CartLinesUpdateRequest,
  CartReturnToSaleRequest,
} from '../../shared/cart/bridge-types.js';
import { CartState } from '../../shared/cart/cart-state.js';
import type { CartRefusalReason } from '../../shared/cart/refusal.js';
import { computeLineSubtotal, LineSubtotalError } from './line-subtotal.js';
import { requireOperatorSession } from './require-operator-session.js';
import type { CartRow, CartStore, InsertOutboxInput } from './cart-store.js';
import { lineHasDiscount, resolveDiscountAdd } from './manual-discount-policy.js';
import {
  isManualDiscountReasonCode,
  lineDiscountMinor,
  parseManualDiscountToken,
  type ManualDiscountReasonCode,
} from '../../shared/cart/manual-discount.js';
import { buildPaymentIntentEnvelope } from './handoff-envelope-builder.js';
import { freezeEnvelope } from '../../shared/cart/handoff-envelope.js';
import type { PaymentIntentEnvelope } from '../../shared/cart/handoff-envelope.js';
import type { ReleaseCheckoutPayment } from '../payments/checkout-return-guard.js';
import type { ApprovalSubject } from '../operator/manager-approval-service.js';

/**
 * RT-1227 — the module-level helpers of `cart-bridge.ts`, moved here verbatim
 * (PR 1 of the split). They hold no state: refusal shapes, replay matching, the
 * outbox payload scrub, envelope parsing and the small gates the
 * `CartBridgeHandlers` methods share. Only what the handlers use is exported.
 *
 * Behaviour is pinned by tests/integration/main/cart/cart-bridge-equivalence.rt1227.test.ts
 * (byte-identical SQLite rows and outbox payloads) and the direct unit tests in
 * tests/unit/main/cart/cart-bridge-helpers.test.ts.
 */

/**
 * Forbidden-pattern check for `cart.lines.setNote` (NFR-006 / FR-021).
 *
 * Minimal S2 list — refuses notes that contain credential-like fragments.
 * The full allowlist + regex catalogue lands in T054 (pino redaction
 * extension is the load-bearing layer; this is the bridge-side gate).
 */
const FORBIDDEN_NOTE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:pin|password|passwd|secret|token|jwt|credential|authorization)\b/i,
  /\b\d{13,19}\b/, // bare card-number-shaped sequences
  /-----BEGIN/i, // PEM key headers
];

export function noteHasForbiddenPattern(note: string): boolean {
  return FORBIDDEN_NOTE_PATTERNS.some((re) => re.test(note));
}

/**
 * Strip forbidden payload-field NAMES from a payload tree before it is
 * serialised into `cart_action_outbox.payload_json`. This is the cart-
 * layer mirror of `src/main/audit/audit-emitter.ts`'s `findForbiddenKey`.
 * S2 inlines a minimal version; T054 may extend it.
 */
const FORBIDDEN_PAYLOAD_FIELD_NAMES: ReadonlySet<string> = new Set([
  'pin',
  'pin_hash',
  'password',
  'password_hash',
  'clerk_jwt',
  'clerk_session_token',
  'device_token',
  'device_token_attestation',
  'pairing_code',
  'token',
  'secret',
  'credential',
]);

export function scrubPayloadForOutbox(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (FORBIDDEN_PAYLOAD_FIELD_NAMES.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * RT-349 — does a stored `cart.line.add` / `cart.line.merge` outbox row carry
 * the same cart, item and quantity as this add request? The add row stores
 * `quantity`; the merge row stores `quantity_added`.
 */
export function isSameAddPayload(
  req: CartLinesAddRequest,
  replay: { cart_id: string; payload_json: string },
): boolean {
  if (replay.cart_id !== req.cart_id) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(replay.payload_json);
  } catch {
    return false;
  }
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as { item_ref?: unknown; quantity?: unknown; quantity_added?: unknown };
  const quantity = p.quantity ?? p.quantity_added;
  return p.item_ref === req.item_ref && quantity === req.quantity;
}

/**
 * The envelope as the renderer may see it: identical to the persisted one
 * except that manager attribution on discount placeholders is removed
 * (FR-021: manager identity never reaches the cashier UI). The persisted
 * envelope keeps it for audit and finalize.
 */
export function rendererEnvelope(envelope: PaymentIntentEnvelope): Readonly<PaymentIntentEnvelope> {
  return freezeEnvelope({
    ...envelope,
    lines: envelope.lines.map((line) => ({ ...line })),
    discount_placeholders: envelope.discount_placeholders.map((dp) => ({
      ...dp,
      attribution_operator_id: null,
    })),
  });
}

/** Parses a persisted envelope; null when absent or unreadable (never throws). */
export function parseEnvelope(json: string | null): PaymentIntentEnvelope | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const env = parsed as Partial<PaymentIntentEnvelope>;
    if (!Array.isArray(env.lines) || !Array.isArray(env.discount_placeholders)) return null;
    return parsed as PaymentIntentEnvelope;
  } catch {
    return null;
  }
}

/**
 * RT-443 (MA-2) — the post-handoff cancel's subject as an approval binds it:
 * the cart of this session's tenant and branch, still `frozen_handed_off` on
 * a readable persisted envelope; its version is that envelope's handoff and
 * its amount the cart subtotal. Null when not approvable.
 */
export function postHandoffApprovalSubject(
  cart: CartRow | undefined,
  session: Pick<OperatorSessionRecord, 'tenant_id' | 'branch_id'>,
): ApprovalSubject | null {
  if (cart === undefined) return null;
  if (cart.tenant_id !== session.tenant_id || cart.branch_id !== session.branch_id) return null;
  if ((cart.state as CartState) !== CartState.frozen_handed_off) return null;
  const envelope = parseEnvelope(cart.handoff_envelope_json);
  if (envelope === null) return null;
  return {
    version: `handoff:${envelope.handoff_action_id}`,
    amountMinor: cart.cart_subtotal_minor,
  };
}

/** RT-443 / RT-608: a cashier's approval did not hold; thrown to roll the action back. */
export class ApprovalRefused extends Error {
  readonly reason: 'approval_invalid' | 'approval_stale';

  constructor(reason: 'approval_invalid' | 'approval_stale') {
    super(reason);
    this.reason = reason;
  }
}

/** RT-608 / RT-854: who authorised a discount, and what its audit row records of it. */
export interface DiscountAuthority {
  approver: string;
  approvalId?: string;
  reasonCode: ManualDiscountReasonCode | undefined;
  /** The direct path's session role, or (RT-861) the cashier approval's; undefined when it holds none. */
  approverRole?: 'manager' | 'admin' | undefined;
}

/** RT-854: the add on a live line of the cart (`wrong_owner` otherwise), resolved. */
export function resolveOnLiveLine(
  store: CartStore,
  req: CartDiscountPlaceholdersAddRequest,
  isManager: boolean,
): ReturnType<typeof resolveDiscountAdd> {
  const line = store.getLine(req.cart_id, req.line_id);
  if (line?.removed_at !== null) return { refusal: 'wrong_owner' };
  return resolveDiscountAdd({ store, req, line, isManager });
}

/**
 * RT-854 (doc 28 §4.1 step 5): the approval's reason is from the closed list,
 * and a reason the cashier's add restates is the same one.
 */
export function approvedReasonHolds(
  approved: string | undefined,
  restated: string | undefined,
): approved is ManualDiscountReasonCode {
  if (!isManualDiscountReasonCode(approved)) return false;
  return restated === undefined || restated === approved;
}

/** RT-608: a committed discount add's outcome (also its exact replay's). */
export function discountAdded(placeholderId: string): CartDiscountPlaceholdersAddResponse {
  return { kind: 'ok', placeholder_id: placeholderId, requires_manager_attribution: true };
}

/**
 * Why a (non-replay) post-handoff cancel cannot proceed, or null. Only a
 * `frozen_handed_off` cart qualifies, and the renderer-supplied handoff action
 * must be this cart's persisted handoff, so the audit record can never be
 * mislabelled.
 */
export function postHandoffCancelRefusal(
  cart: PersistedHandoffCart,
  req: { handoff_action_id: string },
): CartRefusalReason | null {
  if ((cart.state as CartState) !== CartState.frozen_handed_off) return 'closed';
  return isPersistedHandoff(cart, req.handoff_action_id) ? null : 'stale_version';
}

/** The cart fields that identify its current handoff. */
interface PersistedHandoffCart {
  state: string;
  handoff_envelope_json: string | null;
}

/**
 * Does `handoffActionId` name the handoff of the cart's PERSISTED envelope —
 * the one payment would use? Written in the same transaction as the cart
 * freeze, so unlike the outbox's wall-clock `applied_at` it cannot be fooled
 * by a clock step between two handoffs of the same cart (RT-26 makes repeat
 * handoffs possible).
 */
function isPersistedHandoff(cart: PersistedHandoffCart, handoffActionId: string): boolean {
  return parseEnvelope(cart.handoff_envelope_json)?.handoff_action_id === handoffActionId;
}

type RecordedAction = { action_kind: string; cart_id: string; payload_json: string };
type HandoffBoundRequest = { cart_id: string; handoff_action_id: string };

/** A recorded outbox row is a replay of `actionKind` on the SAME cart and handoff. */
function isSameHandoffReplay(
  actionKind: string,
  replay: RecordedAction,
  req: HandoffBoundRequest,
): boolean {
  return (
    replay.action_kind === actionKind &&
    replay.cart_id === req.cart_id &&
    recordedHandoffAction(replay.payload_json) === req.handoff_action_id
  );
}

/** A recorded outbox row is a replay of THIS post-handoff cancel (same cart and handoff). */
export function isSameCancelReplay(replay: RecordedAction, req: HandoffBoundRequest): boolean {
  return isSameHandoffReplay('cart.cancel.post_handoff', replay, req);
}

/** The handoff action recorded in a post-handoff cancel outbox payload. */
function recordedHandoffAction(payloadJson: string): unknown {
  try {
    const payload: unknown = JSON.parse(payloadJson);
    return typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)['handoff_action_id']
      : undefined;
  } catch {
    return undefined;
  }
}

/** A recorded outbox row is a replay of THIS Back (same cart and handoff). */
export function isSameReturnReplay(replay: RecordedAction, req: HandoffBoundRequest): boolean {
  return isSameHandoffReplay('cart.return_to_sale', replay, req);
}

/**
 * Why a (non-replay) Back cannot proceed, or null. Only a `frozen_handed_off`
 * cart is in Checkout; a cancelled one is closed, and any other state means the
 * renderer's view is stale (already back, or never handed off). The request
 * must name the handoff of the cart's PERSISTED envelope — the one payment
 * would use — so an old envelope can never drive it.
 */
export function returnToSaleRefusal(
  cart: PersistedHandoffCart,
  req: { handoff_action_id: string },
): CartRefusalReason | null {
  const state = cart.state as CartState;
  if (state === CartState.cancelled) return 'closed';
  if (state !== CartState.frozen_handed_off) return 'stale_version';
  return isPersistedHandoff(cart, req.handoff_action_id) ? null : 'stale_version';
}

/**
 * RT-614 — does the cart hold a discount placeholder that no
 * `cart.discount.manager_authorized` audit row names? The same placeholder
 * set the envelope builder snapshots. RT-854 (doc 28 §3.1): a placeholder
 * whose kind is not a canonical token has no value, so it is untrusted too;
 * and on a live line its amount now must be the one the audit row approved.
 */
export function hasUntrustedDiscountPlaceholder(store: CartStore, cart: StoredCart): boolean {
  return store.getDiscountPlaceholdersForCart(cart.cart_id).some(
    (placeholder) =>
      parseManualDiscountToken(placeholder.placeholder_kind) === null ||
      !store.isDiscountPlaceholderTrusted({
        tenant_id: cart.tenant_id,
        branch_id: cart.branch_id,
        cart_id: cart.cart_id,
        line_id: placeholder.line_id,
        placeholder_id: placeholder.placeholder_id,
        ...currentAmount(store, cart.cart_id, placeholder),
      }),
  );
}

/**
 * RT-854: the amount a placeholder gives on its live line now. A removed line
 * discounts nothing, and an amount the line cannot take (`null`) fails the
 * envelope build instead, so neither is checked here.
 */
function currentAmount(
  store: CartStore,
  cartId: string,
  placeholder: { line_id: string; placeholder_kind: string },
): { amount_minor?: number } {
  const line = store.getLine(cartId, placeholder.line_id);
  if (line?.removed_at !== null) return {};
  const amount = lineDiscountMinor(line.line_subtotal_minor, placeholder.placeholder_kind);
  return amount === null ? {} : { amount_minor: amount };
}

export function refuse(reason: CartRefusalReason): { kind: 'refused'; reason: CartRefusalReason } {
  return { kind: 'refused', reason };
}

interface LockableCart {
  state: string;
  /** Undefined on a row read before migration 0050. */
  parked_at?: string | null;
}

/**
 * Why a cart that passed the ownership gate still cannot change: it is
 * handing off (T088), or parked — RT-440 (spec 024 K5): a parked cart changes
 * only through `cart.resume`.
 */
export function lockedCartRefusal(cart: LockableCart): CartRefusalReason | null {
  if ((cart.state as CartState) === CartState.handing_off) return 'frozen';
  return cart.parked_at === undefined || cart.parked_at === null ? null : 'cart_parked';
}

/** Why a (non-replay) pre-handoff void cannot proceed, or null. */
export function voidRefusal(cart: LockableCart): CartRefusalReason | null {
  const state = cart.state as CartState;
  if (state === CartState.frozen_handed_off) return 'frozen';
  if (state === CartState.cancelled) return 'closed';
  return lockedCartRefusal(cart) === 'cart_parked' ? 'cart_parked' : null;
}

export type StoredCart = NonNullable<ReturnType<CartStore['getCart']>>;

export interface CancelPostHandoffRequest {
  cart_id: string;
  handoff_action_id: string;
  idempotency_key: string;
  approval_id?: string;
}

/** Successful shared-gate payload for a mutating cart handler. */
export interface MutableCartContext {
  session: OperatorSessionRecord;
  store: CartStore;
  cart: StoredCart;
}

/** Role, tenant-isolation and ownership gate every cart handler applies (no mutability check). */
export function ownershipRefusal(
  session: OperatorSessionRecord,
  cart: StoredCart,
): CartRefusalReason | null {
  const gate = requireOperatorSession({
    session,
    allowedRoles: ['cashier', 'manager', 'admin'],
    cart: {
      operator_session_id: cart.operator_session_id,
      tenant_id: cart.tenant_id,
      branch_id: cart.branch_id,
      state: cart.state as CartState,
    },
  });
  return gate.kind === 'ok' ? null : gate.reason;
}

/** The answer to a replayed `cart.handoff` key: the persisted envelope, or a refusal. */
export function handoffReplayResponse(
  store: CartStore,
  cartId: string,
  replay: NonNullable<ReturnType<CartStore['getOutboxRow']>>,
): CartHandoffResponse {
  if (replay.action_kind !== 'cart.handoff_to_payment') {
    return refuse('idempotency_payload_mismatch');
  }
  const persistedJson = store.getCart(cartId)?.handoff_envelope_json;
  if (persistedJson !== null && persistedJson !== undefined) {
    const parsed = JSON.parse(persistedJson) as Parameters<typeof freezeEnvelope>[0];
    return { kind: 'ok', envelope: rendererEnvelope(parsed) };
  }
  /* v8 ignore next — outbox row written but envelope_json null: impossible under atomic tx */
  return refuse('not_implemented');
}

/** True when any line the cashier saw was removed or has moved on since. */
export function hasStaleLineVersion(
  store: CartStore,
  cartId: string,
  perLineVersions: CartHandoffRequest['per_line_versions'],
): boolean {
  return perLineVersions.some(({ line_id, version }) => {
    const line = store.getLine(cartId, line_id);
    return line?.removed_at !== null || line.version !== version;
  });
}

/** `computeLineSubtotal`, with an unsafe-integer subtotal reported as `null` (other errors propagate). */
export function subtotalOrNull(quantity: number, unitPriceMinor: number): number | null {
  try {
    return computeLineSubtotal(quantity, unitPriceMinor);
  } catch (err) {
    if (err instanceof LineSubtotalError) return null;
    /* v8 ignore next */
    throw err;
  }
}

/**
 * FR-016 quantity ops: increment/decrement default to delta 1; decrement
 * past zero and absolute zero delegate to line removal. Invalid deltas keep
 * the generic `stale_version` refusal posture.
 */
export function computeUpdatedQuantity(
  req: CartLinesUpdateRequest,
  currentQuantity: number,
):
  | { kind: 'ok'; newQuantity: number }
  | { kind: 'remove' }
  | { kind: 'refused'; reason: CartRefusalReason } {
  if (req.op === 'increment') {
    const delta = req.delta ?? 1;
    if (!Number.isInteger(delta) || delta <= 0) return refuse('stale_version');
    return { kind: 'ok', newQuantity: currentQuantity + delta };
  }
  if (req.op === 'decrement') {
    const delta = req.delta ?? 1;
    if (!Number.isInteger(delta) || delta <= 0) return refuse('stale_version');
    const newQuantity = currentQuantity - delta;
    return newQuantity <= 0 ? { kind: 'remove' } : { kind: 'ok', newQuantity };
  }
  const abs = req.absolute;
  if (abs === undefined || !Number.isInteger(abs) || abs < 0) return refuse('stale_version');
  return abs === 0 ? { kind: 'remove' } : { kind: 'ok', newQuantity: abs };
}

/**
 * RT-854 (OD-28-7): a discounted line's quantity is frozen, so a new quantity
 * is refused `line_discounted`; removing the line is not a quantity change.
 */
export function guardDiscountedQuantity(
  store: CartStore,
  req: CartLinesUpdateRequest,
  qty: ReturnType<typeof computeUpdatedQuantity>,
): ReturnType<typeof computeUpdatedQuantity> {
  if (qty.kind !== 'ok' || !lineHasDiscount(store, req.cart_id, req.line_id)) return qty;
  return refuse('line_discounted');
}

/**
 * Why a cart whose envelope could not be built cannot hand off. RT-854: a
 * discount that cannot be honoured on its line is step 5a's twin.
 */
export const ENVELOPE_BUILD_REFUSAL: Readonly<
  Record<Exclude<ReturnType<typeof buildPaymentIntentEnvelope>['kind'], 'ok'>, CartRefusalReason>
> = {
  empty_cart: 'empty_cart',
  subtotal_unsafe: 'not_implemented',
  discount_invalid: 'unauthorized_discount',
};

/** What the RT-26 transaction needs once every gate has passed. */
export interface ReturnToSaleContext {
  session: OperatorSessionRecord;
  store: CartStore;
  cart: StoredCart;
  release: ReleaseCheckoutPayment;
}

/** The append-only `cart.return_to_sale` outbox row (ids only). */
export function returnToSaleOutboxRow(
  req: CartReturnToSaleRequest,
  session: OperatorSessionRecord,
  now: string,
): InsertOutboxInput {
  return {
    action_id: req.idempotency_key,
    cart_id: req.cart_id,
    line_id: null,
    action_kind: 'cart.return_to_sale',
    acting_operator_id: session.operator_id,
    attribution_operator_id: null,
    operator_session_id: session.id,
    payload_json: JSON.stringify(
      scrubPayloadForOutbox({ cart_id: req.cart_id, handoff_action_id: req.handoff_action_id }),
    ),
    applied_at: now,
  };
}
