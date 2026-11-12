/**
 * RT-1339 (RT-286 S7) — automatic offers at the till, end to end in main, over the full
 * migration stack (sql.js) with the REAL cart bridge, handoff envelope, finalize
 * projection and transaction, capture payload and wire body, and receipt:
 *
 *   cart lines → Offer Pack plan → frozen envelope → settled attempt → finalize →
 *   `sales.lines_json` (reward lines split) → capture body → receipt copy
 *
 * covering spec 048 §6.1 E1, E2, E4 (the split) and E7 (a manual-discount line is excluded),
 * and the byte-stable re-send of the captured body (RT-1240).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshGrantDb,
  handleFor,
  initGrantSql,
} from '../../../../src/main/operator/__tests__/__helpers__/offline-grant-fixture.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import { bindAuditEventsStoreDb } from '../../../../src/main/audit/audit-events-store.js';
import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import {
  bootDiscountHarness,
  type DiscountHarness,
} from '../../../../src/main/cart/__tests__/__helpers__/discount-harness.js';
import { discountApprovalSubjectRef } from '../../../../src/shared/cart/discount-approval.js';
import type { PaymentIntentEnvelope } from '../../../../src/shared/cart/handoff-envelope.js';
import { planPromotions } from '../../../../src/main/offers/promotion-plan.js';
import {
  P1,
  P2,
  P3,
  P4,
  clockedService,
  freshService,
  memoryStore,
  packBody,
  packOffer,
  TENANT as PACK_TENANT,
} from '../../../../src/main/offers/__tests__/pack-fixture.js';
import { buildFinalizeInput } from '../../../../src/main/sales/finalize-dispatch.js';
import { bindFinalizeTransaction } from '../../../../src/main/sales/finalize-transaction.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { bindSaleSyncOutboxRepository } from '../../../../src/main/sync-outbox/sale-sync-outbox.repository.js';
import { bindSaleNumberAllocator } from '../../../../src/main/sales/sale-number-allocator.js';
import { createSaleAuditEmitter } from '../../../../src/main/sales/audit-emitter.js';
import { buildCapturePayload } from '../../../../src/main/sales-sync/capture-payload.js';
import { toWireBody } from '../../../../src/main/sales-sync/create-sale-sync-client.js';
import { deriveReceiptPayload } from '../../../../src/main/receipts/receipts-payload.js';
import { composeReceiptBands } from '../../../../src/main/receipts/template-engine.js';
import { HANDOFF, seedHeader } from '../sales/__helpers__/discounted-handoff-seed.js';

const TENANT = 'tenant-1';
const BRANCH = 'branch-1';
const TERMINAL = 'terminal-1';
const SCOPE = { tenantId: TENANT, branchId: BRANCH, terminalId: TERMINAL };
const T0 = '2026-10-24T09:00:00.000Z';
const MANAGER = {
  userId: '0190f5a2-3b4c-7d8e-9f01-00000000000a',
  pin: '246810',
  displayName: 'Mona Manager',
};

/** Unit price (minor units) per product id; a test sets its own, `beforeEach` resets them. */
const DEFAULT_PRICES: Readonly<Record<string, number>> = {
  [P1]: 30_000,
  [P2]: 20_000,
  [P3]: 6_000,
  [P4]: 4_000,
};
let PRICES: Record<string, number> = { ...DEFAULT_PRICES };

function session(
  role: OperatorSessionRecord['role'],
  id: string,
  cashierId = 'op-cashier',
): OperatorSessionRecord {
  return {
    id,
    operator_id: role === 'cashier' ? cashierId : `op-${id}`,
    display_name: 'Layla',
    role,
    tenant_id: TENANT,
    branch_id: BRANCH,
    started_at: T0,
    backend_session_id: `b-${id}`,
    last_activity_at: T0,
    lock_state: 'active',
    locked_at: null,
    ...(role === 'cashier' ? { user_id: '0190f5a2-3b4c-7d8e-9f01-0000000000cc' } : {}),
  };
}

