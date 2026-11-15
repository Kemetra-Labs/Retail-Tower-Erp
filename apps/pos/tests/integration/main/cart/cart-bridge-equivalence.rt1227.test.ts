// @vitest-environment node
/**
 * RT-1227 — byte-equivalence guard for the `cart-bridge.ts` refactor.
 *
 * A scripted sale runs through the PRODUCTION factory (`createCartBridgeHandlers`)
 * over the REAL migration chain (sql.js): lines added, merged, updated, noted,
 * removed and undone; a cashier discount on a manager approval and a manager's
 * direct discount (added, then removed); a handoff, Checkout Back and a second
 * handoff; a cashier cancel after handoff; a pre-handoff void; refusals; and a
 * restart (fresh handlers over the same database) that replays every key.
 *
 * Every IPC result, every row of every table (the outbox `payload_json` bytes
 * included), every approval consumed and the final snapshot are written to one
 * golden file, recorded on the code BEFORE the split. The refactor must leave
 * that file byte-identical: any change to a SQLite write, an outbox payload,
 * the handoff / replay ordering or an IPC result fails this test.
 *
 * Determinism: `randomUUID` is a counter and `Date` is faked, one second
 * further on per step, so the same calls produce the same bytes on every run.
 * The `node` environment is required: under `happy-dom` the `node:crypto`
 * mock does not reach `cart-bridge.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';

const uuid = vi.hoisted(() => ({ seq: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: (): string => {
      uuid.seq += 1;
      return `00000000-0000-4000-8000-${String(uuid.seq).padStart(12, '0')}`;
    },
  };
});

import { createCartBridgeHandlers } from '../../../../src/main/cart/wire-cart-handlers.js';
import type { CartBridgeHandlers, ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import { bindAuditEventsStoreDb } from '../../../../src/main/audit/audit-events-store.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';
import type {
  ConsumeApprovalInput,
  ConsumeApprovalOutcome,
} from '../../../../src/main/operator/manager-approval-service.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import {
  bindCheckoutReturnAllowed,
  bindCheckoutReturnGuard,
} from '../../../../src/main/payments/checkout-return-guard.js';
import { bindCartPaymentStatus } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { makeSqlJsHandle } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname0, '..', '..', '..', '..', 'migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));

const GOLDEN = './__golden__/cart-bridge-sequence.golden.txt';

const T0 = Date.UTC(2026, 10, 15, 9, 0, 0);

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
});

function operator(id: string, role: OperatorSessionRecord['role']): OperatorSessionRecord {
  return {
    id,
    operator_id: `op-${id}`,
    display_name: 'Operator',
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-11-15T08:00:00.000Z',
    backend_session_id: `b-${id}`,
    last_activity_at: '2026-11-15T08:00:00.000Z',
    lock_state: 'active',
    locked_at: null,
  };
}

const CASHIER = operator('cashier-1', 'cashier');
const MANAGER = operator('manager-1', 'manager');

const CATALOGUE: Record<string, { display_name: string; unit_price_minor: number }> = {
  'item-a': { display_name: 'Panadol', unit_price_minor: 1500 },
  'item-b': { display_name: 'Vitamin C', unit_price_minor: 2500 },
  'item-c': { display_name: 'Plaster', unit_price_minor: 300 },
};

const resolver: ItemRefResolver = (ref) => {
  const hit = CATALOGUE[ref];
  return Promise.resolve(
    hit === undefined ? { kind: 'refused', reason: 'unknown_item' } : { kind: 'ok', ...hit },
  );
};

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

/** Every row of every table, in table-name then rowid order. */
function dumpTables(db: SqlJsDatabase): Record<string, unknown[]> {
  const names = db.exec(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  )[0];
  const out: Record<string, unknown[]> = {};
  for (const [name] of names?.values ?? []) {
    const table = String(name);
    const res = db.exec(`SELECT * FROM "${table}" ORDER BY rowid`)[0];
    if (res === undefined) continue;
    out[table] = res.values.map((row) =>
      Object.fromEntries(res.columns.map((col, i) => [col, row[i]])),
    );
  }
  return out;
}

interface World {
  db: SqlJsDatabase;
  handle: DatabaseHandle;
  approvals: ConsumeApprovalInput[];
  setSession: (s: OperatorSessionRecord | null) => void;
  boot: () => CartBridgeHandlers;
}

