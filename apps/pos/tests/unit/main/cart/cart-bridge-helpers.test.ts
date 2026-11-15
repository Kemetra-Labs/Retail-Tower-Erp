/**
 * RT-1227 — direct unit tests for the module-level helpers moved out of
 * `cart-bridge.ts` into `cart-bridge-helpers.ts` (PR 1, moves only).
 *
 * The handler-level behaviour stays pinned by the existing cart suites and by
 * the byte-equivalence golden
 * (tests/integration/main/cart/cart-bridge-equivalence.rt1227.test.ts); these
 * tests pin each helper's own contract so the PR 2 method split can lean on it.
 */
import { describe, it, expect } from 'vitest';

import {
  ApprovalRefused,
  approvedReasonHolds,
  computeUpdatedQuantity,
  discountAdded,
  ENVELOPE_BUILD_REFUSAL,
  guardDiscountedQuantity,
  handoffReplayResponse,
  hasStaleLineVersion,
  hasUntrustedDiscountPlaceholder,
  isSameAddPayload,
  isSameCancelReplay,
  isSameReturnReplay,
  lockedCartRefusal,
  noteHasForbiddenPattern,
  ownershipRefusal,
  parseEnvelope,
  postHandoffApprovalSubject,
  postHandoffCancelRefusal,
  refuse,
  rendererEnvelope,
  resolveOnLiveLine,
  returnToSaleOutboxRow,
  returnToSaleRefusal,
  scrubPayloadForOutbox,
  subtotalOrNull,
  voidRefusal,
} from '../../../../src/main/cart/cart-bridge-helpers.js';
import type {
  CartLineRow,
  CartRow,
  CartStore,
  OutboxRow,
} from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import type { PaymentIntentEnvelope } from '../../../../src/shared/cart/handoff-envelope.js';

const T0 = '2026-11-15T09:00:00.000Z';

function session(overrides: Partial<OperatorSessionRecord> = {}): OperatorSessionRecord {
  return {
    id: 'sess-1',
    operator_id: 'op-1',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: T0,
    backend_session_id: 'b-1',
    last_activity_at: T0,
    lock_state: 'active',
    locked_at: null,
    ...overrides,
  };
}

function cartRow(overrides: Partial<CartRow> = {}): CartRow {
  return {
    cart_id: 'cart-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    owning_operator_id: 'op-1',
    operator_session_id: 'sess-1',
    state: 'editing',
    cart_subtotal_minor: 3000,
    created_at: T0,
    updated_at: T0,
    frozen_at: null,
    cancelled_at: null,
    cancellation_reason: null,
    handoff_envelope_json: null,
    last_action_id: null,
    parked_at: null,
    ...overrides,
  };
}

function lineRow(overrides: Partial<CartLineRow> = {}): CartLineRow {
  return {
    line_id: 'line-1',
    cart_id: 'cart-1',
    item_ref: 'item-a',
    display_name: 'Panadol',
    quantity: 2,
    unit_price_minor: 1500,
    line_subtotal_minor: 3000,
    note: null,
    version: 1,
    last_action_id: 'a-1',
    created_at: T0,
    updated_at: T0,
    removed_at: null,
    ...overrides,
  };
}

function envelope(overrides: Partial<PaymentIntentEnvelope> = {}): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: 'cart-1',
    operator_session_id: 'sess-1',
    owning_operator_id: 'op-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    lines: [],
    discount_placeholders: [],
    subtotal_minor: 3000,
    created_at: T0,
    handoff_action_id: 'h-1',
    ...overrides,
  };
}

const frozenOn = (handoff: string): string =>
  JSON.stringify({ handoff_action_id: handoff, lines: [], discount_placeholders: [] });

/** A CartStore with only the reads a helper needs; anything else throws. */
function fakeStore(parts: Partial<CartStore>): CartStore {
  return new Proxy(parts, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof CartStore];
      throw new Error(`unexpected CartStore.${prop}`);
    },
  }) as CartStore;
}

function outboxRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    action_id: 'k-1',
    cart_id: 'cart-1',
    line_id: null,
    action_kind: 'cart.cancel.post_handoff',
    acting_operator_id: 'op-1',
    attribution_operator_id: null,
    operator_session_id: 'sess-1',
    payload_json: JSON.stringify({ cart_id: 'cart-1', handoff_action_id: 'h-1' }),
    applied_at: T0,
    ...overrides,
  } as OutboxRow;
}

// ── Notes and payload scrub ───────────────────────────────────────────────