let raw: SqlJsDatabase;
let h: DiscountHarness;
let cart: CartBridgeHandlers;
let current: OperatorSessionRecord;
let packService = freshService();

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(async () => {
  raw = freshGrantDb();
  PRICES = { ...DEFAULT_PRICES };
  const db = handleFor(raw);
  current = session('cashier', 'sess-cashier');
  packService = freshService();
  const durable = new AuditEmitter(bindAuditEventsStoreDb(db));
  h = await bootDiscountHarness({
    db,
    terminalId: TERMINAL,
    scope: SCOPE,
    manager: MANAGER,
    enrolledAt: T0,
    unitPriceMinor: 1,
    getSession: () => current,
    now: () => T0,
    audit: {
      emit: (e) => {
        durable.emit(e);
      },
    },
  });
  cart = new CartBridgeHandlers({
    getCurrentSession: () => current,
    getTerminalId: () => TERMINAL,
    cartStore: bindCartStore(db),
    resolveItemRef: (itemRef) =>
      Promise.resolve({
        kind: 'ok',
        display_name: `Item ${itemRef.slice(-2)}`,
        unit_price_minor: PRICES[itemRef] ?? 100,
      }),
    auditEmitter: durable,
    cartPaymentStatus: () => 'none',
    approvals: h.service,
    clock: () => new Date(T0),
    planPromotions: (lines) => planPromotions(lines, packService.service.view(), 'EGP'),
  });
});

afterEach(() => {
  raw.close();
});

async function newCart(items: ReadonlyArray<readonly [string, number]>): Promise<{
  cartId: string;
  lineIds: string[];
}> {
  const created = await cart.create({ idempotency_key: 'create-1' });
  if (created.kind !== 'ok') throw new Error('create failed');
  const lineIds: string[] = [];
  for (const [i, [itemRef, quantity]] of items.entries()) {
    const added = await cart.linesAdd({
      cart_id: created.cart_id,
      item_ref: itemRef,
      quantity,
      idempotency_key: `add-${String(i)}`,
    });
    if (added.kind !== 'ok') throw new Error(`add failed: ${added.reason}`);
    lineIds.push(added.line_id);
  }
  return { cartId: created.cart_id, lineIds };
}

async function handoff(cartId: string, lineIds: string[]): Promise<PaymentIntentEnvelope> {
  const out = await cart.handoff({
    cart_id: cartId,
    per_line_versions: lineIds.map((line_id) => ({ line_id, version: 1 })),
    idempotency_key: HANDOFF,
  });
  if (out.kind !== 'ok') throw new Error(`handoff refused: ${out.reason}`);
  return out.envelope;
}

type FrozenLine = Record<string, unknown>;

interface Sold {
  envelope: PaymentIntentEnvelope;
  lines: FrozenLine[];
  subtotal: number;
}

/** Settle the handed-off cart for its amount due and finalize it into a Sale. */
function finalize(envelope: PaymentIntentEnvelope): Sold {
  const handle = handleFor(raw);
  const due = envelope.total_due_minor ?? envelope.subtotal_minor;
  seedHeader(raw, due, envelope.cart_id);
  const projected = buildFinalizeInput({ db: handle, handoff_action_id: HANDOFF });
  if (projected.kind !== 'ok') throw new Error(`projection refused: ${projected.reason}`);
  let id = 0;
  const result = bindFinalizeTransaction({
    db: handle,
    salesRepo: bindSalesRepository(handle),
    outboxRepo: bindSaleSyncOutboxRepository(handle),
    allocator: bindSaleNumberAllocator(handle),
    auditEmitter: createSaleAuditEmitter({ sink: { write: () => undefined } }),
    now: () => '2026-10-24T10:00:02.000Z',
    saleIdGenerator: () => `sale-${String(++id)}`,
    outboxRowIdGenerator: () => `ob-${String(++id)}`,
  }).finalize(projected.input);
  expect(result.kind).toBe('finalized');
  const row = raw.exec(`SELECT lines_json, subtotal_minor FROM sales`)[0]?.values[0];
  return {
    envelope,
    lines: JSON.parse(String(row?.[0])) as FrozenLine[],
    subtotal: Number(row?.[1]),
  };
}

function saleRow() {
  const handle = handleFor(raw);
  const row = bindSalesRepository(handle).findByHandoffActionId(HANDOFF);
  if (row === null) throw new Error('no sale row');
  return row;
}

