/**
 * Jira RT-451 slice S5 — `listTrackingResolutionQueue` and
 * `bindTrackingResolution` end to end over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` role).
 * Contract: `inventory/inventory.yaml` 1.13.0-draft.
 *
 * Queue:
 *   - auth: 401 unauthenticated; owner and tenant_admin read the items; a
 *     store_manager gets only `unresolvedCount` for its own stores (OD-9);
 *     any other role is a 403 that never reads;
 *   - order `capturedAt DESC, saleId DESC`; `status` (unresolved by default,
 *     resolved, all) and `storeId` filters; `unresolvedCount` ignores status,
 *     cursor and limit; another tenant's sales never appear;
 *   - keyset walk returns each sale once; a foreign cursor is a 400;
 *   - every 200 body conforms to the contract (ajv).
 * Bind:
 *   - owner only (tenant_admin and store_manager are 403s);
 *   - refusals, nothing written: 404 for an unknown / other-tenant sale, a
 *     sale outside the caller's store scope, a sale never unresolved, an
 *     unknown / other-tenant / serial identity; 400 for a missing or foreign
 *     line, a blank note, a bad reason code; 409 for another product's
 *     identity, an identity held now, held at the sale's occurredAt,
 *     expired, or without the expiry its product requires; 409 for a sale
 *     already resolved;
 *   - success, atomically: the resolution and its bindings, the sale
 *     `tracked`, an `edge_map_missing` finding for an unmapped identity, the
 *     sale's effects at the bound identities and its `sale_post` intent
 *     (processed sale, effects active), the audit row; the sale leaves the
 *     unresolved queue and shows `resolved` with its resolution;
 *   - replay with the same key and body returns the recorded resolution and
 *     writes nothing; the same key with another body is a 409;
 *   - cross-tenant isolation.
 *
 * The role read is a fake (`findRoleCodeForUserInTenant`) behind the real
 * `RolesGuard`; the scope rule is the real `callerStoreScope`.
 * Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import {
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Pool } from 'pg';
import request from 'supertest';

import { PG_POOL } from '../../../src/auth/auth.module';
import { DashboardAuthGuard } from '../../../src/auth/dashboard-auth.guard';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { GlobalExceptionFilter } from '../../../src/common/exception.filter';
import { MembershipRepository } from '../../../src/context/membership.repository';
import { TenantContextGuard } from '../../../src/context/tenant-context.guard';
import type { ResolvedContext } from '../../../src/context/types';
import { encodeSafetyHistoryCursor } from '../../../src/inventory/safety/safety-history.cursor';
import { TrackingResolutionController } from '../../../src/inventory/tracking-resolution/tracking-resolution.controller';
import { TrackingResolutionService } from '../../../src/inventory/tracking-resolution/tracking-resolution.service';
import { startPgEnvOrSkip } from '../../_helpers/device-module-app';
import { allContracts, contractDocument } from '../../_helpers/openapi-contract';
import { stopPgEnv, type PgTestEnv } from '../../_helpers/postgres-container';
import {
  ACTOR_A,
  ACTOR_B,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
  seedCatalogIsolationFixture,
} from '../../catalog/__support__/isolation-harness';

// `0451` / `55` mnemonic, hex-safe.
const id = (n: string): string => `0a000000-0000-7000-8000-0000045155${n}`;
const PRODUCT = id('01');
const PRODUCT_OTHER = id('02');
const PRODUCT_REQ = id('03');
const PRODUCT_SERIAL = id('04');
const PRODUCT_B = '0b000000-0000-7000-8000-000004515501';
const I_OK = id('11');
const I_NOMAP = id('12');
const I_OTHER = id('13');
const I_HELD = id('14');
const I_HELD_AT = id('15');
const I_EXPIRED = id('16');
const I_NO_EXPIRY_REQ = id('17');
const I_SERIAL = id('18');
const I_B = '0b000000-0000-7000-8000-000004515511';

const QUEUE = '/api/inventory/v1/tracking-resolutions';
const bindPath = (saleId: string): string => `${QUEUE}/${saleId}/bind`;
const BASE_MS = Date.parse('2026-11-11T10:00:00.000Z');
const OCCURRED = '2026-11-11T09:00:00Z';

let env: PgTestEnv | null = null;
let admin: Pool;
let app: INestApplication;
let role: string | null = 'owner';
let authenticated = true;
let tenant: { tenantId: string; userId: string } = { tenantId: TENANT_A, userId: ACTOR_A };
let storeAccess: NonNullable<ResolvedContext['storeAccess']> = { kind: 'all' };

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

function conforms(schema: string, body: unknown): void {
  const validate = ajv.getSchema(`inventory#/components/schemas/${schema}`);
  if (!validate) throw new Error(`ajv cannot resolve ${schema}`);
  if (!validate(body)) throw new Error(`contract violation: ${JSON.stringify(validate.errors)}`);
}

class AuthGuard implements CanActivate {
  canActivate(): boolean {
    if (!authenticated) throw new UnauthorizedException('Unauthorized');
    return true;
  }
}

class ContextGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext; principal?: unknown }>();
    req.principal = { kind: 'session', sessionId: 's1', userId: tenant.userId };
    req.context = {
      userId: tenant.userId,
      tenantId: tenant.tenantId,
      storeId: null,
      isPlatformAdmin: false,
      source: 'session',
      storeAccess,
    };
    return true;
  }
}

const memberships = {
  findRoleCodeForUserInTenant: async (): Promise<string | null> => role,
  isPlatformAdmin: async (): Promise<boolean> => false,
};

interface QueueItem {
  readonly saleId: string;
  readonly storeId: string;
  readonly status: string;
  readonly unresolvedLines: Array<{ saleLineId: string; reason: string }>;
  readonly resolution: { id: string; lines: Array<{ saleLineId: string; trackingIdentityId: string }> } | null;
}
interface QueueBody {
  readonly items: QueueItem[];
  readonly nextCursor: string | null;
  readonly unresolvedCount: number;
}

async function getQueue(query = ''): Promise<request.Response> {
  return await request(app.getHttpServer()).get(`${QUEUE}${query.length > 0 ? `?${query}` : ''}`);
}

async function queue(query = ''): Promise<QueueBody> {
  const res = await getQueue(query);
  expect(res.status).toBe(200);
  conforms('TrackingResolutionQueue', res.body);
  return res.body as QueueBody;
}

async function walk(query: string): Promise<QueueItem[]> {
  const items: QueueItem[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep = query.length > 0 ? '&' : '';
    const body = await queue(`${query}${cursor === null ? '' : `${sep}cursor=${encodeURIComponent(cursor)}`}`);
    items.push(...body.items);
    cursor = body.nextCursor;
    pages += 1;
    if (pages > 50) throw new Error('walk did not end');
  } while (cursor !== null);
  return items;
}

let keySeq = 0;
const newKey = (): string => {
  keySeq += 1;
  // The production IdempotencyInterceptor accepts 16-128 printable ASCII characters.
  return `rt451-s5-bind-key-${String(keySeq).padStart(6, "0")}`;
};

async function postBind(saleId: string, body: unknown, key: string = newKey()): Promise<request.Response> {
  return await request(app.getHttpServer()).post(bindPath(saleId)).set('Idempotency-Key', key).send(body as object);
}

const bindBody = (lines: Array<[string, string]>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  reasonCode: 'label_misprint',
  note: '  Lot read from the box.  ',
  lines: lines.map(([saleLineId, trackingIdentityId]) => ({ saleLineId, trackingIdentityId })),
  ...extra,
});

let saleSeq = 0;

/**
 * One `tracking_unresolved` sale with `lines` row-4 lines of `product`,
 * received `minutesAgo` before the base instant. Returns its id and line ids.
 */