describe('noteHasForbiddenPattern', () => {
  it.each([
    'my password is x',
    'PIN 1234',
    'card 4111111111111111',
    '-----BEGIN PRIVATE KEY',
    'jwt here',
  ])('refuses %j', (note) => {
    expect(noteHasForbiddenPattern(note)).toBe(true);
  });

  it.each(['keep refrigerated', 'pinch of salt', 'call at 0123456789'])('allows %j', (note) => {
    expect(noteHasForbiddenPattern(note)).toBe(false);
  });
});

describe('scrubPayloadForOutbox', () => {
  it('drops every forbidden top-level field name and keeps the rest in order', () => {
    const scrubbed = scrubPayloadForOutbox({
      cart_id: 'c',
      pin: '1',
      pin_hash: 'h',
      password: 'p',
      password_hash: 'ph',
      clerk_jwt: 'j',
      clerk_session_token: 't',
      device_token: 'd',
      device_token_attestation: 'a',
      pairing_code: 'pc',
      token: 'tk',
      secret: 's',
      credential: 'cr',
      handoff_action_id: 'h',
    });
    expect(JSON.stringify(scrubbed)).toBe('{"cart_id":"c","handoff_action_id":"h"}');
  });

  it('returns a new object and leaves nested values as they are', () => {
    const nested = { token: 'kept-nested' };
    const input = { a: 1, nested };
    const out = scrubPayloadForOutbox(input);
    expect(out).not.toBe(input);
    expect(out['nested']).toBe(nested);
  });
});

// ── Replay matching ───────────────────────────────────────────────────────

describe('isSameAddPayload', () => {
  const req = { cart_id: 'cart-1', item_ref: 'item-a', quantity: 2, idempotency_key: 'k' };

  it('matches an add row (`quantity`) and a merge row (`quantity_added`)', () => {
    const add = { cart_id: 'cart-1', payload_json: '{"item_ref":"item-a","quantity":2}' };
    const merge = { cart_id: 'cart-1', payload_json: '{"item_ref":"item-a","quantity_added":2}' };
    expect(isSameAddPayload(req, add)).toBe(true);
    expect(isSameAddPayload(req, merge)).toBe(true);
  });

  it.each([
    ['another cart', { cart_id: 'cart-2', payload_json: '{"item_ref":"item-a","quantity":2}' }],
    ['another item', { cart_id: 'cart-1', payload_json: '{"item_ref":"item-b","quantity":2}' }],
    ['another quantity', { cart_id: 'cart-1', payload_json: '{"item_ref":"item-a","quantity":3}' }],
    ['unreadable JSON', { cart_id: 'cart-1', payload_json: '{not json' }],
    ['a JSON null', { cart_id: 'cart-1', payload_json: 'null' }],
    ['a JSON scalar', { cart_id: 'cart-1', payload_json: '7' }],
  ])('does not match %s', (_label, replay) => {
    expect(isSameAddPayload(req, replay)).toBe(false);
  });
});

describe('isSameCancelReplay / isSameReturnReplay', () => {
  const req = { cart_id: 'cart-1', handoff_action_id: 'h-1' };

  it('matches only its own action kind on the same cart and handoff', () => {
    const cancel = outboxRow({ action_kind: 'cart.cancel.post_handoff' });
    const back = outboxRow({ action_kind: 'cart.return_to_sale' });
    expect(isSameCancelReplay(cancel, req)).toBe(true);
    expect(isSameCancelReplay(back, req)).toBe(false);
    expect(isSameReturnReplay(back, req)).toBe(true);
    expect(isSameReturnReplay(cancel, req)).toBe(false);
  });

  it('refuses another cart, another handoff, or an unreadable payload', () => {
    expect(isSameCancelReplay(outboxRow({ cart_id: 'cart-2' }), req)).toBe(false);
    expect(isSameCancelReplay(outboxRow(), { ...req, handoff_action_id: 'h-2' })).toBe(false);
    expect(isSameCancelReplay(outboxRow({ payload_json: '{bad' }), req)).toBe(false);
    expect(isSameCancelReplay(outboxRow({ payload_json: 'null' }), req)).toBe(false);
  });
});

// ── Envelopes ─────────────────────────────────────────────────────────────

describe('parseEnvelope', () => {
  it('parses a persisted envelope', () => {
    expect(parseEnvelope(frozenOn('h-1'))?.handoff_action_id).toBe('h-1');
  });

  it.each([
    ['null', null],
    ['unreadable JSON', '{bad'],
    ['a JSON scalar', '3'],
    ['no lines array', '{"discount_placeholders":[]}'],
    ['no placeholder array', '{"lines":[]}'],
  ])('returns null for %s', (_label, json) => {
    expect(parseEnvelope(json)).toBeNull();
  });
});

