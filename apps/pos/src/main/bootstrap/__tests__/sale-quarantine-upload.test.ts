import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
} from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import { seedOutbox, seedSale } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createSaleSyncStateRepo } from '../../sales-sync/sale-sync-state-repo.js';
import type { SellingUserIdResolver } from '../../sales-sync/selling-user-id.js';
import type {
  QuarantineUploadBody,
  QuarantineUploadClient,
  QuarantineUploadOutcome,
} from '../../quarantine-upload/quarantine-upload-client.js';
import { bindQuarantineUploadStore } from '../../quarantine-upload/quarantine-upload-store.js';
import { startSaleQuarantineUpload } from '../sale-quarantine-upload.js';

vi.mock('../env.js', () => ({ resolveApiBaseUrl: () => 'https://bc.test' }));

/**
 * RT-1312 Phase 3(c) — the uploader's wiring on a real migrated database: the
 * pairing, the gate, the log lines, the closed-set reasons and the failure paths.
 * (The heartbeat integration is in `device-heartbeat.test.ts`.)
 */

beforeAll(async () => {
  await initCatalogueSql();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-19T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const TERMINAL = { tenant_id: 't1', branch_id: 'b1' };
const PASS_MS = 60_000;

const DISCOUNT_LINES = JSON.stringify([
  {
    line_id: 'l-1',
    item_ref: 'p-1',
    display_name: 'Panadol',
    quantity: 1,
    unit_price_minor: 1500,
    line_subtotal_minor: 1500,
    discount: { kind: 'percent', value: 10, amount_minor: 150 },
  },
]);

function setup(
  opts: {
    terminalId?: string | null;
    answers?: QuarantineUploadOutcome[];
    revision?: number | null;
    sellingUsers?: SellingUserIdResolver;
  } = {},
) {
  const db = freshCatalogueDb();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sent: QuarantineUploadBody[] = [];
  const answers = [...(opts.answers ?? [])];
  const client: QuarantineUploadClient = {
    upload: (_token, body) => {
      sent.push(body);
      return Promise.resolve(answers.shift() ?? { kind: 'uploaded', status: 201, receipt: null });
    },
  };
  const store = bindQuarantineUploadStore(handleFor(db));
  const stop = startSaleQuarantineUpload(
    {
      db: handleFor(db),
      store,
      backendFetch: () => Promise.reject(new Error('the client is a seam in this test')),
      readSendableDeviceToken: () => Promise.resolve('device-token'),
      pairingStore: {
        getCurrentTerminalId: () => (opts.terminalId === undefined ? 'term-1' : opts.terminalId),
      },
      mainLogger: logger as never,
      client,
      ...(opts.sellingUsers === undefined ? {} : { sellingUsers: opts.sellingUsers }),
    },
    TERMINAL,
    () => (opts.revision === undefined ? 3 : opts.revision),
  );
  const strand = (saleId: string, o: { lines?: string } = {}) => {
    const scope = { ...TERMINAL, terminal_id: 'term-1' };
    seedSale(db, {
      sale_id: saleId,
      tenant_id: 't1',
      branch_id: 'b1',
      terminal_id: 'term-1',
      ...(o.lines === undefined ? {} : { lines_json: o.lines }),
    });
    seedOutbox(db, {
      sale_id: saleId,
      tenant_id: 't1',
      branch_id: 'b1',
      terminal_id: scope.terminal_id,
    });
    createSaleSyncStateRepo(handleFor(db)).markDeadLetter({
      saleId,
      tenantId: 't1',
      branchId: 'b1',
      now: '2026-11-19T09:00:00.000Z',
    });
  };
  const rows = (): unknown[][] =>
    db.exec('SELECT sale_id, state, last_status FROM sale_quarantine_upload ORDER BY sale_id')[0]
      ?.values ?? [];
  return { db, logger, sent, stop, strand, rows, store };
}

describe('RT-1312 Phase 3(c) — startSaleQuarantineUpload', () => {
  it('uploads a stranded sale after one pass interval and logs the status only', async () => {
    const t = setup();
    t.strand('s1');
    await vi.advanceTimersByTimeAsync(PASS_MS);
    expect(t.sent).toHaveLength(1);
    expect(t.rows()).toEqual([['s1', 'uploaded', 201]]);
    expect(t.logger.info).toHaveBeenCalledWith(
      { sale_id: 's1', status: 201 },
      'quarantine_upload:uploaded',
    );
    expect(JSON.stringify(t.logger.info.mock.calls)).not.toContain('device-token');
    t.stop();
  });

  it('does nothing while unpaired', async () => {
    const t = setup({ terminalId: null });
    t.strand('s1');
    await vi.advanceTimersByTimeAsync(PASS_MS * 3);
    expect(t.sent).toHaveLength(0);
    expect(t.rows()).toEqual([]);
    t.stop();
  });

  it('does nothing before the revision is advertised', async () => {
    const t = setup({ revision: null });
    t.strand('s1');
    await vi.advanceTimersByTimeAsync(PASS_MS * 3);
    expect(t.sent).toHaveLength(0);
    t.stop();
  });

  it('marks a final refusal refused and logs it with the status', async () => {
    const t = setup({ answers: [{ kind: 'refused', status: 409 }] });
    t.strand('s1');
    await vi.advanceTimersByTimeAsync(PASS_MS);
    expect(t.rows()).toEqual([['s1', 'refused', 409]]);
    expect(t.logger.warn).toHaveBeenCalledWith(
      { sale_id: 's1', status: 409 },
      'quarantine_upload:refused',
    );
    t.stop();
  });

  it('reports a sale it cannot build once, parks it, and goes on', async () => {
    const t = setup();
    t.strand('bad', { lines: 'not json' });
    t.strand('good');
    await vi.advanceTimersByTimeAsync(PASS_MS);
    expect(t.logger.warn).toHaveBeenCalledWith(
      { sale_id: 'bad', reason: 'not_sendable' },
      'quarantine_upload:skipped',
    );
    expect(t.rows()).toEqual([
      ['bad', 'pending', null],
      ['good', 'uploaded', 201],
    ]);
    // Parked for an hour: the next passes do not report it again.
    await vi.advanceTimersByTimeAsync(PASS_MS * 5);
    expect(
      t.logger.warn.mock.calls.filter((c) => c[1] === 'quarantine_upload:skipped'),
    ).toHaveLength(1);
    t.stop();
  });

  it('skips a discounted sale whose approver role is not recorded', async () => {
    const t = setup();
    t.strand('discounted', { lines: DISCOUNT_LINES });
    await vi.advanceTimersByTimeAsync(PASS_MS);
    expect(t.sent).toHaveLength(0);
    expect(t.logger.warn).toHaveBeenCalledWith(
      { sale_id: 'discounted', reason: 'not_sendable' },
      'quarantine_upload:skipped',
    );
    t.stop();
  });

  it('holds a sale whose cashier cannot be proven, instead of sending it under another identity', async () => {
    const sellingUsers: SellingUserIdResolver = {
      resolve: () => new Map(),
      forget: () => undefined,
    };
    const t = setup({ sellingUsers });
    t.strand('s1');
    await vi.advanceTimersByTimeAsync(PASS_MS);
    expect(t.sent).toHaveLength(0);
    expect(t.logger.warn).toHaveBeenCalledWith(
      { sale_id: 's1', reason: 'cashier_unresolved' },
      'quarantine_upload:skipped',
    );
    t.stop();
  });

  it('logs the selling-user lookup failure without a sale', async () => {
    const t = setup();
    t.strand('s1');
    t.db.exec('DROP TABLE audit_events');
    await vi.advanceTimersByTimeAsync(PASS_MS);
    expect(t.logger.warn).toHaveBeenCalledWith({}, 'quarantine_upload:selling_user_lookup_failed');
    t.stop();
  });

  it('survives an unexpected failure: logged, and the next pass runs', async () => {
    const t = setup();
    t.strand('s1');
    t.db.exec('DROP TABLE sale_quarantine_upload');
    await vi.advanceTimersByTimeAsync(PASS_MS);
    expect(t.logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) as Error },
      'quarantine_upload:drain_unexpected',
    );
    t.stop();
  });

  it('stops: no timer is left and nothing more is sent', async () => {
    const t = setup();
    t.stop();
    t.strand('s1');
    await vi.advanceTimersByTimeAsync(PASS_MS * 3);
    expect(t.sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