describe('E1 — 300.00 and 200.00: the 200.00 line takes 40% (80.00)', () => {
  it('freezes the offer on the envelope, the sale lines, the capture body and the receipt', async () => {
    const { cartId, lineIds } = await newCart([
      [P1, 1],
      [P2, 1],
    ]);
    const envelope = await handoff(cartId, lineIds);
    expect(envelope).toMatchObject({
      subtotal_minor: 50_000,
      discount_total_minor: 0,
      promotion_total_minor: 8_000,
      total_due_minor: 42_000,
    });
    expect(envelope.promotions?.map((p) => p.reward_discounts_minor)).toEqual([[], [8_000]]);

    const sold = finalize(envelope);
    expect(sold.subtotal).toBe(42_000);
    expect(sold.lines).toHaveLength(2);
    expect(sold.lines[0]).toMatchObject({
      quantity: 1,
      line_subtotal_minor: 30_000,
      promotion: { discount_minor: 0, offer_version: 3, pack_revision: 118 },
    });
    expect(sold.lines[1]).toMatchObject({
      quantity: 1,
      line_subtotal_minor: 20_000,
      promotion: { discount_minor: 8_000, percent_off: 40 },
    });

    const payload = buildCapturePayload(saleRow());
    expect(payload.totalMinor).toBe(42_000);
    expect(payload.lines.map((l) => l.lineAmountMinor)).toEqual([30_000, 12_000]);
    const wire = toWireBody(payload, 'EGP');
    expect(wire.posTotal).toBe('420.00');
    expect(wire.lines[0]?.promotion).toEqual({
      offerId: '0a000000-0000-7000-8000-000000000001',
      offerVersion: 3,
      packRevision: 118,
      discountAmount: '0.00',
    });
    expect(wire.lines[1]).toMatchObject({
      quantity: '1',
      unitPrice: '200.00',
      lineAmount: '120.00',
      promotion: { discountAmount: '80.00' },
    });
    expect(wire.lines[1]).not.toHaveProperty('discount');

    const receipt = deriveReceiptPayload(saleRow(), { variant: 'first_print' });
    expect(receipt.lines[1]?.promotion).toEqual({
      offer_name_ar: 'القطعة التانية بخصم 40%',
      percent_off: 40,
      discount_minor: 8_000,
    });
    const text = JSON.stringify(composeReceiptBands(receipt));
    expect(text).toContain('عرض: القطعة التانية بخصم 40% (خصم 40%)');
    expect(text).toContain('-80.00');
  });
});

describe('E2 — 100, 80, 60, 40: the two cheapest units take it (24.00 + 16.00)', () => {
  it('discounts the cheapest units of the whole basket, not every second unit', async () => {
    const pack = packBody({
      offers: [packOffer({ eligibleProductIds: [P1, P2, P3, P4] })],
    });
    packService = freshService(pack);
    PRICES[P1] = 10_000;
    PRICES[P2] = 8_000;
    const { cartId, lineIds } = await newCart([
      [P1, 1],
      [P2, 1],
      [P3, 1],
      [P4, 1],
    ]);
    const envelope = await handoff(cartId, lineIds);
    expect(envelope.promotion_total_minor).toBe(4_000);
    const sold = finalize(envelope);
    expect(sold.subtotal).toBe(28_000 - 4_000);
    const discounts = sold.lines.map(
      (l) => (l['promotion'] as { discount_minor: number }).discount_minor,
    );
    expect(discounts).toEqual([0, 0, 2_400, 1_600]);
  });
});

