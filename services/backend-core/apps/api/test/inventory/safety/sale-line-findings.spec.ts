/**
 * Jira RT-451 slice S3 — `listSaleLineFindings` end to end over HTTP against
 * real Postgres (Testcontainers, every migration, the NOBYPASSRLS `app_test`
 * role). Contract: `inventory/inventory.yaml` (`SaleLineFindingList`).
 *
 *   - auth: an unauthenticated request is a 401; owner, tenant_admin and
 *     store_manager read; any other role is a 403 that never reads;
 *   - order: newest first, `recordedAt DESC, id DESC` (a recorded_at tie is
 *     broken by id); every finding is `critical`;
 *   - filters: `kind` and `storeId` narrow; a store_manager sees only its own
 *     stores and a `storeId` outside its scope (or of another tenant) answers
 *     an empty page, not a 403 / 404;
 *   - tenant isolation: another tenant's findings never appear (RLS);
 *   - keyset: a walk over more than `limit` rows returns each finding once,
 *     in order; a tampered cursor, another operation's cursor and a cursor
 *     reused with other filters are a 400 `validation_error`; `limit` is 1-200;
 *   - every 200 body conforms to the contract schema (ajv).
 *
 * Findings are SEEDED with SQL: the capture-side writer is built separately in
 * RT-451 S3. The role read is a fake (`findRoleCodeForUserInTenant`) behind
 * the real `RolesGuard`; the scope rule is the real `callerStoreScope`.
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
import { SaleLineFindingsController } from '../../../src/inventory/safety/sale-line-findings.controller';
import { SaleLineFindingsService } from '../../../src/inventory/safety/sale-line-findings.service';
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

// `0451` / `5f` mnemonic, hex-safe.
const PRODUCT_TA = '0a000000-0000-7000-8000-000004515f01';
const PRODUCT_TB = '0b000000-0000-7000-8000-000004515f01';
const IDENTITY_A = '0a000000-0000-7000-8000-000004515f11';
const IDENTITY_B = '0b000000-0000-7000-8000-000004515f11';
const HOLD_A = '0a000000-0000-7000-8000-000004515f21';
const SALE_AX = '0a000000-0000-7000-8000-000004515f31';
const SALE_AY = '0a000000-0000-7000-8000-000004515f32';
const SALE_BX = '0b000000-0000-7000-8000-000004515f31';

const PATH = '/api/inventory/v1/safety/sale-line-findings';
const BASE_MS = Date.parse('2026-11-08T10:00:00.000Z');

let env: PgTestEnv | null = null;
let admin: Pool;
let app: INestApplication;
let role: string | null = 'owner';
let authenticated = true;
let tenant: { tenantId: string; userId: string } = { tenantId: TENANT_A, userId: ACTOR_A };
let storeAccess: NonNullable<ResolvedContext['storeAccess']> = { kind: 'all' };

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

function conforms(body: unknown): void {
  const validate = ajv.getSchema('inventory#/components/schemas/SaleLineFindingList');
  if (!validate) throw new Error('ajv cannot resolve SaleLineFindingList');
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

interface Item {
  readonly id: string;
  readonly kind: string;
  readonly cause: string;
  readonly storeId: string;
  readonly severity: string;
  readonly recordedAt: string;
}

async function get(query = ''): Promise<request.Response> {
  return await request(app.getHttpServer()).get(`${PATH}${query.length > 0 ? `?${query}` : ''}`);
}

async function page(query = ''): Promise<{ items: Item[]; nextCursor: string | null }> {
  const res = await get(query);
  expect(res.status).toBe(200);
  conforms(res.body);
  return res.body as { items: Item[]; nextCursor: string | null };
}

/** Every page, following `nextCursor` with the same filters. */
async function walk(query: string): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep = query.length > 0 ? '&' : '';
    const body = await page(`${query}${cursor === null ? '' : `${sep}cursor=${encodeURIComponent(cursor)}`}`);
    items.push(...body.items);
    cursor = body.nextCursor;
    pages += 1;
    if (pages > 50) throw new Error('walk did not end');
  } while (cursor !== null);
  return items;
}

let lineSeq = 0;