describe('rendererEnvelope', () => {
  it('removes manager attribution and freezes, without touching the persisted envelope', () => {
    const persisted = envelope({
      lines: [{ line_id: 'line-1' } as PaymentIntentEnvelope['lines'][number]],
      discount_placeholders: [
        {
          placeholder_id: 'dp-1',
          attribution_operator_id: 'mgr-1',
        } as PaymentIntentEnvelope['discount_placeholders'][number],
      ],
    });
    const shown = rendererEnvelope(persisted);
    expect(shown.discount_placeholders[0]?.attribution_operator_id).toBeNull();
    expect(persisted.discount_placeholders[0]?.attribution_operator_id).toBe('mgr-1');
    expect(shown.lines[0]).not.toBe(persisted.lines[0]);
    expect(Object.isFrozen(shown.lines)).toBe(true);
  });
});

describe('postHandoffApprovalSubject', () => {
  const frozen = cartRow({ state: 'frozen_handed_off', handoff_envelope_json: frozenOn('h-1') });

  it('binds the handoff and the cart subtotal', () => {
    expect(postHandoffApprovalSubject(frozen, session())).toEqual({
      version: 'handoff:h-1',
      amountMinor: 3000,
    });
  });

  it.each([
    ['no cart', undefined, session()],
    ['another tenant', frozen, session({ tenant_id: 'tenant-2' })],
    ['another branch', frozen, session({ branch_id: 'branch-2' })],
    ['a cart not frozen', { ...frozen, state: 'editing' }, session()],
    ['an unreadable envelope', { ...frozen, handoff_envelope_json: '{bad' }, session()],
  ])('is null for %s', (_label, cart, s) => {
    expect(postHandoffApprovalSubject(cart, s)).toBeNull();
  });
});

describe('handoffReplayResponse', () => {
  it('answers the persisted envelope for a handoff key', () => {
    const store = fakeStore({
      getCart: () => cartRow({ handoff_envelope_json: JSON.stringify(envelope()) }),
    });
    const res = handoffReplayResponse(
      store,
      'cart-1',
      outboxRow({ action_kind: 'cart.handoff_to_payment' }),
    );
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.envelope.handoff_action_id).toBe('h-1');
  });

  it('refuses a key that recorded another action', () => {
    expect(
      handoffReplayResponse(fakeStore({}), 'cart-1', outboxRow({ action_kind: 'cart.void' })),
    ).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
  });
});

// ── Refusal shapes and gates ──────────────────────────────────────────────

describe('refusal shapes', () => {
  it('refuse / discountAdded / ApprovalRefused', () => {
    expect(refuse('closed')).toEqual({ kind: 'refused', reason: 'closed' });
    expect(discountAdded('dp-1')).toEqual({
      kind: 'ok',
      placeholder_id: 'dp-1',
      requires_manager_attribution: true,
    });
    const err = new ApprovalRefused('approval_stale');
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe('approval_stale');
    expect(err.message).toBe('approval_stale');
  });

  it('maps every envelope build failure to its refusal', () => {
    expect(ENVELOPE_BUILD_REFUSAL).toEqual({
      empty_cart: 'empty_cart',
      subtotal_unsafe: 'not_implemented',
      discount_invalid: 'unauthorized_discount',
    });
  });
});

describe('approvedReasonHolds', () => {
  it('holds for a closed-list reason, restated or not', () => {
    expect(approvedReasonHolds('promotion', undefined)).toBe(true);
    expect(approvedReasonHolds('promotion', 'promotion')).toBe(true);
  });

  it('fails for an unknown reason or a different restated one', () => {
    expect(approvedReasonHolds('because', undefined)).toBe(false);
    expect(approvedReasonHolds(undefined, undefined)).toBe(false);
    expect(approvedReasonHolds('promotion', 'price_correction')).toBe(false);
  });
});

describe('lockedCartRefusal / voidRefusal', () => {
  it.each([
    [{ state: 'editing' }, null, null],
    [{ state: 'editing', parked_at: null }, null, null],
    [{ state: 'handing_off' }, 'frozen', null],
    [{ state: 'editing', parked_at: T0 }, 'cart_parked', 'cart_parked'],
    [{ state: 'frozen_handed_off' }, null, 'frozen'],
    [{ state: 'cancelled' }, null, 'closed'],
  ])('%j → locked %s, void %s', (cart, locked, voided) => {
    expect(lockedCartRefusal(cart)).toBe(locked);
    expect(voidRefusal(cart)).toBe(voided);
  });
});

