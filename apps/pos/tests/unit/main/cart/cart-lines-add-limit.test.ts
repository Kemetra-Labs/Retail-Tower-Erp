import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import { MAX_SALE_LINES } from '../../../../src/shared/cart/limits.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

/**
 * RT-1052 — a sale holds at most `MAX_SALE_LINES` (30) distinct lines, the
 * Backend-Core capture limit (RT-1051). The 31st distinct item is refused
 * `line_limit` and nothing is written; a scan that merges into an existing
 * line still works at the cap.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
  '0050_carts_park.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const SESSION: OperatorSessionRecord = {
  id: 'sess-rt1052',
  operator_id: 'cashier-1',
  display_name: 'Cashier One',
  role: 'cashier',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  started_at: '2026-11-03T08:00:00.000Z',
  backend_session_id: 'b-1',
  last_activity_at: '2026-11-03T08:00:00.000Z',
};

/** Any `SKU-<n>` resolves, so tests can add as many distinct items as they need. */
const anySku: ItemRefResolver = (item_ref) =>
  Promise.resolve({ kind: 'ok', display_name: `Item ${item_ref}`, unit_price_minor: 100 });

interface Fixture {
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  cart_id: string;
}

async function newCart(): Promise<Fixture> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => SESSION,
    getTerminalId: () => 'terminal-rt1052',
    cartStore: bindCartStore(makeSqlJsHandle(db)),
    resolveItemRef: anySku,
    clock: () => new Date('2026-11-03T10:00:00.000Z'),
  });
  const create = await handlers.create({ idempotency_key: 'create-k' });
  if (create.kind !== 'ok') throw new Error('cart.create failed');
  return { db, handlers, cart_id: create.cart_id };
}

function scalar(db: SqlJsDatabase, sql: string, params: (string | number)[]): unknown {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  const value = stmt.get()[0];
  stmt.free();
  return value;
}

const activeLines = (f: Fixture): number =>
  Number(
    scalar(f.db, 'SELECT COUNT(*) FROM cart_lines WHERE cart_id = ? AND removed_at IS NULL', [
      f.cart_id,
    ]),
  );
const outboxRows = (f: Fixture): number =>
  Number(scalar(f.db, 'SELECT COUNT(*) FROM cart_action_outbox WHERE cart_id = ?', [f.cart_id]));

async function addSku(f: Fixture, n: number, key = `add-${String(n)}`) {
  return f.handlers.linesAdd({
    cart_id: f.cart_id,
    item_ref: `SKU-${String(n)}`,
    quantity: 1,
    idempotency_key: key,
  });
}

async function fillToCap(f: Fixture): Promise<void> {
  for (let n = 1; n <= MAX_SALE_LINES; n += 1) {
    const r = await addSku(f, n);
    if (r.kind !== 'ok') throw new Error(`add ${String(n)} refused: ${JSON.stringify(r)}`);
  }
}

describe('cart.lines.add — RT-1052 line cap', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await newCart();
  });

  it('mirrors the Backend-Core capture limit of 30 lines', () => {
    expect(MAX_SALE_LINES).toBe(30);
  });

  it('accepts the 30th distinct line', async () => {
    await fillToCap(f);
    expect(activeLines(f)).toBe(MAX_SALE_LINES);
  });

  it('refuses the 31st distinct line with line_limit and writes nothing', async () => {
    await fillToCap(f);
    const outboxBefore = outboxRows(f);
    const r = await addSku(f, MAX_SALE_LINES + 1);
    expect(r).toEqual({ kind: 'refused', reason: 'line_limit' });
    expect(activeLines(f)).toBe(MAX_SALE_LINES);
    expect(outboxRows(f)).toBe(outboxBefore);
  });

  it('still merges a re-scan of an existing item at the cap', async () => {
    await fillToCap(f);
    const r = await addSku(f, 1, 'rescan-1');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.merged).toBe(true);
      expect(r.quantity).toBe(2);
    }
    expect(activeLines(f)).toBe(MAX_SALE_LINES);
  });

  it('accepts a new line again once a line is removed', async () => {
    await fillToCap(f);
    const lineId = String(
      scalar(f.db, 'SELECT line_id FROM cart_lines WHERE cart_id = ? AND item_ref = ?', [
        f.cart_id,
        'SKU-1',
      ]),
    );
    const removed = await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: lineId,
      version: 1,
      idempotency_key: 'remove-1',
    });
    expect(removed.kind).toBe('ok');
    const r = await addSku(f, MAX_SALE_LINES + 1);
    expect(r.kind).toBe('ok');
    expect(activeLines(f)).toBe(MAX_SALE_LINES);
  });
});
