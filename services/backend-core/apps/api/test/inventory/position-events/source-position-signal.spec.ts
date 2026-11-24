/**
 * source-position-signal.spec.ts — Jira RT-1584 (RT-1125 R-30, R-31).
 *
 * A status move or relocation subtracts and adds the same quantity at one
 * store, so the product's store on-hand never changes and the FR-024
 * `flagIfNegativeOnHand` probe can never fire for it. The signal therefore
 * reads the SOURCE position (store, product, location, status, identity): when
 * the move left it below zero, the probe answers `true` and increments
 * `inventory_position_negative_total`. Allow-and-flag: the probe never throws;
 * any failed statement is rolled back to its own savepoint, logged, and
 * answered `null` (unknown), never a false "not negative".
 *
 * Layer: unit, fake client (no I/O). The real-database path is in
 * position-events.spec.ts (Docker-gated).
 */
jest.mock('../../../src/inventory/position-events/position-events.metrics', () => {
  const actual = jest.requireActual('../../../src/inventory/position-events/position-events.metrics');
  return { ...actual, recordInventoryPositionNegative: jest.fn() };
});

const mockWarn = jest.fn();
jest.mock('../../../src/common/api-logger', () => ({
  createApiLogger: () => ({ warn: mockWarn }),
}));

import type { PoolClient } from 'pg';

import { recordInventoryPositionNegative } from '../../../src/inventory/position-events/position-events.metrics';
import { flagIfSourcePositionNegative } from '../../../src/inventory/position-events/source-position.signal';

const recordPositionNegative = recordInventoryPositionNegative as jest.MockedFunction<
  typeof recordInventoryPositionNegative
>;

const SOURCE = {
  storeId: '0a000000-0000-7000-8000-000001584a01',
  tenantProductRef: '0a000000-0000-7000-8000-000001584a02',
  fromLocationId: '0a000000-0000-7000-8000-000001584a03',
  fromStatus: 'sellable',
  trackingIdentityId: null,
} as const;

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

type Step = 'SAVEPOINT' | 'SELECT' | 'RELEASE' | 'ROLLBACK';

function stepOf(sql: string): Step {
  const head = sql.trim().split(/\s+/)[0]!.toUpperCase();
  return (head === 'SELECT' ? 'SELECT' : head) as Step;
}

/** A fake client: the probe answers `negative`; any step in `failAt` throws. */
function fakeClient(answer: { negative?: boolean; failAt?: readonly Step[] }): {
  client: PoolClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const query = jest.fn(async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params });
    const step = stepOf(sql);
    if (answer.failAt?.includes(step)) {
      throw Object.assign(new Error(`${step} failed`), { code: '57014' });
    }
    return step === 'SELECT' ? { rows: [{ negative: answer.negative ?? false }] } : { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, calls };
}

beforeEach(() => {
  recordPositionNegative.mockClear();
  mockWarn.mockClear();
});

describe('RT-1584 source-position negative signal', () => {
  it('reports and counts a source position the move left below zero', async () => {
    const { client } = fakeClient({ negative: true });

    await expect(flagIfSourcePositionNegative(client, SOURCE)).resolves.toBe(true);
    expect(recordPositionNegative).toHaveBeenCalledTimes(1);
  });

  it('does not report or count a source position at zero or above', async () => {
    const { client } = fakeClient({ negative: false });

    await expect(flagIfSourcePositionNegative(client, SOURCE)).resolves.toBe(false);
    expect(recordPositionNegative).not.toHaveBeenCalled();
  });

  it('reads exactly the source position, and compares the unnarrowed sum with zero in SQL', async () => {
    const { client, calls } = fakeClient({ negative: false });

    await flagIfSourcePositionNegative(client, SOURCE);

    const probe = calls.find((c) => stepOf(c.sql) === 'SELECT');
    expect(probe?.params).toEqual([
      SOURCE.storeId,
      SOURCE.tenantProductRef,
      SOURCE.fromLocationId,
      SOURCE.fromStatus,
      SOURCE.trackingIdentityId,
    ]);
    // A movement recorded before positions existed reads as (primary, sellable).
    expect(probe?.sql).toMatch(/COALESCE\(\s*(\w+\.)?inventory_status,\s*'sellable'\s*\)/);
    expect(probe?.sql).toMatch(/kind\s*=\s*'primary'/);
    expect(probe?.sql).toMatch(/tracking_identity_id IS NOT DISTINCT FROM/);
    // No numeric(19,4) narrowing that a large negative sum could overflow.
    expect(probe?.sql).toMatch(/COALESCE\(SUM\(m\.quantity\), 0\) < 0/);
    expect(probe?.sql).not.toMatch(/numeric\(19,\s*4\)/);
  });

  it('runs the probe inside a savepoint it releases on success', async () => {
    const { client, calls } = fakeClient({ negative: true });

    await flagIfSourcePositionNegative(client, SOURCE);

    expect(calls.map((c) => stepOf(c.sql))).toEqual(['SAVEPOINT', 'SELECT', 'RELEASE']);
  });

  it.each<[string, readonly Step[]]>([
    ['the SELECT', ['SELECT']],
    ['the RELEASE', ['RELEASE']],
    ['the SAVEPOINT', ['SAVEPOINT']],
    ['the SELECT and the ROLLBACK', ['SELECT', 'ROLLBACK']],
  ])('never throws when %s fails: rolls back, logs, answers null, counts nothing', async (_label, failAt) => {
    const { client, calls } = fakeClient({ negative: true, failAt });

    await expect(flagIfSourcePositionNegative(client, SOURCE)).resolves.toBeNull();

    expect(recordPositionNegative).not.toHaveBeenCalled();
    expect(calls.map((c) => stepOf(c.sql))).toContain('ROLLBACK');
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0]![0]).toEqual({
      event: 'inventory.position_negative.probe_failed',
      error_class: 'Error',
      pg_code: '57014',
    });
  });
});