describe('postHandoffCancelRefusal / returnToSaleRefusal', () => {
  const req = { handoff_action_id: 'h-1' };
  const frozen = { state: 'frozen_handed_off', handoff_envelope_json: frozenOn('h-1') };

  it('lets the persisted handoff through', () => {
    expect(postHandoffCancelRefusal(frozen, req)).toBeNull();
    expect(returnToSaleRefusal(frozen, req)).toBeNull();
  });

  it('refuses another handoff as stale', () => {
    const other = { handoff_action_id: 'h-2' };
    expect(postHandoffCancelRefusal(frozen, other)).toBe('stale_version');
    expect(returnToSaleRefusal(frozen, other)).toBe('stale_version');
  });

  it('refuses a cart that is not frozen', () => {
    const editing = { state: 'editing', handoff_envelope_json: null };
    const cancelled = { state: 'cancelled', handoff_envelope_json: frozenOn('h-1') };
    expect(postHandoffCancelRefusal(editing, req)).toBe('closed');
    expect(postHandoffCancelRefusal(cancelled, req)).toBe('closed');
    expect(returnToSaleRefusal(editing, req)).toBe('stale_version');
    expect(returnToSaleRefusal(cancelled, req)).toBe('closed');
  });
});

describe('ownershipRefusal', () => {
  const cart = cartRow();

  it('passes the owning session', () => {
    expect(ownershipRefusal(session(), cart)).toBeNull();
  });

  it('refuses another tenant', () => {
    expect(ownershipRefusal(session({ tenant_id: 'tenant-2' }), cart)).not.toBeNull();
  });
});

// ── Quantities ────────────────────────────────────────────────────────────

describe('computeUpdatedQuantity', () => {
  const req = (over: Record<string, unknown>) =>
    ({ cart_id: 'c', line_id: 'l', version: 1, idempotency_key: 'k', ...over }) as Parameters<
      typeof computeUpdatedQuantity
    >[0];

  it.each([
    [{ op: 'increment' }, 2, { kind: 'ok', newQuantity: 3 }],
    [{ op: 'increment', delta: 4 }, 2, { kind: 'ok', newQuantity: 6 }],
    [{ op: 'decrement' }, 2, { kind: 'ok', newQuantity: 1 }],
    [{ op: 'decrement', delta: 2 }, 2, { kind: 'remove' }],
    [{ op: 'set', absolute: 7 }, 2, { kind: 'ok', newQuantity: 7 }],
    [{ op: 'set', absolute: 0 }, 2, { kind: 'remove' }],
    [{ op: 'increment', delta: 0 }, 2, { kind: 'refused', reason: 'stale_version' }],
    [{ op: 'decrement', delta: 1.5 }, 2, { kind: 'refused', reason: 'stale_version' }],
    [{ op: 'set' }, 2, { kind: 'refused', reason: 'stale_version' }],
    [{ op: 'set', absolute: -1 }, 2, { kind: 'refused', reason: 'stale_version' }],
  ])('%j on %d → %j', (over, current, expected) => {
    expect(computeUpdatedQuantity(req(over), current)).toEqual(expected);
  });
});

describe('guardDiscountedQuantity', () => {
  const req = {
    cart_id: 'cart-1',
    line_id: 'line-1',
    op: 'increment',
    version: 1,
    idempotency_key: 'k',
  } as const;
  const discounted = fakeStore({
    getDiscountPlaceholdersForCart: () => [
      { line_id: 'line-1' } as ReturnType<CartStore['getDiscountPlaceholdersForCart']>[number],
    ],
  });

  it('refuses a new quantity on a discounted line, but not a removal', () => {
    expect(guardDiscountedQuantity(discounted, req, { kind: 'ok', newQuantity: 3 })).toEqual({
      kind: 'refused',
      reason: 'line_discounted',
    });
    expect(guardDiscountedQuantity(discounted, req, { kind: 'remove' })).toEqual({
      kind: 'remove',
    });
  });

  it('lets an undiscounted line through', () => {
    const plain = fakeStore({ getDiscountPlaceholdersForCart: () => [] });
    expect(guardDiscountedQuantity(plain, req, { kind: 'ok', newQuantity: 3 })).toEqual({
      kind: 'ok',
      newQuantity: 3,
    });
  });
});