describe('E4 — product A 150.00 × 2 on one cart line: the sale shows two lines', () => {
  it('splits the reward unit onto its own quantity-1 line (150.00, then 90.00)', async () => {
    PRICES[P1] = 15_000;
    const { cartId, lineIds } = await newCart([[P1, 2]]);
    const envelope = await handoff(cartId, lineIds);
    expect(envelope.lines).toHaveLength(1); // the CART line is not split
    expect(envelope.total_due_minor).toBe(24_000);

    const sold = finalize(envelope);
    expect(sold.subtotal).toBe(24_000);
    expect(sold.lines).toHaveLength(2);
    expect(sold.lines[0]).toMatchObject({
      line_id: lineIds[0],
      quantity: 1,
      line_subtotal_minor: 15_000,
      promotion: { discount_minor: 0 },
    });
    expect(sold.lines[1]).toMatchObject({
      quantity: 1,
      line_subtotal_minor: 15_000,
      promotion: { discount_minor: 6_000 },
    });
    expect(sold.lines[1]?.['line_id']).not.toBe(lineIds[0]);
    expect(sold.lines[1]?.['line_id']).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);

    const wire = toWireBody(buildCapturePayload(saleRow()), 'EGP');
    expect(wire.lines.map((l) => [l.quantity, l.unitPrice, l.lineAmount])).toEqual([
      ['1', '150.00', '150.00'],
      ['1', '150.00', '90.00'],
    ]);
  });
});

describe('E7 — a line with a manual discount is excluded (OD-5)', () => {
  it('one eligible unit left means no offer; the manual discount stands alone', async () => {
    PRICES[P1] = 10_000;
    PRICES[P2] = 6_000;
    const { cartId, lineIds } = await newCart([
      [P1, 1],
      [P2, 1],
    ]);
    // A manager adds a 10% manual discount to the 100.00 line.
    raw.run(`UPDATE carts SET operator_session_id = 'sess-m' WHERE cart_id = ?`, [cartId]);
    current = { ...session('manager', 'sess-m'), manager_user_id: MANAGER.userId };
    const added = await cart.discountPlaceholdersAdd({
      cart_id: cartId,
      line_id: lineIds[0] ?? '',
      placeholder_kind: 'manual_pct_10',
      idempotency_key: 'dp-1',
      reason_code: 'promotion',
    });
    expect(added.kind).toBe('ok');
    expect(
      discountApprovalSubjectRef({
        cart_id: cartId,
        line_id: lineIds[0] ?? '',
        placeholder_kind: 'manual_pct_10',
      }),
    ).toBeTruthy();

    const envelope = await handoff(cartId, lineIds);
    expect(envelope.promotions).toBeUndefined();
    expect(envelope).toMatchObject({
      discount_total_minor: 1_000,
      total_due_minor: 16_000 - 1_000,
    });
    expect(envelope).not.toHaveProperty('promotion_total_minor');

    const sold = finalize(envelope);
    expect(sold.lines.every((l) => l['promotion'] === undefined)).toBe(true);
    expect(sold.lines[0]).toHaveProperty('discount');
  });
});

describe('capture is byte-stable on re-send (RT-1240)', () => {
  it('builds the same body, byte for byte, from the stored sale every time', async () => {
    const { cartId, lineIds } = await newCart([
      [P1, 1],
      [P2, 1],
    ]);
    finalize(await handoff(cartId, lineIds));
    const first = JSON.stringify(toWireBody(buildCapturePayload(saleRow()), 'EGP'));
    // Between the sale and its re-send the Pack moves on (another revision, the offer ended) and the
    // clock runs: the stored sale alone decides the body.
    packService = clockedService(memoryStore());
    packService.service.applyOk({
      tenantId: PACK_TENANT,
      body: packBody({ packRevision: 999, offers: [] }),
      etag: '"z"',
      serverTime: '2026-11-12T10:00:00.000Z',
      monoAtStartMs: packService.mono(),
    });
    const second = JSON.stringify(toWireBody(buildCapturePayload(saleRow()), 'EGP'));
    expect(second).toBe(first);
  });
});

describe('a till with no Pack sells exactly as before', () => {
  it('writes no offer fields on the envelope, the sale lines or the capture body', async () => {
    packService = clockedService();
    const { cartId, lineIds } = await newCart([
      [P1, 1],
      [P2, 1],
    ]);
    const envelope = await handoff(cartId, lineIds);
    expect(envelope).not.toHaveProperty('promotions');
    expect(envelope).not.toHaveProperty('promotion_total_minor');
    expect(envelope.total_due_minor).toBe(50_000);
    const sold = finalize(envelope);
    expect(sold.lines.some((l) => 'promotion' in l)).toBe(false);
    const wire = toWireBody(buildCapturePayload(saleRow()), 'EGP');
    expect(JSON.stringify(wire)).not.toContain('promotion');
  });
});
