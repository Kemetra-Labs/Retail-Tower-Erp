/**
 * Jira RT-1600 — the redistribution proposal routes over HTTP: the real `InventoryModule` (controller, guards,
 * service) on real Postgres (Testcontainers, every migration, the NOBYPASSRLS `app_test` role), with the real
 * idempotency interceptor over a fake Redis. Only cookie authentication is faked (the `x-test-session` header).
 *
 * Proves (RT-1600 acceptance 2, 3 and 7, plus the wire shapes):
 *   2. a role other than owner / tenant_admin (store_manager, store_staff) is the non-disclosing 404 on every route;
 *   3. a tenant on neither allowlist is the same 404, on reads and commands alike;
 *   7. a replayed accept (same key, same body) returns the stored response with `Idempotent-Replayed: true` and
 *      creates no second Transfer; the key reused with another body is 409 `idempotency_key_conflict`;
 *   every 2xx body validates (AJV) against its RT-1599 schema, and every refusal against the `Error` envelope.
 *
 * The allowlists are set in the environment before the app boots and restored afterwards: tenant A is on the LIVE
 * list, tenant B on neither.
 *
 * Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { Module, type INestApplication, type Provider } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { IdempotencyKeyStore } from '@data-pulse-2/shared';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import request from 'supertest';

import { TransferErpPortModule } from '../../../src/catalog/erpnext-posting/transfer-erp-port.module';
import { IDEMPOTENCY_KEY_STORE, IdempotencyInterceptor } from '../../../src/idempotency/idempotency.interceptor';
import { INFLIGHT_REDIS, InProgressMarker } from '../../../src/idempotency/in-progress-marker';
import { InventoryModule } from '../../../src/inventory/inventory.module';
import { InventoryStoreDirectoryModule } from '../../../src/stores/inventory-store-directory.module';
import { seedConsoleMember } from '../../_helpers/console-members';
import { allContracts, contractDocument } from '../../_helpers/openapi-contract';
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from '../../_helpers/postgres-container';
import { STORE_A_X, STORE_A_Y, TENANT_A, TENANT_B } from '../../catalog/__support__/isolation-harness';
import { bootScopedApp, SES_OWNER_ALL } from '../../catalog/erpnext-reconciliation/__support__/read-store-scope';
import { SES_MANAGER, SES_STAFF, seedConsoleSalesFixture } from '../../console-sales/__support__/console-sales-fixture';

const BASE = '/api/inventory/v1/redistribution-proposals';
const ORIGIN = 'http://127.0.0.1';
const CONTRACT = 'redistribution-proposals';
const SHADOW_ENV = 'REDISTRIBUTION_SHADOW_TENANT_ALLOWLIST';
const LIVE_ENV = 'REDISTRIBUTION_LIVE_TENANT_ALLOWLIST';

const a = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, '0')}`;
const b = (tag: string): string => `0b000000-0000-7000-8000-${tag.padStart(12, '0')}`;
const SES_OWNER_B = b('160000b1');
const ACTOR = a('160000e1');

@Module({ imports: [InventoryModule, TransferErpPortModule, InventoryStoreDirectoryModule] })
class RedistributionHttpHarness {}

class FakeRedis {
  private readonly s = new Map<string, { value: string; expiresAt: number }>();
  async get(k: string): Promise<string | null> {
    const e = this.s.get(k);
    if (!e || Date.now() > e.expiresAt) return null;
    return e.value;
  }
  async set(k: string, v: string, o: { px: number }): Promise<unknown> {
    this.s.set(k, { value: v, expiresAt: Date.now() + o.px });
    return 'OK';
  }
}
class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
let seq = 0;
const saved = { shadow: process.env[SHADOW_ENV], live: process.env[LIVE_ENV] };

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

function expectValid(name: string, body: unknown): void {
  const v: ValidateFunction | undefined = ajv.getSchema(`${CONTRACT}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  if (!v(body)) throw new Error(`${name} contract violation: ${JSON.stringify(v.errors)} in ${JSON.stringify(body)}`);
}

/** A run-time key: 16..128 printable characters, never a source literal. */
const key = (): string => ['rt1600', 'http', String(++seq).padStart(6, '0'), String(Date.now())].join('-');

const post = (path: string, session: string, body: unknown, idemKey = key()): request.Test =>
  request(app!.getHttpServer())
    .post(path)
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', idemKey)
    .set('x-test-session', session)
    .send(body as object);

const read = (path: string, session: string): request.Test => request(app!.getHttpServer()).get(path).set('x-test-session', session);