async function seedUnresolved(input: {
  tenantId?: string;
  storeId?: string;
  product?: string;
  lines?: number;
  minutesAgo: number;
  processed?: boolean;
  actor?: string;
}): Promise<{ saleId: string; lineIds: string[] }> {
  saleSeq += 1;
  const tenantId = input.tenantId ?? TENANT_A;
  const storeId = input.storeId ?? STORE_A_X;
  const sale = await admin.query<{ id: string }>(
    `INSERT INTO sales (tenant_id, store_id, currency_code, pos_total, occurred_at, business_date, received_at,
                        source_system, external_id, payload_hash, created_by, tracking_status, processed_at)
     VALUES ($1, $2, 'USD', 10, $3, '2026-11-11', $4::timestamptz, 'rt451-s5', $5, repeat('a', 64), $6,
             'tracking_unresolved', CASE WHEN $7 THEN now() END)
     RETURNING id::text AS id`,
    [
      tenantId,
      storeId,
      OCCURRED,
      new Date(BASE_MS - input.minutesAgo * 60_000).toISOString(),
      `rt451-s5-${saleSeq}`,
      input.actor ?? ACTOR_A,
      input.processed ?? false,
    ],
  );
  const lineIds: string[] = [];
  for (let n = 0; n < (input.lines ?? 1); n += 1) {
    const line = await admin.query<{ id: string }>(
      `INSERT INTO sale_lines (sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                               line_amount, unit, tenant_product_ref, line_seq, tracking_class, tracking_unresolved_reason)
       VALUES ($1, $2, $3, 'lot', 5, 'USD', 2, 10, 'ea', $4, $5, 'unresolved', 'tracking_missing')
       RETURNING id::text AS id`,
      [sale.rows[0]!.id, tenantId, storeId, input.product ?? PRODUCT, n + 1],
    );
    lineIds.push(line.rows[0]!.id);
  }
  return { saleId: sale.rows[0]!.id, lineIds };
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) q`, params)).rows[0]!.n);
}

/** Everything a bind writes, for one sale. */
async function writes(saleId: string): Promise<Record<string, number | string | null>> {
  return {
    resolutions: await count(`SELECT 1 FROM tracking_resolutions WHERE sale_id = $1`, [saleId]),
    bindings: await count(
      `SELECT 1 FROM tracking_resolution_lines l JOIN sale_lines sl ON sl.id = l.sale_line_id WHERE sl.sale_id = $1`,
      [saleId],
    ),
    findings: await count(`SELECT 1 FROM sale_line_findings WHERE sale_id = $1`, [saleId]),
    effects: await count(`SELECT 1 FROM stock_movements WHERE sale_id = $1`, [saleId]),
    intents: await count(`SELECT 1 FROM outbox_events WHERE payload->>'sale_id' = $1`, [saleId]),
    audits: await count(`SELECT 1 FROM audit_events WHERE action = 'inventory.tracking_resolution.bind' AND target_id = $1`, [
      saleId,
    ]),
    status: (await admin.query<{ s: string | null }>(`SELECT tracking_status AS s FROM sales WHERE id = $1`, [saleId]))
      .rows[0]!.s,
  };
}

const NOTHING_WRITTEN = {
  resolutions: 0,
  bindings: 0,
  findings: 0,
  effects: 0,
  intents: 0,
  audits: 0,
  status: 'tracking_unresolved',
};

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-451 S5 Tracking Resolution');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'rt451s5-a@fixture.invalid', NULL),
       ($2, 'rt451s5-b@fixture.invalid', NULL) ON CONFLICT DO NOTHING`,
    [ACTOR_A, ACTOR_B],
  );
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode, expiry_required)
     VALUES ($1, $6, 'S5 tracked', 'standard', $8, $8, 'batch', false),
            ($2, $6, 'S5 other', 'standard', $8, $8, 'batch', false),
            ($3, $6, 'S5 expiry required', 'standard', $8, $8, 'batch', true),
            ($4, $6, 'S5 serial', 'standard', $8, $8, 'serial', false),
            ($5, $7, 'S5 tracked B', 'standard', $9, $9, 'batch', false)`,
    [PRODUCT, PRODUCT_OTHER, PRODUCT_REQ, PRODUCT_SERIAL, PRODUCT_B, TENANT_A, TENANT_B, ACTOR_A, ACTOR_B],
  );
  await admin.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date) VALUES
       ($1, $10, $11, 'batch', 'S5-OK', '2026-12-31'),
       ($2, $10, $11, 'batch', 'S5-NOMAP', '2026-12-31'),
       ($3, $10, $12, 'batch', 'S5-OTHER', '2026-12-31'),
       ($4, $10, $11, 'batch', 'S5-HELD', '2026-12-31'),
       ($5, $10, $11, 'batch', 'S5-HELD-AT', '2026-12-31'),
       ($6, $10, $11, 'batch', 'S5-EXPIRED', '2026-11-10'),
       ($7, $10, $13, 'batch', 'S5-NOEXP', NULL),
       ($8, $10, $14, 'serial', 'S5-SERIAL', NULL),
       ($9, $15, $16, 'batch', 'S5-B', '2026-12-31')`,
    [I_OK, I_NOMAP, I_OTHER, I_HELD, I_HELD_AT, I_EXPIRED, I_NO_EXPIRY_REQ, I_SERIAL, I_B, TENANT_A, PRODUCT, PRODUCT_OTHER, PRODUCT_REQ, PRODUCT_SERIAL, TENANT_B, PRODUCT_B],
  );
  await admin.query(
    `INSERT INTO erpnext_tracking_map (tenant_id, tracking_identity_id, kind, erpnext_ref)
     SELECT $1, i, 'batch', 'BATCH-' || i::text FROM unnest($2::uuid[]) AS i`,
    [TENANT_A, [I_OK, I_OTHER, I_HELD, I_HELD_AT, I_EXPIRED, I_NO_EXPIRY_REQ]],
  );
  // I_HELD: an active quality hold. I_HELD_AT: held over the sale's occurredAt, released since.
  await admin.query(
    `INSERT INTO tracking_holds (id, tenant_id, tracking_identity_id, tenant_product_ref, kind, reason_code, placed_by,
                                 placed_at, released_by, released_at)
     VALUES (gen_random_uuid(), $1, $2, $4, 'quality_hold', 'supplier_notice', $5, '2026-11-11T08:00:00Z', NULL, NULL),
            (gen_random_uuid(), $1, $3, $4, 'quality_hold', 'supplier_notice', $5, '2026-11-11T08:00:00Z', $5,
             '2026-11-11T09:30:00Z')`,
    [TENANT_A, I_HELD, I_HELD_AT, PRODUCT, ACTOR_A],
  );
  // Sale effects active, so a processed sale's bind writes its effects.
  await admin.query(
    `INSERT INTO tenant_inventory_settings (tenant_id, updated_by, sale_effects_activated_at, sale_effects_activated_by)
     VALUES ($1, $2, now(), $2)
     ON CONFLICT (tenant_id) DO UPDATE SET sale_effects_activated_at = now(), sale_effects_activated_by = $2`,
    [TENANT_A, ACTOR_A],
  );

  const pool = env.app as unknown as Pool;
  const moduleRef = await Test.createTestingModule({
    controllers: [TrackingResolutionController],
    providers: [
      { provide: PG_POOL, useValue: pool },
      { provide: MembershipRepository, useValue: memberships },
      TrackingResolutionService,
      RolesGuard,
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue(new AuthGuard())
    .overrideGuard(TenantContextGuard)
    .useValue(new ContextGuard())
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();

  ajv.addSchema(contractDocument(allContracts(), 'inventory') as object, 'inventory');
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  role = 'owner';
  authenticated = true;
  tenant = { tenantId: TENANT_A, userId: ACTOR_A };
  storeAccess = { kind: 'all' };
});

const skipped = (): boolean => env === null;

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

describe('RT-451 S5 listTrackingResolutionQueue', () => {
  let ax1: string;
  let ax2: string;
  let ay1: string;
  let tie: string[];

  beforeAll(async () => {
    if (skipped()) return;
    // A fresh store set for the queue: these sales are older than any bind test's.
    ax1 = (await seedUnresolved({ minutesAgo: 1000, lines: 2 })).saleId;
    ax2 = (await seedUnresolved({ minutesAgo: 1001 })).saleId;
    ay1 = (await seedUnresolved({ storeId: STORE_A_Y, minutesAgo: 999 })).saleId;
    // Two sales with the same capturedAt: saleId breaks the tie.
    tie = [(await seedUnresolved({ minutesAgo: 1002 })).saleId, (await seedUnresolved({ minutesAgo: 1002 })).saleId].sort().reverse();
    await seedUnresolved({ tenantId: TENANT_B, storeId: STORE_B_X, product: PRODUCT_B, minutesAgo: -5, actor: ACTOR_B });
  });

  it('an unauthenticated request is a 401', async () => {
    if (skipped()) return;
    authenticated = false;
    expect((await getQueue()).status).toBe(401);
  });

  it.each(['store_staff', 'cashier'])('a %s is a 403 and reads nothing', async (r) => {
    if (skipped()) return;
    role = r;
    const res = await getQueue();
    expect(res.status).toBe(403);
    expect(res.body.items).toBeUndefined();
  });

  it('lists unresolved sales newest capture first, with their lines, for an owner', async () => {
    if (skipped()) return;
    const items = await walk('limit=200');
    const ids = items.map((i) => i.saleId);
    const mine = ids.filter((s) => [ax1, ax2, ay1, ...tie].includes(s));
    expect(mine).toEqual([ay1, ax1, ax2, ...tie]);
    const first = items.find((i) => i.saleId === ax1)!;
    expect(first.status).toBe('unresolved');
    expect(first.resolution).toBeNull();
    expect(first.unresolvedLines).toHaveLength(2);
    expect(first.unresolvedLines[0]!.reason).toBe('tracking_missing');
    expect(items.every((i) => i.storeId !== STORE_B_X)).toBe(true);
  });

  it('narrows to a store and counts the unresolved sales in scope, whatever the page', async () => {
    if (skipped()) return;
    const onlyY = await queue(`storeId=${STORE_A_Y}`);
    expect(onlyY.items.map((i) => i.saleId)).toEqual([ay1]);
    expect(onlyY.unresolvedCount).toBe(1);
    const all = await queue('limit=1');
    const total = await count(
      `SELECT 1 FROM sales WHERE tenant_id = $1 AND tracking_status = 'tracking_unresolved'`,
      [TENANT_A],
    );
    expect(all.unresolvedCount).toBe(total);
    expect((await queue('status=resolved&limit=1')).unresolvedCount).toBe(total);
  });

  it('pages with a keyset cursor, each sale once', async () => {
    if (skipped()) return;
    const paged = await walk('limit=2');
    const whole = (await queue('limit=200')).items;
    expect(paged.map((i) => i.saleId)).toEqual(whole.map((i) => i.saleId));
    expect(new Set(paged.map((i) => i.saleId)).size).toBe(paged.length);
  });

  it('refuses a tampered cursor, another operation\'s cursor and one reused with other filters (400)', async () => {
    if (skipped()) return;
    const first = await queue('limit=1');
    expect(first.nextCursor).not.toBeNull();
    expect((await getQueue('cursor=not-a-cursor')).status).toBe(400);
    expect((await getQueue(`status=all&cursor=${encodeURIComponent(first.nextCursor!)}`)).status).toBe(400);
    const foreign = encodeSafetyHistoryCursor(
      { op: 'sale_line_findings', tenantId: TENANT_A, filters: [null, null] },
      { atKey: '2026-11-11T10:00:00.000000Z', id: ax1 },
    );
    expect((await getQueue(`cursor=${encodeURIComponent(foreign)}`)).status).toBe(400);
    expect((await getQueue('limit=0')).status).toBe(400);
    expect((await getQueue('limit=201')).status).toBe(400);
  });

  it('gives a store_manager only the count of its own stores (OD-9)', async () => {
    if (skipped()) return;
    role = 'store_manager';
    storeAccess = { kind: 'specific', storeIds: [STORE_A_Y] };
    const body = await queue();
    expect(body).toEqual({ items: [], nextCursor: null, unresolvedCount: 1 });
    storeAccess = { kind: 'specific', storeIds: [] };
    expect(await queue()).toEqual({ items: [], nextCursor: null, unresolvedCount: 0 });
  });

  it('lets a tenant_admin read the items, and another tenant only its own sales', async () => {
    if (skipped()) return;
    role = 'tenant_admin';
    expect((await queue('limit=200')).items.some((i) => i.saleId === ax1)).toBe(true);
    tenant = { tenantId: TENANT_B, userId: ACTOR_B };
    role = 'owner';
    const b = await queue('limit=200');
    expect(b.items.every((i) => i.storeId === STORE_B_X)).toBe(true);
    expect(b.unresolvedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Bind
// ---------------------------------------------------------------------------

describe('RT-451 S5 bindTrackingResolution — refusals write nothing', () => {
  it.each(['tenant_admin', 'store_manager'])('a %s is a 403', async (r) => {
    if (skipped()) return;
    role = r;
    const s = await seedUnresolved({ minutesAgo: 10 });
    expect((await postBind(s.saleId, bindBody([[s.lineIds[0]!, I_OK]]))).status).toBe(403);
    expect(await writes(s.saleId)).toEqual(NOTHING_WRITTEN);
  });

  it('is a 404 for an unknown sale, another tenant\'s sale and a sale outside the store scope', async () => {
    if (skipped()) return;
    const b = await seedUnresolved({ tenantId: TENANT_B, storeId: STORE_B_X, product: PRODUCT_B, minutesAgo: 10, actor: ACTOR_B });
    expect((await postBind(id('ff'), bindBody([[b.lineIds[0]!, I_OK]]))).status).toBe(404);
    expect((await postBind(b.saleId, bindBody([[b.lineIds[0]!, I_B]]))).status).toBe(404);
    expect(await writes(b.saleId)).toEqual(NOTHING_WRITTEN);
    const s = await seedUnresolved({ storeId: STORE_A_Y, minutesAgo: 10 });
    storeAccess = { kind: 'specific', storeIds: [STORE_A_X] };
    expect((await postBind(s.saleId, bindBody([[s.lineIds[0]!, I_OK]]))).status).toBe(404);
    expect(await writes(s.saleId)).toEqual(NOTHING_WRITTEN);
  });

  it('is a 404 for a sale that was never tracking_unresolved', async () => {
    if (skipped()) return;
    const sale = await admin.query<{ id: string }>(
      `INSERT INTO sales (tenant_id, store_id, currency_code, pos_total, occurred_at, business_date, source_system,
                          external_id, payload_hash, created_by)
       VALUES ($1, $2, 'USD', 1, now(), current_date, 'rt451-s5', 'rt451-s5-plain', repeat('a', 64), $3)
       RETURNING id::text AS id`,
      [TENANT_A, STORE_A_X, ACTOR_A],
    );
    const line = await admin.query<{ id: string }>(
      `INSERT INTO sale_lines (sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                               line_amount, unit, tenant_product_ref)
       VALUES ($1, $2, $3, 'x', 1, 'USD', 1, 1, 'ea', $4) RETURNING id::text AS id`,
      [sale.rows[0]!.id, TENANT_A, STORE_A_X, PRODUCT],
    );
    expect((await postBind(sale.rows[0]!.id, bindBody([[line.rows[0]!.id, I_OK]]))).status).toBe(404);
  });

  it.each<[string, string]>([
    ['an unknown identity', id('fe')],
    ["another tenant's identity", I_B],
    ['a serial identity (never a lot, Q11)', I_SERIAL],
  ])('is a 404 for %s', async (_why, identity) => {
    if (skipped()) return;
    const s = await seedUnresolved({ minutesAgo: 10 });
    expect((await postBind(s.saleId, bindBody([[s.lineIds[0]!, identity]]))).status).toBe(404);
    expect(await writes(s.saleId)).toEqual(NOTHING_WRITTEN);
  });

  it('is a 400 when lines miss, repeat or add a line, or the note or reason code is invalid', async () => {
    if (skipped()) return;
    const s = await seedUnresolved({ minutesAgo: 10, lines: 2 });
    const [l1, l2] = s.lineIds as [string, string];
    const other = await seedUnresolved({ minutesAgo: 10 });
    for (const body of [
      bindBody([[l1, I_OK]]),
      bindBody([[l1, I_OK], [l1, I_OK]]),
      bindBody([[l1, I_OK], [l2, I_OK], [other.lineIds[0]!, I_OK]]),
      bindBody([[l1, I_OK], [l2, I_OK]], { note: '   ' }),
      bindBody([[l1, I_OK], [l2, I_OK]], { reasonCode: 'Label Misprint' }),
      bindBody([[l1, I_OK], [l2, I_OK]], { tenantId: TENANT_B }),
      { ...bindBody([[l1, I_OK], [l2, I_OK]]), lines: [] },
    ]) {
      const res = await postBind(s.saleId, body);
      expect(res.status).toBe(400);
    }
    expect(await writes(s.saleId)).toEqual(NOTHING_WRITTEN);
  });

  it.each<[string, string, string]>([
    ["another product's identity", I_OTHER, 'tracking_resolution_identity_mismatch'],
    ['an identity held now', I_HELD, 'tracking_resolution_identity_held'],
    ["an identity held at the sale's occurredAt, released since", I_HELD_AT, 'tracking_resolution_identity_held'],
    ["an identity expired at the sale's business date", I_EXPIRED, 'tracking_resolution_identity_expired'],
  ])('is a 409 for %s', async (_why, identity, code) => {
    if (skipped()) return;
    const s = await seedUnresolved({ minutesAgo: 10 });
    const res = await postBind(s.saleId, bindBody([[s.lineIds[0]!, identity]]));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(code);
    expect(await writes(s.saleId)).toEqual(NOTHING_WRITTEN);
  });

  it('is a 409 expired for an identity without the expiry its product requires (fail closed)', async () => {
    if (skipped()) return;
    const s = await seedUnresolved({ minutesAgo: 10, product: PRODUCT_REQ });
    const res = await postBind(s.saleId, bindBody([[s.lineIds[0]!, I_NO_EXPIRY_REQ]]));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('tracking_resolution_identity_expired');
    expect(await writes(s.saleId)).toEqual(NOTHING_WRITTEN);
  });

  it('refuses the whole sale when one of its lines is refused', async () => {
    if (skipped()) return;
    const s = await seedUnresolved({ minutesAgo: 10, lines: 2 });
    const res = await postBind(s.saleId, bindBody([[s.lineIds[0]!, I_OK], [s.lineIds[1]!, I_HELD]]));
    expect(res.status).toBe(409);
    expect(await writes(s.saleId)).toEqual(NOTHING_WRITTEN);
  });
});

describe('RT-451 S5 bindTrackingResolution — success', () => {
  it('records the resolution, the effects, the intent, the finding and the audit atomically', async () => {
    if (skipped()) return;
    const s = await seedUnresolved({ minutesAgo: 5, lines: 2, processed: true });
    const [l1, l2] = s.lineIds as [string, string];
    const res = await postBind(s.saleId, bindBody([[l2, I_NOMAP], [l1, I_OK]]));
    expect(res.status).toBe(200);
    conforms('TrackingResolution', res.body);
    expect(res.body).toMatchObject({
      saleId: s.saleId,
      reasonCode: 'label_misprint',
      note: 'Lot read from the box.',
      resolvedBy: ACTOR_A,
    });
    expect(res.body.lines).toEqual(
      [
        { saleLineId: l1, trackingIdentityId: I_OK },
        { saleLineId: l2, trackingIdentityId: I_NOMAP },
      ].sort((a, b) => a.saleLineId.localeCompare(b.saleLineId)),
    );
    expect(await writes(s.saleId)).toEqual({
      resolutions: 1,
      bindings: 2,
      findings: 1,
      effects: 2,
      // the sale_post intent and one inventory.movement.created event
      intents: 1,
      audits: 1,
      status: 'tracked',
    });
    const effects = await admin.query<{ identity: string; quantity: string; status: string }>(
      `SELECT tracking_identity_id::text AS identity, quantity::text AS quantity, inventory_status AS status
         FROM stock_movements WHERE sale_id = $1 ORDER BY tracking_identity_id`,
      [s.saleId],
    );
    expect(effects.rows).toEqual(
      [
        { identity: I_OK, quantity: '-2.0000', status: 'sellable' },
        { identity: I_NOMAP, quantity: '-2.0000', status: 'sellable' },
      ].sort((a, b) => a.identity.localeCompare(b.identity)),
    );
    const finding = await admin.query(
      `SELECT sale_line_id::text AS line, tracking_identity_id::text AS identity, kind, cause
         FROM sale_line_findings WHERE sale_id = $1`,
      [s.saleId],
    );
    expect(finding.rows).toEqual([{ line: l2, identity: I_NOMAP, kind: 'erp_intent_held', cause: 'edge_map_missing' }]);
    const intent = await admin.query(`SELECT payload FROM outbox_events WHERE payload->>'sale_id' = $1`, [s.saleId]);
    expect(intent.rows).toEqual([
      { payload: { sale_id: s.saleId, store_id: STORE_A_X, kind: 'sale_post', source_ref_id: s.saleId } },
    ]);

    // The sale left the unresolved queue and reads `resolved` with its resolution.
    const unresolved = await queue('limit=200');
    expect(unresolved.items.some((i) => i.saleId === s.saleId)).toBe(false);
    const resolved = (await queue('status=resolved&limit=200')).items.find((i) => i.saleId === s.saleId)!;
    expect(resolved.status).toBe('resolved');
    expect(resolved.unresolvedLines).toHaveLength(2);
    expect(resolved.resolution?.id).toBe(res.body.id);
    expect(resolved.resolution?.lines).toEqual(res.body.lines);
    expect((await queue('status=all&limit=200')).items.filter((i) => i.saleId === s.saleId)).toHaveLength(1);

    // A second command for the same sale is refused and writes nothing.
    const again = await postBind(s.saleId, bindBody([[l1, I_OK], [l2, I_OK]]));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('tracking_resolution_already_resolved');
    expect((await writes(s.saleId))['resolutions']).toBe(1);
  });

  it('leaves an unprocessed sale\'s effects and intent to the worker', async () => {
    if (skipped()) return;
    const s = await seedUnresolved({ minutesAgo: 5 });
    const res = await postBind(s.saleId, bindBody([[s.lineIds[0]!, I_OK]]));
    expect(res.status).toBe(200);
    expect(await writes(s.saleId)).toMatchObject({ resolutions: 1, bindings: 1, effects: 0, intents: 0, status: 'tracked' });
  });

  it('replays the same key and body with the recorded resolution and writes nothing; another body is a 409', async () => {
    if (skipped()) return;
    const s = await seedUnresolved({ minutesAgo: 5 });
    const key = newKey();
    const body = bindBody([[s.lineIds[0]!, I_OK]]);
    const first = await postBind(s.saleId, body, key);
    expect(first.status).toBe(200);
    const before = await writes(s.saleId);
    const replay = await postBind(s.saleId, body, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(await writes(s.saleId)).toEqual(before);
    const other = await postBind(s.saleId, { ...body, note: 'another note' }, key);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('idempotency_key_conflict');
    expect(await writes(s.saleId)).toEqual(before);
  });

  it('refuses the same key used concurrently for two sales with a 409, writing only one (review m1)', async () => {
    if (skipped()) return;
    const a = await seedUnresolved({ minutesAgo: 5 });
    const b = await seedUnresolved({ minutesAgo: 5 });
    const key = newKey();
    const [ra, rb] = await Promise.all([
      postBind(a.saleId, bindBody([[a.lineIds[0]!, I_OK]]), key),
      postBind(b.saleId, bindBody([[b.lineIds[0]!, I_OK]]), key),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const refused = ra.status === 409 ? ra : rb;
    expect(refused.body.error.code).toBe('idempotency_key_conflict');
    const resolved = (await writes(a.saleId))['resolutions'] as number;
    expect(resolved + ((await writes(b.saleId))['resolutions'] as number)).toBe(1);
  });

  it('never reads or binds across tenants', async () => {
    if (skipped()) return;
    const a = await seedUnresolved({ minutesAgo: 5 });
    tenant = { tenantId: TENANT_B, userId: ACTOR_B };
    expect((await postBind(a.saleId, bindBody([[a.lineIds[0]!, I_OK]]))).status).toBe(404);
    expect(await writes(a.saleId)).toEqual(NOTHING_WRITTEN);
  });
});
