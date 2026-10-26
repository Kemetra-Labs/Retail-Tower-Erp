/**
 * RT-308 (RT-113 P3, 10763 D6) — a cashier session admitted OFFLINE from a
 * sealed grant, once the grant has expired: no NEW sale may start
 * (`offline_authority_expired`), while the current sale may still grow,
 * complete or be voided, and nothing already captured is rewritten.
 *
 * The bound holds on BOTH clocks: a wall clock set back does not reopen it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore, type CartStore } from '../../../../src/main/cart/cart-store.js';
import {
  SessionManager,
  type OperatorSessionRecord,
} from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname0, '..', '..', '..', '..');
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

const VALID_UNTIL = Date.parse('2026-10-27T08:00:00.000Z');
const DEADLINE_MONO = 90_000_000;

const resolveItemRef = (): Promise<{
  kind: 'ok';
  display_name: string;
  unit_price_minor: number;
}> => Promise.resolve({ kind: 'ok', display_name: 'Item', unit_price_minor: 1_000 });

/** A session made through the real create() path, as the offline sign-in makes it. */
function offlineSession(): OperatorSessionRecord {
  return new SessionManager().create({
    operator_id: 'user_clerk_1',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    backend_session_id: '',
    offline_admission: {
      user_id: 'user-1',
      valid_until_ms: VALID_UNTIL,
      deadline_mono_ms: DEADLINE_MONO,
    },
  });
}

interface World {
  db: SqlJsDatabase;
  store: CartStore;
  handlers: CartBridgeHandlers;
  clock: { wall: number; mono: number };
}

function build(session: OperatorSessionRecord): World {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const store = bindCartStore(makeSqlJsHandle(db));
  const clock = { wall: VALID_UNTIL - 60_000, mono: DEADLINE_MONO - 60_000 };
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => session,
    getTerminalId: () => 'terminal-1',
    cartStore: store,
    resolveItemRef,
    clock: () => new Date(clock.wall),
    monotonicNow: () => clock.mono,
  });
  return { db, store, handlers, clock };
}

function expire(w: World, by: 'wall' | 'mono'): void {
  if (by === 'wall') w.clock.wall = VALID_UNTIL;
  else w.clock.mono = DEADLINE_MONO;
}

async function openSale(w: World, key: string): Promise<string> {
  const created = await w.handlers.create({ idempotency_key: `create-${key}` });
  if (created.kind !== 'ok') throw new Error(`create failed: ${created.reason}`);
  const added = await w.handlers.linesAdd({
    cart_id: created.cart_id,
    item_ref: 'sku-1',
    quantity: 1,
    idempotency_key: `add-${key}`,
  });
  if (added.kind !== 'ok') throw new Error('add failed');
  return created.cart_id;
}

describe('offline-admitted session (handler level)', () => {
  it('the real create() path records the offline authority and bound', () => {
    expect(offlineSession()).toMatchObject({
      authority: 'offline_grant',
      user_id: 'user-1',
      authority_valid_until_ms: VALID_UNTIL,
      authority_deadline_mono_ms: DEADLINE_MONO,
    });
  });

  it('before expiry a new sale starts', async () => {
    const w = build(offlineSession());
    await expect(w.handlers.create({ idempotency_key: 'create-exp-0001' })).resolves.toMatchObject({
      kind: 'ok',
    });
  });

  it.each(['wall', 'mono'] as const)(
    'after expiry (%s clock) cart.create refuses offline_authority_expired',
    async (by) => {
      const w = build(offlineSession());
      expire(w, by);
      await expect(w.handlers.create({ idempotency_key: 'create-exp-0002' })).resolves.toEqual({
        kind: 'refused',
        reason: 'offline_authority_expired',
      });
    },
  );

  it('a wall clock set back after expiry does not reopen it (monotonic bound)', async () => {
    const w = build(offlineSession());
    w.clock.mono = DEADLINE_MONO + 1;
    w.clock.wall = VALID_UNTIL - 3_600_000;
    await expect(w.handlers.create({ idempotency_key: 'create-exp-0003' })).resolves.toEqual({
      kind: 'refused',
      reason: 'offline_authority_expired',
    });
  });

  it('after expiry the current sale may grow; an empty cart may not become a new sale', async () => {
    const w = build(offlineSession());
    const current = await openSale(w, 'exp-0004');
    const empty = await w.handlers.create({ idempotency_key: 'create-exp-0005' });
    if (empty.kind !== 'ok') throw new Error('create failed');
    expire(w, 'wall');
    await expect(
      w.handlers.linesAdd({
        cart_id: current,
        item_ref: 'sku-2',
        quantity: 2,
        idempotency_key: 'add-exp-0006',
      }),
    ).resolves.toMatchObject({ kind: 'ok' });
    await expect(
      w.handlers.linesAdd({
        cart_id: empty.cart_id,
        item_ref: 'sku-1',
        quantity: 1,
        idempotency_key: 'add-exp-0007',
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'offline_authority_expired' });
    // The current sale's facts are intact: both lines, their prices, untouched.
    const lines = w.store.getActiveLines(current);
    expect(lines.map((l) => [l.item_ref, l.quantity, l.unit_price_minor])).toEqual([
      ['sku-1', 1, 1_000],
      ['sku-2', 2, 1_000],
    ]);
    expect(w.store.getActiveLines(empty.cart_id)).toHaveLength(0);
  });

  it('after expiry the current sale may still be voided', async () => {
    const w = build(offlineSession());
    const created = await w.handlers.create({ idempotency_key: 'create-exp-0008' });
    if (created.kind !== 'ok') throw new Error('create failed');
    w.db.run(`UPDATE carts SET state = 'editing' WHERE cart_id = ?`, [created.cart_id]);
    expire(w, 'wall');
    await expect(
      w.handlers.void({ cart_id: created.cart_id, idempotency_key: 'void-exp-0001' }),
    ).resolves.toEqual({ kind: 'ok' });
  });

  it('a replayed cart.create (same key) still answers its original cart', async () => {
    const w = build(offlineSession());
    const first = await w.handlers.create({ idempotency_key: 'create-exp-0009' });
    expire(w, 'wall');
    // Refused before the replay lookup, like the latch: no new sale, no echo.
    await expect(w.handlers.create({ idempotency_key: 'create-exp-0009' })).resolves.toEqual({
      kind: 'refused',
      reason: 'offline_authority_expired',
    });
    expect(first.kind).toBe('ok');
  });

  it('an online-confirmed session is never bound by the offline expiry', async () => {
    const session = offlineSession();
    session.authority = 'online_confirmed';
    const w = build(session);
    expire(w, 'wall');
    expire(w, 'mono');
    await expect(w.handlers.create({ idempotency_key: 'create-exp-0010' })).resolves.toMatchObject({
      kind: 'ok',
    });
  });

  it('the latch still wins over the expiry', async () => {
    const session = offlineSession();
    session.authority_latch = 'superseded_by_takeover';
    const w = build(session);
    expire(w, 'wall');
    await expect(w.handlers.create({ idempotency_key: 'create-exp-0011' })).resolves.toEqual({
      kind: 'refused',
      reason: 'authority_conflict',
    });
  });

  it('a manager session given offline fields by mistake gets no offline authority', () => {
    const s = new SessionManager().create({
      operator_id: 'user_clerk_mgr',
      display_name: 'Mgr',
      role: 'manager',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      backend_session_id: 'bs-1',
      offline_admission: { user_id: 'u', valid_until_ms: 1, deadline_mono_ms: 1 },
    });
    expect(s.authority).toBeUndefined();
    expect(s.user_id).toBeUndefined();
  });
});