function world(): World {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.exec(sql);
  const handle = makeSqlJsHandle(db);
  let session: OperatorSessionRecord | null = CASHIER;
  const approvals: ConsumeApprovalInput[] = [];
  const unexpected = (what: string) => (): never => {
    throw new Error(`${what} is not part of this script`);
  };
  const boot = (): CartBridgeHandlers =>
    createCartBridgeHandlers({
      dbHandle: handle,
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-1',
      logger,
      auditEmitter: new AuditEmitter(bindAuditEventsStoreDb(handle)),
      isPackaged: true,
      productionResolver: resolver,
      cartPaymentStatus: bindCartPaymentStatus(handle),
      // No payment attempt exists in this script, so the guard only reads.
      releaseCheckoutPayment: bindCheckoutReturnGuard({
        db: handle,
        paymentAttemptFsm: { cancel: unexpected('payment cancel') },
        auditEmitter: { emitPaymentCancelled: unexpected('payment audit') },
      }),
      checkoutReturnAllowed: bindCheckoutReturnAllowed(handle),
      approvals: {
        consume: (input): ConsumeApprovalOutcome => {
          approvals.push(input);
          return input.approvalId.startsWith('appr-bad')
            ? { kind: 'refused', reason: 'approval_invalid' }
            : {
                kind: 'consumed',
                approverUserId: 'mgr-user-1',
                reasonCode: 'promotion',
                approverRole: 'manager',
              };
        },
      },
    });
  return { db, handle, approvals, setSession: (s) => (session = s), boot };
}

