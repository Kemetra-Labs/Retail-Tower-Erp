/**
 * RT-1490 — the `unknown_item_captures` store on the real migrated schema.
 *
 *   • enqueue writes one pending row; the same barcode the same store day is
 *     capped (no second row, no new key), another day or store is a new row;
 *   • the queue survives a restart: a new binding over the same database sees
 *     the pending rows with the same keys;
 *   • listDue returns only the current pairing's pending rows whose next
 *     attempt is due, oldest first;
 *   • settling: sent and refused rows leave the queue; a retry bumps attempts
 *     and moves the next attempt;
 *   • isKnownBarcode tells a code the local catalogue has (active or not) from
 *     an unknown one.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
  seedBarcode,
  seedProduct,
} from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import { bindUnknownItemCaptureStore, type CaptureScope } from '../capture-store.js';

const SCOPE: CaptureScope = {
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  terminalId: 'terminal-1',
};
const ID_1 = '0192f5a2-3b4c-7d8e-9f01-000000000001';
const ID_2 = '0192f5a2-3b4c-7d8e-9f01-000000000002';
const ID_3 = '0192f5a2-3b4c-7d8e-9f01-000000000003';
const T0 = '2026-11-19T10:00:00.000Z';
const T1 = '2026-11-19T10:05:00.000Z';

let db: SqlJsDatabase;

beforeAll(async () => {
  await initCatalogueSql();
});

beforeEach(() => {
  db = freshCatalogueDb();
});

afterEach(() => {
  db.close();
});

function store() {
  return bindUnknownItemCaptureStore(handleFor(db));
}

function enqueue(
  s: ReturnType<typeof store>,
  captureId: string,
  barcode = '6221000000099',
  o: { day?: string; scope?: CaptureScope; at?: string } = {},
) {
  return s.enqueue({
    captureId,
    scope: o.scope ?? SCOPE,
    barcode,
    day: o.day ?? '2026-11-19',
    at: o.at ?? T0,
  });
}

function rowCount(): number {
  return Number(db.exec('SELECT COUNT(*) FROM unknown_item_captures')[0]?.values[0]?.[0]);
}

describe('RT-1490 — unknown item capture store', () => {
  it('enqueues one pending row, due at once', () => {
    const s = store();
    expect(enqueue(s, ID_1)).toBe('queued');
    expect(s.listDue(SCOPE, T0, 10)).toEqual([
      { capture_id: ID_1, barcode: '6221000000099', attempts: 0 },
    ]);
  });

  it('caps the same barcode to one row per store per day', () => {
    const s = store();
    expect(enqueue(s, ID_1)).toBe('queued');
    expect(enqueue(s, ID_2)).toBe('capped');
    expect(rowCount()).toBe(1);
    // The day's row keeps its first key: a rescan never mints a new request.
    expect(s.listDue(SCOPE, T0, 10).map((r) => r.capture_id)).toEqual([ID_1]);
  });

  it('caps even after the day row was sent or refused', () => {
    const s = store();
    enqueue(s, ID_1);
    s.markSent(ID_1, 201, T1);
    expect(enqueue(s, ID_2)).toBe('capped');
    expect(rowCount()).toBe(1);
  });

  it('takes the same barcode again on another day or at another store', () => {
    const s = store();
    enqueue(s, ID_1);
    expect(enqueue(s, ID_2, '6221000000099', { day: '2026-11-20' })).toBe('queued');
    expect(enqueue(s, ID_3, '6221000000099', { scope: { ...SCOPE, branchId: 'branch-2' } })).toBe(
      'queued',
    );
    expect(rowCount()).toBe(3);
  });

  it('survives a restart: a new binding sees the queued rows with their keys', () => {
    enqueue(store(), ID_1);
    enqueue(store(), ID_2, '123456');
    const afterRestart = store();
    expect(afterRestart.listDue(SCOPE, T0, 10).map((r) => r.capture_id)).toEqual([ID_1, ID_2]);
  });

  it('lists only the current pairing, oldest first, up to the limit', () => {
    const s = store();
    enqueue(s, ID_2, '222', { at: T1 });
    enqueue(s, ID_1, '111', { at: T0 });
    enqueue(s, ID_3, '333', { scope: { ...SCOPE, terminalId: 'terminal-old' } });
    expect(s.listDue(SCOPE, T1, 10).map((r) => r.capture_id)).toEqual([ID_1, ID_2]);
    expect(s.listDue(SCOPE, T1, 1).map((r) => r.capture_id)).toEqual([ID_1]);
    expect(s.listDue({ ...SCOPE, tenantId: 'tenant-2' }, T1, 10)).toEqual([]);
  });

  it('drops sent and refused rows from the queue', () => {
    const s = store();
    enqueue(s, ID_1, '111');
    enqueue(s, ID_2, '222');
    s.markSent(ID_1, 201, T1);
    s.markRefused(ID_2, 400, T1);
    expect(s.listDue(SCOPE, T1, 10)).toEqual([]);
    expect(
      db.exec(
        'SELECT capture_id, state, last_status, settled_at FROM unknown_item_captures ORDER BY capture_id',
      )[0]?.values,
    ).toEqual([
      [ID_1, 'sent', 201, T1],
      [ID_2, 'refused', 400, T1],
    ]);
  });

  it('a retry bumps attempts and holds the row until its next attempt', () => {
    const s = store();
    enqueue(s, ID_1);
    s.markRetry(ID_1, 503, T1);
    expect(s.listDue(SCOPE, T0, 10)).toEqual([]);
    expect(s.listDue(SCOPE, T1, 10)).toEqual([
      { capture_id: ID_1, barcode: '6221000000099', attempts: 1 },
    ]);
    s.markRetry(ID_1, null, T1);
    expect(s.listDue(SCOPE, T1, 10)[0]?.attempts).toBe(2);
  });

  it('knows a barcode the local catalogue has, active or not', () => {
    seedProduct(db, { product_id: 'p-on', active: 1 });
    seedBarcode(db, { barcode_id: 'bc-on', product_id: 'p-on', barcode: '111' });
    seedProduct(db, { product_id: 'p-off', sku: 'SKU-OFF', active: 0 });
    seedBarcode(db, { barcode_id: 'bc-off', product_id: 'p-off', barcode: '222' });
    const s = store();
    expect(s.isKnownBarcode('tenant-1', '111')).toBe(true);
    expect(s.isKnownBarcode('tenant-1', ' 222 ')).toBe(true);
    expect(s.isKnownBarcode('tenant-1', '333')).toBe(false);
    expect(s.isKnownBarcode('tenant-2', '111')).toBe(false);
  });
});
