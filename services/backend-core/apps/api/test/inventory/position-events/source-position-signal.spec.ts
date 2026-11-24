/**
 * source-position-signal.spec.ts — Jira RT-1584 (RT-1125 R-30, R-31).
 *
 * A status move or relocation subtracts and adds the same quantity at one
 * store, so the product's store on-hand never changes and the FR-024
 * `flagIfNegativeOnHand` probe can never fire for it. The signal therefore
 * reads the SOURCE position (store, product, location, status, identity): when
 * the move left it below zero, the probe reports it and increments
 * `inventory_position_negative_total`. Allow-and-flag: the probe never throws,
 * and a failed probe is rolled back to its own savepoint so the move's
 * transaction stays usable.
 *
 * Layer: unit, fake client (no I/O). The real-database path is in
 * position-events.spec.ts (Docker-gated).
 */
jest.mock('../../../src/inventory/position-events/position-events.metrics', () => {
  const actual = jest.requireActual('../../../src/inventory/position-events/position-events.metrics');
  return { ...actual, recordInventoryPositionNegative: jest.fn() };
});

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

/** A fake client: the probe SELECT answers `quantity`, or throws `failWith`. */
function fakeClient(answer: { quantity?: string; failWith?: Error }): { client: PoolClient; calls: Call[] } {
  const calls: Call[] = [];
  const query = jest.fn(async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params });
    if (/SELECT/i.test(sql)) {
      if (answer.failWith) throw answer.failWith;
      return { rows: [{ quantity: answer.quantity ?? '0.0000' }] };
    }
    return { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, calls };
}

beforeEach(() => recordPositionNegative.mockClear());

describe('RT-1584 source-position negative signal', () => {
  it('reports and counts a source position the move left below zero', async () => {
    const { client } = fakeClient({ quantity: '-95.0000' });

    await expect(flagIfSourcePositionNegative(client, SOURCE)).resolves.toBe(true);
    expect(recordPositionNegative).toHaveBeenCalledTimes(1);
  });

  it('does not report or count a source position at zero', async () => {
    const { client } = fakeClient({ quantity: '0.0000' });

    await expect(flagIfSourcePositionNegative(client, SOURCE)).resolves.toBe(false);
    expect(recordPositionNegative).not.toHaveBeenCalled();
  });

  it('does not report or count a positive source position', async () => {
    const { client } = fakeClient({ quantity: '7.0000' });

    await expect(flagIfSourcePositionNegative(client, SOURCE)).resolves.toBe(false);
    expect(recordPositionNegative).not.toHaveBeenCalled();
  });

  it('reads exactly the source position: store, product, location, status and identity', async () => {
    const { client, calls } = fakeClient({ quantity: '1.0000' });

    await flagIfSourcePositionNegative(client, SOURCE);

    const probe = calls.find((c) => /SELECT/i.test(c.sql));
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
  });

  it('never throws: a failed probe is rolled back to its savepoint and reports nothing', async () => {
    const { client, calls } = fakeClient({ failWith: new Error('probe failed') });

    await expect(flagIfSourcePositionNegative(client, SOURCE)).resolves.toBe(false);
    expect(recordPositionNegative).not.toHaveBeenCalled();
    const statements = calls.map((c) => c.sql.trim().split(/\s+/).slice(0, 3).join(' '));
    expect(statements[0]).toMatch(/^SAVEPOINT /);
    expect(statements).toContainEqual(expect.stringMatching(/^ROLLBACK TO SAVEPOINT/));
  });

  it('releases its savepoint after a successful probe', async () => {
    const { client, calls } = fakeClient({ quantity: '-1.0000' });

    await flagIfSourcePositionNegative(client, SOURCE);

    expect(calls[0]?.sql).toMatch(/^SAVEPOINT /);
    expect(calls[calls.length - 1]?.sql).toMatch(/^RELEASE SAVEPOINT /);
  });
});
