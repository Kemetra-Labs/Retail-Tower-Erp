import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { Logger } from 'pino';

import { createCartBridgeHandlers } from '../wire-cart-handlers.js';
import { createCatalogueResolver } from '../../catalogue/resolve-item-ref.js';
import { createProductRepo } from '../../catalogue/product-repo.js';
import { AuditEmitter } from '../../audit/audit-emitter.js';
import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
  seedProduct,
} from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';

/**
 * RT-1178 — `cart.snapshot` carries each line's Rx / controlled flags, read
 * from the local catalogue through the production factory, so a renderer that
 * lost its state (reload, app restart) shows them again.
 *
 * Owner decision (RT-1178 c15823): the flags are projected whatever the
 * product's `active` state, because the line is still in the cart.
 */

const TENANT = 'tenant-1';

let db: SqlJsDatabase | undefined;

beforeAll(async () => {
  await initCatalogueSql();
});

afterEach(() => {
  if (db !== undefined) {
    db.close();
    db = undefined;
  }
});

function makeSession(): OperatorSessionRecord {
  return {
    id: 'sess-1178',
    operator_id: 'cashier-1178',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: TENANT,
    branch_id: 'branch-1',
    started_at: '2026-11-06T08:00:00.000Z',
    backend_session_id: 'bsess-1178',
    last_activity_at: '2026-11-06T08:00:00.000Z',
    lock_state: 'active',
    locked_at: null,
  };
}

function handlersOn(seeded: SqlJsDatabase) {
  const dbHandle = handleFor(seeded);
  const session = makeSession();
  return createCartBridgeHandlers({
    dbHandle,
    getCurrentSession: () => session,
    getTerminalId: () => 'terminal-test',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    auditEmitter: new AuditEmitter({ insertIgnore: () => {} }),
    isPackaged: true,
    productionResolver: createCatalogueResolver({
      repo: createProductRepo(dbHandle),
      getTenantId: () => session.tenant_id,
    }),
    cartPaymentStatus: () => 'none',
    releaseCheckoutPayment: () => ({ kind: 'blocked' }),
    checkoutReturnAllowed: () => false,
    approvals: { consume: () => ({ kind: 'refused', reason: 'approval_invalid' }) },
  });
}

async function cartWith(
  handlers: ReturnType<typeof handlersOn>,
  productIds: readonly string[],
): Promise<string> {
  const created = await handlers.create({ idempotency_key: 'ik-create' });
  if (created.kind !== 'ok') throw new Error('cart.create refused');
  for (const product_id of productIds) {
    const add = await handlers.linesAdd({
      cart_id: created.cart_id,
      item_ref: product_id,
      quantity: 1,
      idempotency_key: `ik-add-${product_id}`,
    });
    if (add.kind !== 'ok') throw new Error(`cart.lines.add refused for ${product_id}`);
  }
  return created.cart_id;
}

function seedFlagged(seeded: SqlJsDatabase): void {
  seedProduct(seeded, { product_id: 'p-plain', sku: 'SKU-PLAIN', tenant_id: TENANT });
  seedProduct(seeded, {
    product_id: 'p-rx',
    sku: 'SKU-RX',
    tenant_id: TENANT,
    prescription_required: 1,
  });
  seedProduct(seeded, {
    product_id: 'p-ctl',
    sku: 'SKU-CTL',
    tenant_id: TENANT,
    controlled_substance: 1,
    prescription_required: 1,
  });
}

function flagsOf(
  lines: ReadonlyArray<{ controlled_substance: boolean; prescription_required: boolean }>,
) {
  return lines.map((l) => [l.controlled_substance, l.prescription_required]);
}

describe('RT-1178 cart.snapshot line flags (production wiring)', () => {
  it('projects each line’s controlled / Rx flags from the local catalogue', async () => {
    db = freshCatalogueDb();
    seedFlagged(db);
    const handlers = handlersOn(db);
    const cartId = await cartWith(handlers, ['p-plain', 'p-rx', 'p-ctl']);

    const res = await handlers.snapshot({ cart_id: cartId });
    if (res.kind !== 'ok') throw new Error('snapshot refused');
    expect(flagsOf(res.snapshot.lines)).toEqual([
      [false, false],
      [false, true],
      [true, true],
    ]);
  });

  it('keeps the flags of a line whose product was deactivated after the add', async () => {
    db = freshCatalogueDb();
    seedFlagged(db);
    const handlers = handlersOn(db);
    const cartId = await cartWith(handlers, ['p-ctl']);
    db.run(`UPDATE products SET active = 0 WHERE product_id = 'p-ctl'`);

    const res = await handlers.snapshot({ cart_id: cartId });
    if (res.kind !== 'ok') throw new Error('snapshot refused');
    expect(flagsOf(res.snapshot.lines)).toEqual([[true, true]]);
  });

  it('reads the cart’s own tenant only, and reports no flags for a product gone from the catalogue', async () => {
    db = freshCatalogueDb();
    seedFlagged(db);
    const handlers = handlersOn(db);
    const cartId = await cartWith(handlers, ['p-rx', 'p-ctl']);
    // p-rx now belongs to another tenant (still flagged there); p-ctl is gone.
    db.run(`UPDATE products SET tenant_id = 'tenant-2' WHERE product_id = 'p-rx'`);
    db.run(`DELETE FROM products WHERE product_id = 'p-ctl'`);

    const res = await handlers.snapshot({ cart_id: cartId });
    if (res.kind !== 'ok') throw new Error('snapshot refused');
    expect(flagsOf(res.snapshot.lines)).toEqual([
      [false, false],
      [false, false],
    ]);
  });
});