/** One sale line of `saleId` and one finding on it, recorded `minutesAgo` before the base instant. */
async function seedFinding(input: {
  tenantId: string;
  storeId: string;
  saleId: string;
  product: string;
  identity: string;
  kind: string;
  cause: string;
  holdId?: string;
  minutesAgo: number;
}): Promise<string> {
  lineSeq += 1;
  const line = await admin.query<{ id: string }>(
    `INSERT INTO sale_lines (sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                             line_amount, unit, tenant_product_ref)
     VALUES ($1, $2, $3, $4, 1, 'USD', 1, 1, 'pcs', $5) RETURNING id::text AS id`,
    [input.saleId, input.tenantId, input.storeId, `RT451 line ${lineSeq}`, input.product],
  );
  const finding = await admin.query<{ id: string }>(
    `INSERT INTO sale_line_findings
       (tenant_id, store_id, sale_id, sale_line_id, tenant_product_ref, tracking_identity_id, kind, cause,
        hold_id, business_date, occurred_at, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '2026-11-08', '2026-11-08T09:00:00Z', $10::timestamptz)
     RETURNING id::text AS id`,
    [
      input.tenantId,
      input.storeId,
      input.saleId,
      line.rows[0]!.id,
      input.product,
      input.identity,
      input.kind,
      input.cause,
      input.holdId ?? null,
      new Date(BASE_MS - input.minutesAgo * 60_000).toISOString(),
    ],
  );
  return finding.rows[0]!.id;
}

