/**
 * RT-1439 (RT-1437 A3; `inventory.yaml` 1.19.0-draft) — the readiness boundary carries a structured
 * `subject`, on real Postgres: `store_barrier_unprovable` is emitted ONCE PER offending device or
 * warehouse (it named only the first), each with exactly one of `deviceId` / `warehouseRef`; a
 * boundary that is not about one device or warehouse has no `subject` key at all
 * (`additionalProperties: false` allows no null). The 409 `count_sessions_readiness_unmet` carries
 * the same rows in `details.unmet`.
 */
import type { Pool } from 'pg';

import { CountSessionsSettingService } from '../../../src/inventory/count-sessions/count-sessions-setting.service';
import type { MembershipRepository } from '../../../src/context/membership.repository';
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from '../../_helpers/postgres-container';

const TENANT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const STORE = '10000000-aaaa-4aaa-8aaa-000000000001';
const USER = '11111111-1111-4111-8111-111111111111';
const DEVICE_NEVER_SEEN = '30000000-aaaa-4aaa-8aaa-000000000001';
const DEVICE_UNKNOWN_QUEUE = '30000000-aaaa-4aaa-8aaa-000000000002';
const DEVICE_FINE = '30000000-aaaa-4aaa-8aaa-000000000003';

let env: PgTestEnv | null = null;
let skipped = false;
let setting: CountSessionsSettingService;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
  } catch (err: unknown) {
    if (process.env['MIGRATION_TEST_ALLOW_SKIP'] === '1') {
      skipped = true;
      return;
    }
    throw err;
  }
  const pg = env.admin;
  await pg.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'acme', 'Acme')`, [TENANT]);
  await pg.query(`INSERT INTO users (id, email, is_platform_admin) VALUES ($1, 'u@example.com', false)`, [USER]);
  await pg.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S-1', 'S 1')`, [STORE, TENANT]);
  await pg.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'Stores - RT', $3, 1)`,
    [TENANT, STORE, USER],
  );
  for (const [i, id] of [DEVICE_NEVER_SEEN, DEVICE_UNKNOWN_QUEUE, DEVICE_FINE].entries()) {
    await pg.query(
      `INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES ($1, $2, $3, decode(repeat($4, 32), 'hex'))`,
      [id, TENANT, STORE, `c${i}`],
    );
  }
  // DEVICE_NEVER_SEEN has no health row. DEVICE_UNKNOWN_QUEUE reported a beat with no queue (all NULL = unknown).
  await pg.query(`INSERT INTO device_health (device_id, tenant_id, last_seen_at) VALUES ($1, $2, now())`, [DEVICE_UNKNOWN_QUEUE, TENANT]);
  await pg.query(
    `INSERT INTO device_health (device_id, tenant_id, last_seen_at, sale_queue_pending, sale_queue_dead_letter, sale_queue_held)
     VALUES ($1, $2, now(), 0, 0, 0)`,
    [DEVICE_FINE, TENANT],
  );
  setting = new CountSessionsSettingService(env.app as unknown as Pool, {} as unknown as MembershipRepository);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const caller = { tenantId: TENANT, userId: USER, isPlatformAdmin: true };

describe('the readiness subject (RT-1439)', () => {
  it('names every offending device and warehouse, once each, with exactly one structured subject', async () => {
    if (skipped) return;
    const read = await setting.getSetting(caller);
    const barrier = (read.unmetReadiness ?? []).filter((u) => u.code === 'store_barrier_unprovable');
    expect(barrier.map((u) => u.subject)).toEqual([
      { deviceId: DEVICE_NEVER_SEEN },
      { deviceId: DEVICE_UNKNOWN_QUEUE },
      { warehouseRef: 'Stores - RT' },
    ]);
    for (const u of barrier) {
      expect(u.storeId).toBe(STORE);
      expect(Object.keys(u.subject ?? {})).toHaveLength(1);
    }
    // The message is unchanged and the healthy device is not named.
    expect(barrier.map((u) => u.message).join('\n')).not.toContain(DEVICE_FINE);
    expect(barrier[0]!.message).toBe(`The Count Cut barrier cannot be proven: device ${DEVICE_NEVER_SEEN} has never reported a heartbeat.`);
  });

  it('a boundary that is not about one device or warehouse has no subject key (never null)', async () => {
    if (skipped) return;
    const read = await setting.getSetting(caller);
    const others = (read.unmetReadiness ?? []).filter((u) => u.code !== 'store_barrier_unprovable');
    expect(others.length).toBeGreaterThan(0);
    for (const u of others) expect(Object.keys(u)).not.toContain('subject');
  });

  it('the 409 count_sessions_readiness_unmet carries the same subjects in details.unmet', async () => {
    if (skipped) return;
    const err = (await setting.setSetting(caller, true).catch((e: unknown) => e)) as { getResponse(): { code: string; details: { unmet: Array<{ code: string; subject?: unknown }> } } };
    const body = err.getResponse();
    expect(body.code).toBe('count_sessions_readiness_unmet');
    expect(body.details.unmet.filter((u) => u.code === 'store_barrier_unprovable').map((u) => u.subject)).toEqual([
      { deviceId: DEVICE_NEVER_SEEN },
      { deviceId: DEVICE_UNKNOWN_QUEUE },
      { warehouseRef: 'Stores - RT' },
    ]);
  });
});