function expectStatus(res: request.Response, code: number): void {
  if (res.status !== code) throw new Error(`expected ${code}, got ${res.status}: ${JSON.stringify(res.body)}`);
}

function expectRefused(res: request.Response, code: number, errorCode: string): void {
  expectStatus(res, code);
  expectValid('Error', res.body);
  expect((res.body as { error: { code: string } }).error.code).toBe(errorCode);
}

async function seedStock(): Promise<void> {
  const productId = a('160000f1');
  await env!.admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, default_price, default_currency_code, created_by, updated_by, tracking_mode)
     VALUES ($1, $2, 'RT1600 http', 'standard', 10.00, 'EGP', $3, $3, 'none')`,
    [productId, TENANT_A, ACTOR],
  );
  await env!.admin.query(
    `INSERT INTO product_stock_levels (id, tenant_id, product_id, store_id, reorder_level, created_by, updated_by)
     VALUES (gen_random_uuid(), $1, $2, NULL, 10, $3, $3)`,
    [TENANT_A, productId, ACTOR],
  );
  for (const [storeId, quantity] of [
    [STORE_A_X, '50'],
    [STORE_A_Y, '2'],
  ] as const) {
    await env!.admin.query(
      `INSERT INTO stock_movements
         (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason,
          occurred_at, created_by, stock_location_id, inventory_status)
       VALUES (gen_random_uuid(), $1, $2, 'inbound', $3::numeric, 'piece', $4, 'rt1600 http seed', now(), $5,
               (SELECT id FROM stock_locations WHERE store_id = $2::uuid AND kind = 'primary'), 'sellable')`,
      [TENANT_A, storeId, quantity, productId, ACTOR],
    );
  }
  // Every till of tenant A reported just now with an empty problem queue: every store is fresh.
  await env!.admin.query(
    `INSERT INTO device_health (device_id, tenant_id, last_seen_at, sale_queue_pending, sale_queue_dead_letter, sale_queue_held)
     SELECT id, tenant_id, now(), 0, 0, 0 FROM devices WHERE tenant_id = $1
     ON CONFLICT (device_id) DO UPDATE SET last_seen_at = now(), sale_queue_pending = 0, sale_queue_dead_letter = 0, sale_queue_held = 0`,
    [TENANT_A],
  );
}

beforeAll(async () => {
  ajv.addSchema(contractDocument(allContracts(), CONTRACT) as object, CONTRACT);
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env['MIGRATION_TEST_ALLOW_SKIP'] === '1') {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-1600 http] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedConsoleSalesFixture(env);
  await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt1600-http-actor@example.test')`, [ACTOR]);
  await seedConsoleMember(env.admin, {
    tenantId: TENANT_B,
    userId: b('160000b2'),
    email: 'rt1600-http-owner-b@example.test',
    membershipId: b('160000b3'),
    roleId: b('160000b4'),
    roleCode: 'owner',
    stores: 'all',
    sessions: { [SES_OWNER_B]: null },
  });
  await env.admin.query(
    `INSERT INTO tenant_inventory_settings (tenant_id, shipment_transfers_enabled, updated_by) VALUES ($1, true, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET shipment_transfers_enabled = true`,
    [TENANT_A, ACTOR],
  );
  await seedStock();
  const redis = new FakeRedis();
  const marker = new FakeMarker();
  const store = new IdempotencyKeyStore({
    redis,
    pgWriter: { async insert(): Promise<void> {} },
    pgReader: { async find(): Promise<null> { return null; } },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  const providers: Provider[] = [
    { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
    { provide: INFLIGHT_REDIS, useValue: redis },
    { provide: InProgressMarker, useValue: marker },
    { provide: APP_INTERCEPTOR, useValue: new IdempotencyInterceptor(new Reflector(), store, marker as unknown as InProgressMarker) },
  ];
  process.env[SHADOW_ENV] = '';
  process.env[LIVE_ENV] = TENANT_A;
  app = await bootScopedApp(env, RedistributionHttpHarness, undefined, { authLookupPool: env.admin, providers });
}, 240_000);

afterAll(async () => {
  for (const [name, value] of [
    [SHADOW_ENV, saved.shadow],
    [LIVE_ENV, saved.live],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn('[RT-1600 http] skipping — Docker unavailable');
    return true;
  }
  return false;
}

interface ProposalBody {
  id: string;
  state: string;
  lines: { id: string }[];
}

let proposal: ProposalBody;

describe('the proposal routes over HTTP', () => {
  it('computes a proposal (201) and reads it back and in the list (200), each body valid against RT-1599', async () => {
    if (skip()) return;
    const created = await post(BASE, SES_OWNER_ALL, {});
    expectStatus(created, 201);
    expectValid('RedistributionProposal', created.body);
    proposal = created.body as ProposalBody;
    expect(proposal.state).toBe('open');
    const one = await read(`${BASE}/${proposal.id}`, SES_OWNER_ALL);
    expectStatus(one, 200);
    expectValid('RedistributionProposal', one.body);
    const list = await read(`${BASE}?state=open&limit=5`, SES_OWNER_ALL);
    expectStatus(list, 200);
    expectValid('RedistributionProposalList', list.body);
    expect((list.body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([proposal.id]);
  });

  it('answers a store_manager and a store_staff with the non-disclosing 404 on reads and commands (2)', async () => {
    if (skip()) return;
    for (const session of [SES_MANAGER, SES_STAFF]) {
      expectRefused(await read(BASE, session), 404, 'not_found');
      expectRefused(await read(`${BASE}/${proposal.id}`, session), 404, 'not_found');
      expectRefused(await post(BASE, session, {}), 404, 'not_found');
      expectRefused(await post(`${BASE}/${proposal.id}/reject`, session, { reason: 'not mine' }), 404, 'not_found');
    }
  });

  it('answers a tenant on neither allowlist with the same 404, before any key is claimed (3)', async () => {
    if (skip()) return;
    expectRefused(await read(BASE, SES_OWNER_B), 404, 'not_found');
    expectRefused(await read(`${BASE}/${proposal.id}`, SES_OWNER_B), 404, 'not_found');
    const idemKey = key();
    expectRefused(await post(BASE, SES_OWNER_B, {}, idemKey), 404, 'not_found');
    // A refused request claimed nothing: the same key and body are refused the same way, never replayed.
    const again = await post(BASE, SES_OWNER_B, {}, idemKey);
    expectRefused(again, 404, 'not_found');
    expect(again.headers['idempotent-replayed']).toBeUndefined();
  });

  it('requires Idempotency-Key on a command and validates the body strictly (400)', async () => {
    if (skip()) return;
    const noKey = await request(app!.getHttpServer()).post(BASE).set('Origin', ORIGIN).set('x-test-session', SES_OWNER_ALL).send({});
    expectRefused(noKey, 400, 'idempotency_key_required');
    expectRefused(await post(BASE, SES_OWNER_ALL, { storeIds: [STORE_A_X] }), 400, 'validation_error');
    expectRefused(await post(BASE, SES_OWNER_ALL, { tenantId: TENANT_A }), 400, 'validation_error');
    expectRefused(await read(`${BASE}/not-a-uuid`, SES_OWNER_ALL), 400, 'validation_error');
    expectRefused(await read(`${BASE}?cursor=forged`, SES_OWNER_ALL), 400, 'validation_error');
  });

  it('replays an accept with the same key and body, creating no second Transfer; another body is 409 (7)', async () => {
    if (skip()) return;
    const idemKey = key();
    const body = { lineIds: proposal.lines.map((l) => l.id) };
    const first = await post(`${BASE}/${proposal.id}/accept`, SES_OWNER_ALL, body, idemKey);
    expectStatus(first, 200);
    expectValid('RedistributionAcceptResult', first.body);
    const before = Number((await env!.admin.query(`SELECT count(*) AS n FROM shipment_transfers`)).rows[0].n);
    const replay = await post(`${BASE}/${proposal.id}/accept`, SES_OWNER_ALL, body, idemKey);
    expectStatus(replay, 200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(Number((await env!.admin.query(`SELECT count(*) AS n FROM shipment_transfers`)).rows[0].n)).toBe(before);
    expectRefused(await post(`${BASE}/${proposal.id}/accept`, SES_OWNER_ALL, { lineIds: [proposal.lines[0]!.id] }, idemKey), 409, 'idempotency_key_conflict');
    // A fresh key on a decided line is the proposal's own 409.
    expectRefused(await post(`${BASE}/${proposal.id}/accept`, SES_OWNER_ALL, body), 409, 'proposal_state_conflict');
  });

  it('answers nothing_to_move (200) once the gap is covered by the open draft', async () => {
    if (skip()) return;
    const res = await post(BASE, SES_OWNER_ALL, {});
    expectStatus(res, 200);
    expectValid('RedistributionNothingToMove', res.body);
  });
});