/** The expected tenant-A order straight from the table (superuser, no RLS). */
async function expectedIds(where = 'TRUE', params: unknown[] = []): Promise<string[]> {
  const r = await admin.query<{ id: string }>(
    `SELECT id::text AS id FROM sale_line_findings
      WHERE tenant_id = '${TENANT_A}' AND ${where}
      ORDER BY recorded_at DESC, id DESC`,
    params,
  );
  return r.rows.map((row) => row.id);
}

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-451 S3 sale-line findings');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'rt451-a@fixture.invalid', NULL),
       ($2, 'rt451-b@fixture.invalid', NULL) ON CONFLICT DO NOTHING`,
    [ACTOR_A, ACTOR_B],
  );
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode)
     VALUES ($1, $3, 'RT-451 tracked A', 'standard', $5, $5, 'batch'),
            ($2, $4, 'RT-451 tracked B', 'standard', $6, $6, 'batch')`,
    [PRODUCT_TA, PRODUCT_TB, TENANT_A, TENANT_B, ACTOR_A, ACTOR_B],
  );
  await admin.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date)
     VALUES ($1, $3, $5, 'batch', 'RT451-A', '2026-01-31'),
            ($2, $4, $6, 'batch', 'RT451-B', NULL)`,
    [IDENTITY_A, IDENTITY_B, TENANT_A, TENANT_B, PRODUCT_TA, PRODUCT_TB],
  );
  await admin.query(
    `INSERT INTO tracking_holds (id, tenant_id, tracking_identity_id, tenant_product_ref, kind, reason_code, placed_by)
     VALUES ($1, $2, $3, $4, 'quality_hold', 'supplier_notice', $5)`,
    [HOLD_A, TENANT_A, IDENTITY_A, PRODUCT_TA, ACTOR_A],
  );
  await admin.query(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $4, $5, 'USD', 10, '2026-11-08T09:00:00Z', '2026-11-08', 'rt451-fixture', 'rt451-ax', repeat('a', 64), $8),
            ($2, $4, $6, 'USD', 10, '2026-11-08T09:00:00Z', '2026-11-08', 'rt451-fixture', 'rt451-ay', repeat('a', 64), $8),
            ($3, $7, $9, 'USD', 10, '2026-11-08T09:00:00Z', '2026-11-08', 'rt451-fixture', 'rt451-bx', repeat('a', 64), $10)`,
    [SALE_AX, SALE_AY, SALE_BX, TENANT_A, STORE_A_X, STORE_A_Y, TENANT_B, ACTOR_A, STORE_B_X, ACTOR_B],
  );

  const ax = { tenantId: TENANT_A, storeId: STORE_A_X, saleId: SALE_AX, product: PRODUCT_TA, identity: IDENTITY_A };
  const ay = { tenantId: TENANT_A, storeId: STORE_A_Y, saleId: SALE_AY, product: PRODUCT_TA, identity: IDENTITY_A };
  // Store A.X: 7 findings, two of them sharing a recorded_at (the id breaks the tie).
  await seedFinding({ ...ax, kind: 'unvalidated_tracked_line', cause: 'validation_missing', minutesAgo: 1 });
  await seedFinding({ ...ax, kind: 'unvalidated_tracked_line', cause: 'validation_mismatch', minutesAgo: 2 });
  await seedFinding({ ...ax, kind: 'sold_under_hold', cause: 'quality_hold', holdId: HOLD_A, minutesAgo: 3 });
  await seedFinding({ ...ax, kind: 'erp_intent_held', cause: 'expired', minutesAgo: 4 });
  await seedFinding({ ...ax, kind: 'erp_intent_held', cause: 'edge_map_missing', minutesAgo: 4 });
  await seedFinding({ ...ax, kind: 'unvalidated_tracked_line', cause: 'validation_missing', minutesAgo: 6 });
  await seedFinding({ ...ax, kind: 'erp_intent_held', cause: 'expired', minutesAgo: 7 });
  // Store A.Y: 3 findings, interleaved in time.
  await seedFinding({ ...ay, kind: 'unvalidated_tracked_line', cause: 'validation_missing', minutesAgo: 0 });
  await seedFinding({ ...ay, kind: 'erp_intent_held', cause: 'expired', minutesAgo: 5 });
  await seedFinding({ ...ay, kind: 'sold_under_hold', cause: 'quality_hold', holdId: HOLD_A, minutesAgo: 8 });
  // Tenant B: newer than all of tenant A's.
  await seedFinding({
    tenantId: TENANT_B,
    storeId: STORE_B_X,
    saleId: SALE_BX,
    product: PRODUCT_TB,
    identity: IDENTITY_B,
    kind: 'unvalidated_tracked_line',
    cause: 'validation_missing',
    minutesAgo: -10,
  });

  const pool = env.app as unknown as Pool;
  const moduleRef = await Test.createTestingModule({
    controllers: [SaleLineFindingsController],
    providers: [
      { provide: PG_POOL, useValue: pool },
      { provide: MembershipRepository, useValue: memberships },
      SaleLineFindingsService,
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

describe('RT-451 S3 listSaleLineFindings — auth', () => {
  it('an unauthenticated request is a 401', async () => {
    if (skipped()) return;
    authenticated = false;
    const res = await get();
    expect(res.status).toBe(401);
  });

  it.each(['store_staff', 'cashier'])('a %s is a 403 and reads nothing', async (r) => {
    if (skipped()) return;
    role = r;
    const res = await get();
    expect(res.status).toBe(403);
    expect(res.body.items).toBeUndefined();
  });

  it.each(['owner', 'tenant_admin', 'store_manager'])('a %s reads', async (r) => {
    if (skipped()) return;
    role = r;
    await page();
  });
});

describe('RT-451 S3 listSaleLineFindings — order, filters and scope', () => {
  it('the owner sees the tenant newest first (recordedAt DESC, id DESC), all critical', async () => {
    if (skipped()) return;
    const body = await page();
    const expected = await expectedIds();
    expect(expected).toHaveLength(10);
    expect(body.items.map((i) => i.id)).toEqual(expected);
    expect(body.nextCursor).toBeNull();
    expect(new Set(body.items.map((i) => i.severity))).toEqual(new Set(['critical']));
    const held = body.items.filter((i) => i.kind === 'sold_under_hold');
    expect(held.every((i) => (i as unknown as { holdId: string }).holdId === HOLD_A)).toBe(true);
    const other = body.items.filter((i) => i.kind !== 'sold_under_hold');
    expect(other.every((i) => (i as unknown as { holdId: string | null }).holdId === null)).toBe(true);
  });

  it('filters by kind', async () => {
    if (skipped()) return;
    const body = await page('kind=erp_intent_held');
    expect(body.items.map((i) => i.id)).toEqual(await expectedIds(`kind = 'erp_intent_held'`));
    expect(body.items).toHaveLength(4);
  });

  it('filters by storeId, and by kind and storeId together', async () => {
    if (skipped()) return;
    const y = await page(`storeId=${STORE_A_Y}`);
    expect(y.items.map((i) => i.id)).toEqual(await expectedIds(`store_id = $1`, [STORE_A_Y]));
    expect(y.items).toHaveLength(3);
    const both = await page(`storeId=${STORE_A_X}&kind=sold_under_hold`);
    expect(both.items).toHaveLength(1);
    expect(both.items[0]).toMatchObject({ storeId: STORE_A_X, kind: 'sold_under_hold', cause: 'quality_hold' });
  });

  it('a store_manager sees only its own stores; an out-of-scope storeId is an empty page', async () => {
    if (skipped()) return;
    role = 'store_manager';
    storeAccess = { kind: 'specific', storeIds: [STORE_A_Y] };
    const body = await page();
    expect(body.items.map((i) => i.id)).toEqual(await expectedIds(`store_id = $1`, [STORE_A_Y]));
    expect(await page(`storeId=${STORE_A_X}`)).toEqual({ items: [], nextCursor: null });
  });

  it('a store_manager with no store grant sees nothing (fail closed)', async () => {
    if (skipped()) return;
    role = 'store_manager';
    storeAccess = { kind: 'specific', storeIds: [] };
    expect(await page()).toEqual({ items: [], nextCursor: null });
  });

  it("another tenant's storeId answers an empty page (not 403 / 404)", async () => {
    if (skipped()) return;
    expect(await page(`storeId=${STORE_B_X}`)).toEqual({ items: [], nextCursor: null });
  });

  it("never shows another tenant's findings, and tenant B sees only its own", async () => {
    if (skipped()) return;
    const a = await page();
    expect(a.items.every((i) => i.storeId !== STORE_B_X)).toBe(true);
    tenant = { tenantId: TENANT_B, userId: ACTOR_B };
    const b = await page();
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.storeId).toBe(STORE_B_X);
  });
});

describe('RT-451 S3 listSaleLineFindings — keyset pages', () => {
  it('a walk over more than `limit` rows returns each finding once, in order', async () => {
    if (skipped()) return;
    const first = await page('limit=3');
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const items = await walk('limit=3');
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(await expectedIds());
  });

  it('walks a filtered list with its own cursor', async () => {
    if (skipped()) return;
    const items = await walk(`limit=2&storeId=${STORE_A_X}`);
    expect(items.map((i) => i.id)).toEqual(await expectedIds(`store_id = $1`, [STORE_A_X]));
  });

  it('the last full page ends with nextCursor null', async () => {
    if (skipped()) return;
    const body = await page('limit=10');
    expect(body.items).toHaveLength(10);
    expect(body.nextCursor).toBeNull();
  });

  it('a cursor reused with other filters is a 400 validation_error', async () => {
    if (skipped()) return;
    const { nextCursor } = await page('limit=2');
    for (const query of [
      `limit=2&kind=erp_intent_held&cursor=${encodeURIComponent(nextCursor!)}`,
      `limit=2&storeId=${STORE_A_X}&cursor=${encodeURIComponent(nextCursor!)}`,
    ]) {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
    // The limit is not a filter: the same cursor continues with another page size.
    await page(`limit=5&cursor=${encodeURIComponent(nextCursor!)}`);
  });

  it("a cursor is bound to the tenant: tenant B cannot use tenant A's", async () => {
    if (skipped()) return;
    const { nextCursor } = await page('limit=2');
    tenant = { tenantId: TENANT_B, userId: ACTOR_B };
    const res = await get(`cursor=${encodeURIComponent(nextCursor!)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('a tampered, undecodable or foreign-operation cursor is a 400 validation_error', async () => {
    if (skipped()) return;
    const { nextCursor } = await page('limit=2');
    const payload = JSON.parse(Buffer.from(nextCursor!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const tampered = Buffer.from(JSON.stringify({ ...payload, digest: 'x' }), 'utf8').toString('base64url');
    const extra = Buffer.from(JSON.stringify({ ...payload, role: 'owner' }), 'utf8').toString('base64url');
    const foreign = encodeSafetyHistoryCursor(
      { op: 'tracking_holds', tenantId: TENANT_A, filters: ['all', null, null, null] },
      { atKey: payload['at'] as string, id: payload['id'] as string },
    );
    for (const cursor of [tampered, extra, foreign, 'not-a-cursor', `${nextCursor!}x`]) {
      const res = await get(`cursor=${encodeURIComponent(cursor)}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
  });
});

describe('RT-451 S3 listSaleLineFindings — query validation', () => {
  it.each([
    'limit=0',
    'limit=201',
    'limit=abc',
    'kind=tracking_unresolved',
    'kind=active_tracking_hold',
    'storeId=not-a-uuid',
    'cursor=',
    `cursor=${'a'.repeat(1025)}`,
  ])('%s is a 400 validation_error', async (query) => {
    if (skipped()) return;
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});
