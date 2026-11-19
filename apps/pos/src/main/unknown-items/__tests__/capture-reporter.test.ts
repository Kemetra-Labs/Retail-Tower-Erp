/**
 * RT-1490 — the scan-side reporter: what a `not_found` barcode lookup queues.
 *
 *   • one pending row, keyed by a fresh UUIDv7, on the store business day of
 *     the scan (Africa/Cairo), under the session's tenant and store and the
 *     paired terminal;
 *   • a rescan the same day queues nothing more (the cap);
 *   • nothing for a code the local catalogue has on an inactive product (that
 *     is `disabled`, not unknown), for an empty or over-long code, or while
 *     unpaired;
 *   • it never throws into the scan: a failing store is reported and swallowed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
  seedBarcode,
  seedProduct,
} from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import { createUnknownBarcodeReporter } from '../capture-reporter.js';
import { bindUnknownItemCaptureStore, type UnknownItemCaptureStore } from '../capture-store.js';

const SESSION = { tenant_id: 'tenant-1', branch_id: 'branch-1' };
// 23:30 UTC on the 18th is already the 19th in Cairo (UTC+2).
const SCAN_AT = new Date('2026-11-18T23:30:00.000Z');

let db: SqlJsDatabase;
let ids: number;

beforeAll(async () => {
  await initCatalogueSql();
});

beforeEach(() => {
  db = freshCatalogueDb();
  ids = 0;
});

afterEach(() => {
  db.close();
});

function rows(): unknown[][] {
  return (
    db.exec(
      'SELECT capture_id, tenant_id, branch_id, terminal_id, barcode, capture_day, state, enqueued_at FROM unknown_item_captures',
    )[0]?.values ?? []
  );
}

function reporter(
  o: { terminalId?: string | null; store?: UnknownItemCaptureStore; onError?: () => void } = {},
) {
  return createUnknownBarcodeReporter({
    store: o.store ?? bindUnknownItemCaptureStore(handleFor(db)),
    terminalId: () => (o.terminalId === undefined ? 'terminal-1' : o.terminalId),
    now: () => SCAN_AT,
    mintId: () => `0192f5a2-3b4c-7d8e-9f01-${String((ids += 1)).padStart(12, '0')}`,
    onError: o.onError ?? (() => undefined),
  });
}

describe('RT-1490 — unknown barcode reporter', () => {
  it('queues one capture for an unknown barcode on the store business day', () => {
    reporter()(' 6221000000099 ', SESSION);
    expect(rows()).toEqual([
      [
        '0192f5a2-3b4c-7d8e-9f01-000000000001',
        'tenant-1',
        'branch-1',
        'terminal-1',
        '6221000000099',
        '2026-11-19',
        'pending',
        SCAN_AT.toISOString(),
      ],
    ]);
  });

  it('queues nothing more for a rescan the same day', () => {
    const report = reporter();
    report('6221000000099', SESSION);
    report('6221000000099', SESSION);
    report('6221000000099', SESSION);
    expect(rows()).toHaveLength(1);
  });

  it('queues nothing for a code the catalogue has on an inactive product', () => {
    seedProduct(db, { product_id: 'p-off', active: 0 });
    seedBarcode(db, { product_id: 'p-off', barcode: '6221000000099' });
    reporter()('6221000000099', SESSION);
    expect(rows()).toEqual([]);
  });

  it.each([
    ['an empty code', '   '],
    ['a code over 200 characters', '9'.repeat(201)],
  ])('queues nothing for %s', (_name, code) => {
    reporter()(code, SESSION);
    expect(rows()).toEqual([]);
  });

  it('queues nothing while unpaired', () => {
    reporter({ terminalId: null })('6221000000099', SESSION);
    expect(rows()).toEqual([]);
  });

  it('never throws into the scan', () => {
    const onError = vi.fn();
    const broken = {
      ...bindUnknownItemCaptureStore(handleFor(db)),
      enqueue: () => {
        throw new Error('disk full');
      },
    };
    expect(() => {
      reporter({ store: broken, onError })('6221000000099', SESSION);
    }).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