describe('subtotalOrNull', () => {
  it('returns the subtotal, or null when it is not a safe integer', () => {
    expect(subtotalOrNull(3, 1500)).toBe(4500);
    expect(subtotalOrNull(2, Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

describe('hasStaleLineVersion', () => {
  const store = fakeStore({
    getLine: (_cart, line) =>
      line === 'gone'
        ? lineRow({ line_id: 'gone', removed_at: T0 })
        : line === 'line-1'
          ? lineRow({ version: 2 })
          : undefined,
  });

  it('is false when every line the cashier saw is live at that version', () => {
    expect(hasStaleLineVersion(store, 'cart-1', [{ line_id: 'line-1', version: 2 }])).toBe(false);
  });

  it.each([
    ['a moved-on version', [{ line_id: 'line-1', version: 1 }]],
    ['a removed line', [{ line_id: 'gone', version: 1 }]],
    ['a missing line', [{ line_id: 'nope', version: 1 }]],
  ])('is true for %s', (_label, seen) => {
    expect(hasStaleLineVersion(store, 'cart-1', seen)).toBe(true);
  });
});

// ── Discounts ─────────────────────────────────────────────────────────────

describe('resolveOnLiveLine', () => {
  const req = {
    cart_id: 'cart-1',
    line_id: 'line-1',
    placeholder_kind: 'manual_pct_10',
    idempotency_key: 'dp-1',
  };

  it.each([
    ['a missing line', undefined],
    ['a removed line', lineRow({ removed_at: T0 })],
  ])('refuses %s as wrong_owner', (_label, line) => {
    const store = fakeStore({ getLine: () => line });
    expect(resolveOnLiveLine(store, req, true)).toEqual({ refusal: 'wrong_owner' });
  });
});

describe('hasUntrustedDiscountPlaceholder', () => {
  const cart = cartRow();
  const placeholder = (kind: string) =>
    ({
      placeholder_id: 'dp-1',
      line_id: 'line-1',
      placeholder_kind: kind,
    }) as ReturnType<CartStore['getDiscountPlaceholdersForCart']>[number];

  it('is false with no placeholders', () => {
    const store = fakeStore({ getDiscountPlaceholdersForCart: () => [] });
    expect(hasUntrustedDiscountPlaceholder(store, cart)).toBe(false);
  });

  it('is true for a kind that is not a canonical token', () => {
    const store = fakeStore({ getDiscountPlaceholdersForCart: () => [placeholder('free_stuff')] });
    expect(hasUntrustedDiscountPlaceholder(store, cart)).toBe(true);
  });

  it('asks the trust check with the amount the live line gives now', () => {
    const refs: unknown[] = [];
    const store = fakeStore({
      getDiscountPlaceholdersForCart: () => [placeholder('manual_pct_10')],
      getLine: () => lineRow({ line_subtotal_minor: 3000 }),
      isDiscountPlaceholderTrusted: (ref) => {
        refs.push(ref);
        return true;
      },
    });
    expect(hasUntrustedDiscountPlaceholder(store, cart)).toBe(false);
    expect(refs).toEqual([
      {
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        cart_id: 'cart-1',
        line_id: 'line-1',
        placeholder_id: 'dp-1',
        amount_minor: 300,
      },
    ]);
  });

  it('omits the amount for a removed line and reports an untrusted placeholder', () => {
    const refs: unknown[] = [];
    const store = fakeStore({
      getDiscountPlaceholdersForCart: () => [placeholder('manual_pct_10')],
      getLine: () => lineRow({ removed_at: T0 }),
      isDiscountPlaceholderTrusted: (ref) => {
        refs.push(ref);
        return false;
      },
    });
    expect(hasUntrustedDiscountPlaceholder(store, cart)).toBe(true);
    expect(refs[0]).not.toHaveProperty('amount_minor');
  });
});

// ── Outbox rows ───────────────────────────────────────────────────────────

describe('returnToSaleOutboxRow', () => {
  it('writes the ids-only Back row with these exact payload bytes', () => {
    const row = returnToSaleOutboxRow(
      { cart_id: 'cart-1', handoff_action_id: 'h-1', idempotency_key: 'back-1' },
      session(),
      T0,
    );
    expect(row).toEqual({
      action_id: 'back-1',
      cart_id: 'cart-1',
      line_id: null,
      action_kind: 'cart.return_to_sale',
      acting_operator_id: 'op-1',
      attribution_operator_id: null,
      operator_session_id: 'sess-1',
      payload_json: '{"cart_id":"cart-1","handoff_action_id":"h-1"}',
      applied_at: T0,
    });
  });
});
