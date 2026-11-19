/**
 * RT-1490 — `catalogue.lookupBarcode` tells the unknown-item reporter about a
 * `not_found` scan, and only that.
 *
 *   • `not_found` → the hook is called once with the raw barcode and the
 *     session's tenant and store; the response is unchanged;
 *   • `one`, `ambiguous`, `catalogue_unavailable`, a refused (no session)
 *     lookup and an SKU lookup → no call;
 *   • a hook that throws never changes or fails the lookup.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import { createCatalogueBridge } from '../catalogue-bridge.js';
import { createProductRepo } from '../product-repo.js';
import type { OperatorSessionForCatalogue } from '../require-catalogue-session.js';
import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
  seedBarcode,
  seedProduct,
} from './__helpers__/catalogue-fixture.js';

const SESSION: OperatorSessionForCatalogue = {
  role: 'cashier',
  operator_id: 'op-1',
  operator_session_id: 'sess-1',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
};

beforeAll(async () => {
  await initCatalogueSql();
});

function populated(): SqlJsDatabase {
  const db = freshCatalogueDb();
  seedProduct(db, { product_id: 'p-1' });
  seedBarcode(db, { barcode_id: 'bc-1', product_id: 'p-1', barcode: '111' });
  seedProduct(db, { product_id: 'p-2', sku: 'SKU-2' });
  seedBarcode(db, { barcode_id: 'bc-2', product_id: 'p-2', barcode: 'SHARED' });
  seedBarcode(db, { barcode_id: 'bc-3', product_id: 'p-1', barcode: 'SHARED' });
  return db;
}

function bridge(
  db: SqlJsDatabase | null,
  onBarcodeNotFound: (barcode: string, session: OperatorSessionForCatalogue) => void,
  session: OperatorSessionForCatalogue | null = SESSION,
) {
  return createCatalogueBridge({
    getCurrentSession: () => session,
    ...(db === null ? {} : { productRepo: createProductRepo(handleFor(db)) }),
    onBarcodeNotFound,
  });
}

describe('RT-1490 — lookupBarcode reports a not_found scan', () => {
  it('calls the hook once for not_found, with the barcode and the session', async () => {
    const db = populated();
    const hook = vi.fn();
    const r = await bridge(db, hook).lookupBarcode({ barcode: '999' });
    expect(r).toEqual({ kind: 'not_found' });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith('999', SESSION);
    db.close();
  });

  it.each([
    ['one', '111'],
    ['ambiguous', 'SHARED'],
  ])('does not call it for %s', async (kind, barcode) => {
    const db = populated();
    const hook = vi.fn();
    expect((await bridge(db, hook).lookupBarcode({ barcode })).kind).toBe(kind);
    expect(hook).not.toHaveBeenCalled();
    db.close();
  });

  it('does not call it while the catalogue is unavailable', async () => {
    const hook = vi.fn();
    const empty = freshCatalogueDb();
    expect((await bridge(empty, hook).lookupBarcode({ barcode: '999' })).kind).toBe(
      'catalogue_unavailable',
    );
    expect((await bridge(null, hook).lookupBarcode({ barcode: '999' })).kind).toBe(
      'catalogue_unavailable',
    );
    expect(hook).not.toHaveBeenCalled();
    empty.close();
  });

  it('does not call it for a refused lookup (no session)', async () => {
    const db = populated();
    const hook = vi.fn();
    expect((await bridge(db, hook, null).lookupBarcode({ barcode: '999' })).kind).toBe('refused');
    expect(hook).not.toHaveBeenCalled();
    db.close();
  });

  it('does not call it for an SKU lookup', async () => {
    const db = populated();
    const hook = vi.fn();
    expect((await bridge(db, hook).lookupSku({ sku: 'NOPE' })).kind).toBe('not_found');
    expect(hook).not.toHaveBeenCalled();
    db.close();
  });

  it('a throwing hook never changes or fails the lookup', async () => {
    const db = populated();
    const hook = vi.fn(() => {
      throw new Error('boom');
    });
    await expect(bridge(db, hook).lookupBarcode({ barcode: '999' })).resolves.toEqual({
      kind: 'not_found',
    });
    db.close();
  });
});
