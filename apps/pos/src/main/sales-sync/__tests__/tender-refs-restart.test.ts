/**
 * RT-363 fix-forward — the body of a sale that may already have been sent never changes across
 * restarts, whatever the environment does. Backend-Core answers 409 to a different body under
 * the same Idempotency-Key, so a sale retrying after a restart must rebuild the SAME bytes.
 *
 * Every "start" below runs the real boot write (`recordTenderRefsCutoverOnce`), the real read
 * (`readTenderRefsSince`) and the real body build on a migrated database, as the main process
 * does; only the environment and the clock change between starts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import { buildCapturePayload } from '../capture-payload.js';
import { toWireBody } from '../create-sale-sync-client.js';
import {
  TENDER_REFS_SINCE_ENV,
  readTenderRefsSince,
  recordTenderRefsCutoverOnce,
} from '../tender-refs-cutoff.js';
import { bindSalesRepository, type SaleRow } from '../../sales/repositories/sales.repository.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';

const TENDERS_SINCE = '2026-01-01T00:00:00.000Z'; // the 0062 instant, long past
const L1 = 'a1111111-1111-4111-8111-111111111111';
const L2 = 'b2222222-2222-4222-8222-222222222222';
const SPLIT = JSON.stringify([
  { tender_type: 'cash', amount_applied_minor: 1000, tender_line_id: L1, sequence: 1 },
  { tender_type: 'cash', amount_applied_minor: 500, tender_line_id: L2, sequence: 2 },
]);

let db: SqlJsDatabase;

beforeAll(async () => {
  await initSalesSyncSql();
});
beforeEach(() => {
  db = freshSalesSyncDb();
});
afterEach(() => {
  db.close();
});

/** One start of the main process: the boot write, then the read the engine does. */
function start(env: string | undefined, now: string): string | null {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const handle = handleFor(db);
  recordTenderRefsCutoverOnce({
    db: handle,
    env: { [TENDER_REFS_SINCE_ENV]: env },
    now: () => new Date(now),
    logger,
  });
  return readTenderRefsSince(handle, logger);
}

function saleOf(saleId: string): SaleRow {
  const row = bindSalesRepository(handleFor(db)).readById(saleId);
  if (row === null) throw new Error(`sale ${saleId} not found`);
  return row;
}

/** The exact bytes the client would POST for the sale under this start's cutoff. */
function bodyOf(saleId: string, tenderRefsSince: string | null): string {
  const payload = buildCapturePayload(saleOf(saleId), {
    tendersSince: TENDERS_SINCE,
    tenderRefsSince,
  });
  return JSON.stringify(toWireBody(payload, 'EGP'));
}

describe('a sale already attempted keeps its body across restarts (RT-363 fix-forward)', () => {
  it('turning the cutoff on later, with a value earlier than the sale, does not change the sale body; a later sale splits, and stays split', () => {
    // Start 1: no opt-in. The sale is finalized, attempted and left retrying: its merged body.
    seedSale(db, {
      sale_id: 's-sent',
      finalized_at: '2026-11-21T10:00:00.000Z',
      tender_lines_summary_json: SPLIT,
    });
    expect(start(undefined, '2026-11-21T11:00:00.000Z')).toBeNull();
    const sent = bodyOf('s-sent', null);
    expect(sent).not.toContain('tenderRef');

    // Start 2: the operator sets the variable to an instant BEFORE that sale. Read as it is,
    // that value would split the sale already sent (a 409 on its retry): the stored instant is
    // moved past the clock and the sale.
    const since = start('2020-01-01T00:00:00Z', '2026-11-21T12:00:00.000Z');
    expect(since).toBe('2026-11-21T12:00:00.000Z');
    expect(bodyOf('s-sent', '2020-01-01T00:00:00.000Z')).not.toBe(sent); // the hazard is real
    expect(bodyOf('s-sent', since)).toBe(sent);

    // A sale finalized after the instant goes out split.
    seedSale(db, {
      sale_id: 's-new',
      finalized_at: '2026-11-21T12:30:00.000Z',
      tender_lines_summary_json: SPLIT,
    });
    const split = bodyOf('s-new', since);
    expect(split).toContain(`"tenderRef":"${L1}"`);
    expect(split).toContain('"sequence":2');

    // Later starts: the variable removed, lost, earlier, later or garbage. Nothing moves.
    for (const [env, now] of [
      [undefined, '2026-11-22T08:00:00.000Z'],
      ['', '2026-11-22T09:00:00.000Z'],
      ['2020-01-01T00:00:00Z', '2026-11-23T09:00:00.000Z'],
      ['2030-01-01T00:00:00Z', '2026-11-24T09:00:00.000Z'],
      ['garbage', '2026-11-25T09:00:00.000Z'],
      [undefined, '2025-01-01T00:00:00.000Z'], // the clock went backwards
    ] as const) {
      const again = start(env, now);
      expect(again, String(env)).toBe(since);
      expect(bodyOf('s-sent', again), `sent / ${String(env)}`).toBe(sent);
      expect(bodyOf('s-new', again), `split / ${String(env)}`).toBe(split);
    }
  });

  it('without an opt-in no start ever splits a sale, even after the variable was once set invalid', () => {
    seedSale(db, {
      sale_id: 's-1',
      finalized_at: '2026-11-21T12:30:00.000Z',
      tender_lines_summary_json: SPLIT,
    });
    const merged = bodyOf('s-1', null);
    for (const env of [undefined, 'garbage', '2026-12-01']) {
      const since = start(env, '2026-11-21T13:00:00.000Z');
      expect(since).toBeNull();
      expect(bodyOf('s-1', since)).toBe(merged);
    }
  });

  it('a sale finalized between the opt-in start and the next one is split the same way at both', () => {
    start('2026-11-21T12:00:00Z', '2026-11-21T12:00:00.000Z');
    seedSale(db, {
      sale_id: 's-after',
      finalized_at: '2026-11-21T12:00:00.001Z',
      tender_lines_summary_json: SPLIT,
    });
    const first = bodyOf('s-after', readTenderRefsSince(handleFor(db), { warn: vi.fn() }));
    const next = start(undefined, '2026-11-21T18:00:00.000Z');
    expect(bodyOf('s-after', next)).toBe(first);
    expect(first).toContain(`"tenderRef":"${L2}"`);
  });
});