function okField(res: unknown, field: string): unknown {
  const r = res as Record<string, unknown>;
  if (r['kind'] !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(res)}`);
  return r[field];
}

const okString = (res: unknown, field: string): string => okField(res, field) as string;
const okNumber = (res: unknown, field: string): number => okField(res, field) as number;

/** The line ids and versions of an `ok` snapshot. */
function snapshotLines(snap: unknown): { line_id: string; version: number }[] {
  const { lines } = okField(snap, 'snapshot') as { lines: { line_id: string; version: number }[] };
  return lines.map((l) => ({ line_id: l.line_id, version: l.version }));
}

describe('cart-bridge scripted sale — byte-identical before and after the RT-1227 split', () => {
  it('produces the recorded IPC results, SQLite rows and outbox payloads', async () => {
    uuid.seq = 0;
    const w = world();
    const steps: { step: string; result: unknown }[] = [];
    let h = w.boot();
    const call = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
      vi.setSystemTime(T0 + steps.length * 1000);
      const result = await run();
      steps.push({ step, result });
      return result;
    };

    // ── Sale A: lines ─────────────────────────────────────────────────────
    const cartA = okString(
      await call('A.create', () => h.create({ idempotency_key: 'a-create' })),
      'cart_id',
    );
    const addA = await call('A.add item-a x2', () =>
      h.linesAdd({ cart_id: cartA, item_ref: 'item-a', quantity: 2, idempotency_key: 'a-add-1' }),
    );
    const lineA = okString(addA, 'line_id');
    await call('A.add item-a x1 (merge)', () =>
      h.linesAdd({ cart_id: cartA, item_ref: 'item-a', quantity: 1, idempotency_key: 'a-add-2' }),
    );
    await call('A.add replay a-add-1', () =>
      h.linesAdd({ cart_id: cartA, item_ref: 'item-a', quantity: 2, idempotency_key: 'a-add-1' }),
    );
    await call('A.add replay a-add-1 other qty', () =>
      h.linesAdd({ cart_id: cartA, item_ref: 'item-a', quantity: 5, idempotency_key: 'a-add-1' }),
    );
    await call('A.add unknown item', () =>
      h.linesAdd({ cart_id: cartA, item_ref: 'item-x', quantity: 1, idempotency_key: 'a-add-x' }),
    );
    const addB = await call('A.add item-b x1', () =>
      h.linesAdd({ cart_id: cartA, item_ref: 'item-b', quantity: 1, idempotency_key: 'a-add-3' }),
    );
    const lineB = okString(addB, 'line_id');
    await call('A.update item-b +2', () =>
      h.linesUpdate({
        cart_id: cartA,
        line_id: lineB,
        op: 'increment',
        delta: 2,
        version: okNumber(addB, 'version'),
        idempotency_key: 'a-upd-1',
      }),
    );
    await call('A.update item-b stale version', () =>
      h.linesUpdate({
        cart_id: cartA,
        line_id: lineB,
        op: 'set',
        absolute: 9,
        version: 1,
        idempotency_key: 'a-upd-stale',
      }),
    );
    const snapA1 = await call('A.snapshot 1', () => h.snapshot({ cart_id: cartA }));
    const versionOf = (snap: unknown, lineId: string): number => {
      const line = snapshotLines(snap).find((l) => l.line_id === lineId);
      if (line === undefined) throw new Error(`line ${lineId} missing`);
      return line.version;
    };
    await call('A.setNote item-a', () =>
      h.linesSetNote({
        cart_id: cartA,
        line_id: lineA,
        note: 'keep refrigerated',
        version: versionOf(snapA1, lineA),
        idempotency_key: 'a-note-1',
      }),
    );
    await call('A.setNote forbidden pattern', () =>
      h.linesSetNote({
        cart_id: cartA,
        line_id: lineA,
        note: 'password 1234',
        version: versionOf(snapA1, lineA),
        idempotency_key: 'a-note-bad',
      }),
    );
    const addC = await call('A.add item-c x1', () =>
      h.linesAdd({ cart_id: cartA, item_ref: 'item-c', quantity: 1, idempotency_key: 'a-add-4' }),
    );
    const lineC = okString(addC, 'line_id');
    await call('A.remove item-c', () =>
      h.linesRemove({
        cart_id: cartA,
        line_id: lineC,
        version: okNumber(addC, 'version'),
        idempotency_key: 'a-rm-1',
      }),
    );
    await call('A.undo remove item-c', () =>
      h.undoLast({ cart_id: cartA, target_action_id: 'a-rm-1', idempotency_key: 'a-undo-1' }),
    );
    const snapA2 = await call('A.snapshot 2', () => h.snapshot({ cart_id: cartA }));
    await call('A.remove item-c again', () =>
      h.linesRemove({
        cart_id: cartA,
        line_id: lineC,
        version: versionOf(snapA2, lineC),
        idempotency_key: 'a-rm-2',
      }),
    );

    // ── Sale A: discounts ─────────────────────────────────────────────────
    await call('A.discount cashier without approval', () =>
      h.discountPlaceholdersAdd({
        cart_id: cartA,
        line_id: lineA,
        placeholder_kind: 'manual_pct_10',
        idempotency_key: 'a-dp-noappr',
      }),
    );
    await call('A.discount cashier refused approval', () =>
      h.discountPlaceholdersAdd({
        cart_id: cartA,
        line_id: lineA,
        placeholder_kind: 'manual_pct_10',
        approval_id: 'appr-bad-1',
        idempotency_key: 'a-dp-bad',
      }),
    );
    await call('A.discount cashier with approval', () =>
      h.discountPlaceholdersAdd({
        cart_id: cartA,
        line_id: lineA,
        placeholder_kind: 'manual_pct_10',
        approval_id: 'appr-1',
        idempotency_key: 'a-dp-1',
      }),
    );
    await call('A.discount replay a-dp-1', () =>
      h.discountPlaceholdersAdd({
        cart_id: cartA,
        line_id: lineA,
        placeholder_kind: 'manual_pct_10',
        approval_id: 'appr-1',
        idempotency_key: 'a-dp-1',
      }),
    );
    await call('A.discount second on same line', () =>
      h.discountPlaceholdersAdd({
        cart_id: cartA,
        line_id: lineA,
        placeholder_kind: 'manual_pct_5',
        approval_id: 'appr-2',
        idempotency_key: 'a-dp-dup',
      }),
    );
    await call('A.update discounted line', () =>
      h.linesUpdate({
        cart_id: cartA,
        line_id: lineA,
        op: 'increment',
        version: versionOf(snapA2, lineA),
        idempotency_key: 'a-upd-disc',
      }),
    );
    w.setSession(MANAGER);
    await call('A.discount manager on other cashier cart', () =>
      h.discountPlaceholdersAdd({
        cart_id: cartA,
        line_id: lineB,
        placeholder_kind: 'manual_amt_500',
        reason_code: 'price_correction',
        idempotency_key: 'a-dp-mgr',
      }),
    );
    w.setSession(CASHIER);
    await call('A.discount remove a-dp-1', () =>
      h.discountPlaceholdersRemove({
        cart_id: cartA,
        placeholder_id: 'a-dp-1',
        idempotency_key: 'a-dp-rm-1',
      }),
    );
    await call('A.discount re-add with approval', () =>
      h.discountPlaceholdersAdd({
        cart_id: cartA,
        line_id: lineA,
        placeholder_kind: 'manual_amt_200',
        approval_id: 'appr-3',
        reason_code: 'promotion',
        idempotency_key: 'a-dp-2',
      }),
    );

    // ── Restart mid-sale (cart editing): the add / merge / update / discount
    //    keys replay from the outbox, writing nothing ─────────────────────
    h = w.boot();
    await call('restart-1 A.add replay a-add-1', () =>
      h.linesAdd({ cart_id: cartA, item_ref: 'item-a', quantity: 2, idempotency_key: 'a-add-1' }),
    );
    await call('restart-1 A.add replay a-add-2 (merge)', () =>
      h.linesAdd({ cart_id: cartA, item_ref: 'item-a', quantity: 1, idempotency_key: 'a-add-2' }),
    );
    await call('restart-1 A.add replay a-add-2 on another item', () =>
      h.linesAdd({ cart_id: cartA, item_ref: 'item-b', quantity: 1, idempotency_key: 'a-add-2' }),
    );
    await call('restart-1 A.update replay', () =>
      h.linesUpdate({
        cart_id: cartA,
        line_id: lineB,
        op: 'increment',
        delta: 2,
        version: okNumber(addB, 'version'),
        idempotency_key: 'a-upd-1',
      }),
    );
    await call('restart-1 A.discount replay a-dp-2', () =>
      h.discountPlaceholdersAdd({
        cart_id: cartA,
        line_id: lineA,
        placeholder_kind: 'manual_amt_200',
        approval_id: 'appr-3',
        reason_code: 'promotion',
        idempotency_key: 'a-dp-2',
      }),
    );
    await call('restart-1 A.discount replay a-dp-2 other kind', () =>
      h.discountPlaceholdersAdd({
        cart_id: cartA,
        line_id: lineA,
        placeholder_kind: 'manual_amt_300',
        approval_id: 'appr-3',
        reason_code: 'promotion',
        idempotency_key: 'a-dp-2',
      }),
    );

    // ── Sale A: handoff, Back, handoff again, cancel after handoff ────────
    const snapA3 = await call('A.snapshot 3', () => h.snapshot({ cart_id: cartA }));
    await call('A.cancel before handoff', () =>
      h.cancelPostHandoff({
        cart_id: cartA,
        handoff_action_id: 'a-h-1',
        approval_id: 'appr-4',
        idempotency_key: 'a-cancel-early',
      }),
    );
    await call('A.handoff 1', () =>
      h.handoff({
        cart_id: cartA,
        per_line_versions: snapshotLines(snapA3),
        idempotency_key: 'a-h-1',
      }),
    );
    await call('A.handoff 1 replay', () =>
      h.handoff({
        cart_id: cartA,
        per_line_versions: snapshotLines(snapA3),
        idempotency_key: 'a-h-1',
      }),
    );
    await call('A.add while frozen', () =>
      h.linesAdd({ cart_id: cartA, item_ref: 'item-c', quantity: 1, idempotency_key: 'a-add-f' }),
    );
    await call('A.returnToSale eligibility', () =>
      h.returnToSaleEligibility({ cart_id: cartA, handoff_action_id: 'a-h-1' }),
    );
    await call('A.returnToSale', () =>
      h.returnToSale({ cart_id: cartA, handoff_action_id: 'a-h-1', idempotency_key: 'a-back-1' }),
    );
    await call('A.returnToSale replay', () =>
      h.returnToSale({ cart_id: cartA, handoff_action_id: 'a-h-1', idempotency_key: 'a-back-1' }),
    );
    const snapA4 = await call('A.snapshot 4', () => h.snapshot({ cart_id: cartA }));
    await call('A.handoff 2', () =>
      h.handoff({
        cart_id: cartA,
        per_line_versions: snapshotLines(snapA4),
        idempotency_key: 'a-h-2',
      }),
    );
    await call('A.cancel post-handoff stale handoff id', () =>
      h.cancelPostHandoff({
        cart_id: cartA,
        handoff_action_id: 'a-h-1',
        approval_id: 'appr-5',
        idempotency_key: 'a-cancel-stale',
      }),
    );
    await call('A.cancel post-handoff refused approval', () =>
      h.cancelPostHandoff({
        cart_id: cartA,
        handoff_action_id: 'a-h-2',
        approval_id: 'appr-bad-2',
        idempotency_key: 'a-cancel-bad',
      }),
    );
    await call('A.cancel post-handoff cashier + approval', () =>
      h.cancelPostHandoff({
        cart_id: cartA,
        handoff_action_id: 'a-h-2',
        approval_id: 'appr-6',
        idempotency_key: 'a-cancel-1',
      }),
    );
    await call('A.snapshot after cancel', () => h.snapshot({ cart_id: cartA }));

    // ── Sale B: pre-handoff void ──────────────────────────────────────────
    const cartB = okString(
      await call('B.create', () => h.create({ idempotency_key: 'b-create' })),
      'cart_id',
    );
    await call('B.add item-b x3', () =>
      h.linesAdd({ cart_id: cartB, item_ref: 'item-b', quantity: 3, idempotency_key: 'b-add-1' }),
    );
    await call('B.void', () => h.void({ cart_id: cartB, idempotency_key: 'b-void-1' }));
    await call('B.void replay', () => h.void({ cart_id: cartB, idempotency_key: 'b-void-1' }));

    // ── Sale C: handed off, then cancelled by a manager directly ──────────
    const cartC = okString(
      await call('C.create', () => h.create({ idempotency_key: 'c-create' })),
      'cart_id',
    );
    const addC1 = await call('C.add item-a x1', () =>
      h.linesAdd({ cart_id: cartC, item_ref: 'item-a', quantity: 1, idempotency_key: 'c-add-1' }),
    );
    await call('C.handoff', () =>
      h.handoff({
        cart_id: cartC,
        per_line_versions: [
          { line_id: okString(addC1, 'line_id'), version: okNumber(addC1, 'version') },
        ],
        idempotency_key: 'c-h-1',
      }),
    );
    w.setSession(MANAGER);
    await call('C.cancel post-handoff manager', () =>
      h.cancelPostHandoff({ cart_id: cartC, handoff_action_id: 'c-h-1', idempotency_key: 'c-x-1' }),
    );
    w.setSession(CASHIER);

    // ── Restart after the sale: the handoff / cancel / void keys replay ───
    h = w.boot();
    await call('restart A.add replay a-add-1 on cancelled cart', () =>
      h.linesAdd({ cart_id: cartA, item_ref: 'item-a', quantity: 2, idempotency_key: 'a-add-1' }),
    );
    await call('restart A.handoff replay a-h-2', () =>
      h.handoff({
        cart_id: cartA,
        per_line_versions: snapshotLines(snapA4),
        idempotency_key: 'a-h-2',
      }),
    );
    await call('restart A.cancel replay a-cancel-1', () =>
      h.cancelPostHandoff({
        cart_id: cartA,
        handoff_action_id: 'a-h-2',
        approval_id: 'appr-6',
        idempotency_key: 'a-cancel-1',
      }),
    );
    await call('restart A.cancel replay other handoff', () =>
      h.cancelPostHandoff({
        cart_id: cartA,
        handoff_action_id: 'a-h-1',
        approval_id: 'appr-6',
        idempotency_key: 'a-cancel-1',
      }),
    );
    await call('restart C.cancel replay on cart A key', () =>
      h.cancelPostHandoff({
        cart_id: cartC,
        handoff_action_id: 'c-h-1',
        approval_id: 'appr-7',
        idempotency_key: 'a-cancel-1',
      }),
    );
    await call('restart B.void replay', () =>
      h.void({ cart_id: cartB, idempotency_key: 'b-void-1' }),
    );
    w.setSession(null);
    await call('no session add', () =>
      h.linesAdd({ cart_id: cartA, item_ref: 'item-a', quantity: 1, idempotency_key: 'z-1' }),
    );
    w.setSession(CASHIER);
    await call('restart A.snapshot', () => h.snapshot({ cart_id: cartA }));
    await call('restart C.snapshot', () => h.snapshot({ cart_id: cartC }));

    const tables = dumpTables(w.db);
    const outboxPayloads = (tables['cart_action_outbox'] ?? []).map((row) => {
      const r = row as { action_id: string; action_kind: string; payload_json: string };
      return `${r.action_id} ${r.action_kind} ${r.payload_json}`;
    });
    const golden = JSON.stringify(
      { steps, approvalsConsumed: w.approvals, outboxPayloads, tables },
      null,
      2,
    );

    // Sanity: the script really exercised the paths the split touches.
    const kinds = new Set(
      (tables['cart_action_outbox'] ?? []).map((r) => (r as { action_kind: string }).action_kind),
    );
    for (const kind of [
      'cart.line.add',
      'cart.line.merge',
      'cart.discount_placeholder.add',
      'cart.handoff_to_payment',
      'cart.return_to_sale',
      'cart.cancel.post_handoff',
    ]) {
      expect(kinds, kind).toContain(kind);
    }

    await expect(`${golden}\n`).toMatchFileSnapshot(GOLDEN);
  });
});
