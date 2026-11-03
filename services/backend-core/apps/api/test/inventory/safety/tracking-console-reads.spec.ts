/**
 * Jira RT-1081 — the tracking Console reads and TR-5, end to end over HTTP
 * against real Postgres (Testcontainers, every migration, the NOBYPASSRLS
 * `app_test` role). Contracts: `inventory/inventory.yaml` 1.9.0-draft and
 * `catalog/tracking-profile.yaml` 1.2.0-draft.
 *
 * Per operation: every 200 body conforms to its contract schema (ajv); the
 * role rule of its family (identity reads 404, hold / recall / correction
 * reads 403, the summary admits a store_manager); another tenant's ids are a
 * non-disclosing 404 or an empty page; the keyset lists walk a stable order,
 * a cursor is bound to its filters, and `limit` is 1-200.
 *
 * Positions (OD-6): summed over a store's locations, split by status.
 * TR-5: `other` without a note is a 400 and writes nothing; a code recorded
 * before 1.9.0 (outside the list) still reads back.
 *
 * The role read is a fake (`findRoleCodeForUserInTenant`) behind the real
 * `RolesGuard`. Identities and positions are SEEDED: nothing writes them until
 * RT-453 / RT-451. Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Pool } from 'pg';
import request from 'supertest';

import { PG_POOL } from '../../../src/auth/auth.module';
import { DashboardAuthGuard } from '../../../src/auth/dashboard-auth.guard';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { TrackingProfileController } from '../../../src/catalog/tracking-profile/tracking-profile.controller';
import { TrackingProfileService } from '../../../src/catalog/tracking-profile/tracking-profile.service';
import { GlobalExceptionFilter } from '../../../src/common/exception.filter';
import { MembershipRepository } from '../../../src/context/membership.repository';
import { TenantContextGuard } from '../../../src/context/tenant-context.guard';
import type { ResolvedContext } from '../../../src/context/types';
import { InventoryService } from '../../../src/inventory/inventory.service';
import { IdentityExpiryService } from '../../../src/inventory/safety/identity-expiry.service';
import { InventoryRecallsService } from '../../../src/inventory/safety/inventory-recalls.service';
import { InventorySafetyController } from '../../../src/inventory/safety/inventory-safety.controller';
import { SafetyFindingsService } from '../../../src/inventory/safety/safety-findings.service';
import { SafetyHistoryService } from '../../../src/inventory/safety/safety-history.service';
import { SafetyTtlService } from '../../../src/inventory/safety/safety-ttl.service';
import { TrackingHoldsService } from '../../../src/inventory/safety/tracking-holds.service';
import { TrackingIdentitiesController } from '../../../src/inventory/tracking-identities.controller';
import { TrackingIdentityReadsService } from '../../../src/inventory/tracking-identity-reads.service';
import { startPgEnvOrSkip } from '../../_helpers/device-module-app';
import { allContracts, contractDocument } from '../../_helpers/openapi-contract';
import { stopPgEnv, type PgTestEnv } from '../../_helpers/postgres-container';
import {
  ACTOR_A,
  ACTOR_B,
  PRODUCT_B_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  TENANT_A,
  TENANT_B,
  seedCatalogIsolationFixture,
} from '../../catalog/__support__/isolation-harness';

// `1081` mnemonic, hex-safe.
const PRODUCT_T = '0a000000-0000-7000-8000-000010810a01';
const PRODUCT_T2 = '0a000000-0000-7000-8000-000010810a02';
const PRODUCT_TB_RETIRED = '0b000000-0000-7000-8000-000010810b01';
const ID_POS = '0a000000-0000-7000-8000-000010810c01';
const ID_HELD = '0a000000-0000-7000-8000-000010810c02';
const ID_RECALLED = '0a000000-0000-7000-8000-000010810c03';
const ID_OTHER_PRODUCT = '0a000000-0000-7000-8000-000010810c04';
const UNKNOWN = '0a000000-0000-7000-8000-000010810fff';

const HOLDS = '/api/inventory/v1/tracking-holds';
const RECALLS = '/api/inventory/v1/recalls';
const IDENTITY = (id: string): string => `/api/inventory/v1/tracking-identities/${id}`;
const POSITIONS = (id: string): string => `${IDENTITY(id)}/positions`;
const CORRECTIONS = (id: string): string => `${IDENTITY(id)}/expiry-corrections`;
const SUMMARY = '/api/v1/catalog/tracking-summary';

let env: PgTestEnv | null = null;
let admin: Pool;
let app: INestApplication;
let holds: TrackingHoldsService;
let role = 'owner';
let tenant: { tenantId: string; userId: string } = { tenantId: TENANT_A, userId: ACTOR_A };
let storeAccess: NonNullable<ResolvedContext['storeAccess']> = { kind: 'all' };
let keySeq = 0;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

function conforms(contract: 'inventory' | 'tracking-profile', name: string, body: unknown): void {
  const validate = ajv.getSchema(`${contract}#/components/schemas/${name}`);
  if (!validate) throw new Error(`ajv cannot resolve ${contract} ${name}`);
  if (!validate(body)) throw new Error(`contract violation (${name}): ${JSON.stringify(validate.errors)}`);
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
  findRoleCodeForUserInTenant: async (): Promise<string> => role,
  isPlatformAdmin: async (): Promise<boolean> => false,
};

function http(): ReturnType<typeof request> {
  return request(app.getHttpServer());
}

function post(path: string, body: object): request.Test {
  keySeq += 1;
  return http().post(path).set('Idempotency-Key', `rt1081-key-${keySeq}`).send(body);
}

async function count(table: string): Promise<number> {
  const r = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(r.rows[0]!.n);
}

/** One identity-grain effect at `location` (null = the store's primary). */
async function seedEffect(storeId: string, status: string, quantity: string, location: string | null = null): Promise<void> {
  await admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason,
        occurred_at, created_by, stock_location_id, inventory_status, tracking_identity_id)
     SELECT gen_random_uuid(), $1, $2, 'adjustment', $3::numeric, 'ea', $4, 'rt1081 fixture', now(), $5,
            COALESCE($6::uuid, l.id), $7, $8
       FROM stock_locations l WHERE l.store_id = $2 AND l.kind = 'primary'`,
    [TENANT_A, storeId, quantity, PRODUCT_T, ACTOR_A, location, status, ID_POS],
  );
}

/** Every page of a keyset list, following `nextCursor`. */
async function walk(path: string, query: string): Promise<Array<{ id: string }>> {
  const items: Array<{ id: string }> = [];
  let cursor: string | null = null;
  do {
    const sep = query.length > 0 ? '&' : '';
    const url: string = `${path}?${query}${cursor === null ? '' : `${sep}cursor=${encodeURIComponent(cursor)}`}`;
    const res = await http().get(url).expect(200);
    items.push(...(res.body.items as Array<{ id: string }>));
    cursor = res.body.nextCursor as string | null;
  } while (cursor !== null);
  return items;
}

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-1081 tracking Console reads');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'rt1081-a@fixture.invalid', NULL),
       ($2, 'rt1081-b@fixture.invalid', NULL) ON CONFLICT DO NOTHING`,
    [ACTOR_A, ACTOR_B],
  );
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode, retired_at)
     VALUES ($1, $4, 'RT-1081 tracked', 'standard', $6, $6, 'batch', NULL),
            ($2, $4, 'RT-1081 tracked 2', 'standard', $6, $6, 'batch', NULL),
            ($3, $5, 'RT-1081 retired tracked', 'standard', $7, $7, 'batch', now())`,
    [PRODUCT_T, PRODUCT_T2, PRODUCT_TB_RETIRED, TENANT_A, TENANT_B, ACTOR_A, ACTOR_B],
  );
  await admin.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date)
     VALUES ($1, $5, $6, 'batch', 'RT1081-POS', '2027-01-31'),
            ($2, $5, $6, 'batch', 'RT1081-HELD', '2027-02-28'),
            ($3, $5, $6, 'batch', 'RT1081-RECALLED', NULL),
            ($4, $5, $7, 'batch', 'RT1081-OTHER', NULL)`,
    [ID_POS, ID_HELD, ID_RECALLED, ID_OTHER_PRODUCT, TENANT_A, PRODUCT_T, PRODUCT_T2],
  );

  const pool = env.app as unknown as Pool;
  holds = new TrackingHoldsService(pool);
  const moduleRef = await Test.createTestingModule({
    controllers: [InventorySafetyController, TrackingIdentitiesController, TrackingProfileController],
    providers: [
      { provide: PG_POOL, useValue: pool },
      { provide: MembershipRepository, useValue: memberships },
      TrackingHoldsService,
      InventoryRecallsService,
      IdentityExpiryService,
      SafetyTtlService,
      SafetyFindingsService,
      SafetyHistoryService,
      InventoryService,
      TrackingIdentityReadsService,
      TrackingProfileService,
      RolesGuard,
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue(new ContextGuard())
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();

  ajv.addSchema(contractDocument(allContracts(), 'inventory') as object, 'inventory');
  ajv.addSchema(contractDocument(allContracts(), 'tracking-profile') as object, 'tracking-profile');
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  role = 'owner';
  tenant = { tenantId: TENANT_A, userId: ACTOR_A };
  storeAccess = { kind: 'all' };
});

const skipped = (): boolean => env === null;

describe('RT-1081 TR-5 reason codes', () => {
  it.each<[string, string, object]>([
    ['a quality hold', HOLDS, { trackingIdentityId: ID_HELD, reasonCode: 'other', note: '   ' }],
    ['a recall', RECALLS, { tenantProductRef: PRODUCT_T, trackingIdentityIds: [ID_RECALLED], reasonCode: 'other', reference: 'R-1' }],
    ['an expiry correction', CORRECTIONS(ID_HELD), { expiryDate: '2027-03-31', reasonCode: 'other', note: '' }],
  ])('%s with `other` and an empty or whitespace note is a 400 and writes nothing', async (_label, path, body) => {
    if (skipped()) return;
    const before = await Promise.all(
      ['tracking_holds', 'inventory_recalls', 'tracking_identity_expiry_corrections', 'inventory_safety_changes'].map(count),
    );
    const res = await post(path, body).expect(400);
    expect(res.body.error.code).toBe('validation_error');
    const after = await Promise.all(
      ['tracking_holds', 'inventory_recalls', 'tracking_identity_expiry_corrections', 'inventory_safety_changes'].map(count),
    );
    expect(after).toEqual(before);
  });

  it('an unknown code is a 400', async () => {
    if (skipped()) return;
    await post(HOLDS, { trackingIdentityId: ID_HELD, reasonCode: 'recall' }).expect(400);
  });
});

describe('RT-1081 seeding the history through the real commands', () => {
  it('places, releases and recalls with governed codes, and keeps a legacy code', async () => {
    if (skipped()) return;
    const first = await post(HOLDS, { trackingIdentityId: ID_HELD, reasonCode: 'other', note: 'smell' }).expect(201);
    await http().post(`${HOLDS}/${first.body.hold.id as string}/release`).send({}).expect(200);
    await post(HOLDS, { trackingIdentityId: ID_HELD, reasonCode: 'label_misprint' }).expect(201);
    await post(RECALLS, {
      tenantProductRef: PRODUCT_T,
      trackingIdentityIds: [ID_HELD, ID_RECALLED],
      reasonCode: 'authority_notice',
      reference: 'EDA-1081',
    }).expect(201);
    // A code recorded before 1.9.0: the services keep the 0072 pattern, only the DTO narrowed.
    await holds.placeQualityHold({
      tenantId: TENANT_A,
      userId: ACTOR_A,
      // Built, not a literal: the root gitleaks scan reads a quoted `*Key: '…'` value as a credential.
      idempotencyKey: ['rt1081', 'legacy', String(keySeq)].join('-'),
      trackingIdentityId: ID_OTHER_PRODUCT,
      reasonCode: 'legacy_supplier_recall',
      note: null,
    });
    await post(CORRECTIONS(ID_HELD), { expiryDate: '2027-03-31', reasonCode: 'supplier_notice' }).expect(201);
    await post(CORRECTIONS(ID_HELD), { expiryDate: '2027-04-30', reasonCode: 'other', note: 'reprint' }).expect(201);
    expect(await count('tracking_holds')).toBe(5);
  });
});

describe('listTrackingHolds', () => {
  it('lists every hold newest first, with the strict projection, and a legacy code reads back', async () => {
    if (skipped()) return;
    const res = await http().get(HOLDS).expect(200);
    conforms('inventory', 'TrackingHoldList', res.body);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.nextCursor).toBeNull();
    const placed = (res.body.items as Array<{ placedAt: string }>).map((h) => h.placedAt);
    expect([...placed].sort().reverse()).toEqual(placed);
    expect((res.body.items as Array<{ reasonCode: string }>)[0]!.reasonCode).toBe('legacy_supplier_recall');
  });

  it('narrows by status, kind, identity and product, never widening', async () => {
    if (skipped()) return;
    const ids = async (q: string) =>
      ((await http().get(`${HOLDS}?${q}`).expect(200)).body.items as Array<{ id: string }>).length;
    expect(await ids('status=released')).toBe(1);
    expect(await ids('status=active')).toBe(4);
    expect(await ids('kind=recall_hold')).toBe(2);
    expect(await ids(`trackingIdentityId=${ID_HELD}`)).toBe(3);
    expect(await ids(`trackingIdentityId=${ID_HELD}&status=active&kind=quality_hold`)).toBe(1);
    expect(await ids(`productId=${PRODUCT_T2}`)).toBe(1);
    expect(await ids(`productId=${PRODUCT_B_ACTIVE}`)).toBe(0);
  });

  it('walks one page at a time in the same order, ending with a null cursor', async () => {
    if (skipped()) return;
    const all = (await http().get(HOLDS).expect(200)).body.items as Array<{ id: string }>;
    expect((await walk(HOLDS, 'limit=1')).map((h) => h.id)).toEqual(all.map((h) => h.id));
    expect((await walk(HOLDS, 'limit=2&status=active')).map((h) => h.id)).toEqual(
      (all as Array<{ id: string; active?: boolean }>).filter((h) => h.active).map((h) => h.id),
    );
  });

  it('binds the cursor to its filters and tenant; a forged or reused one is a 400', async () => {
    if (skipped()) return;
    const page = await http().get(`${HOLDS}?limit=1&status=active`).expect(200);
    const cursor = encodeURIComponent(page.body.nextCursor as string);
    await http().get(`${HOLDS}?limit=1&status=active&cursor=${cursor}`).expect(200);
    await http().get(`${HOLDS}?limit=1&status=released&cursor=${cursor}`).expect(400);
    await http().get(`${HOLDS}?limit=1&cursor=${cursor}`).expect(400);
    await http().get(`${RECALLS}?limit=1&cursor=${cursor}`).expect(400);
    await http().get(`${HOLDS}?cursor=bm90LWEtY3Vyc29y`).expect(400);
    tenant = { tenantId: TENANT_B, userId: ACTOR_B };
    await http().get(`${HOLDS}?limit=1&status=active&cursor=${cursor}`).expect(400);
  });

  it('bounds limit to 1-200', async () => {
    if (skipped()) return;
    await http().get(`${HOLDS}?limit=0`).expect(400);
    await http().get(`${HOLDS}?limit=201`).expect(400);
    await http().get(`${HOLDS}?limit=200`).expect(200);
  });
});

describe('listInventoryRecalls', () => {
  it('summarizes each recall with its hold counts, newest first, and pages', async () => {
    if (skipped()) return;
    const res = await http().get(RECALLS).expect(200);
    conforms('inventory', 'InventoryRecallSummaryList', res.body);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        tenantProductRef: PRODUCT_T,
        reasonCode: 'authority_notice',
        reference: 'EDA-1081',
        holdCount: 2,
        activeHoldCount: 2,
      }),
    ]);
    expect((await http().get(`${RECALLS}?productId=${PRODUCT_T}&limit=1`).expect(200)).body.nextCursor).toBeNull();
    expect((await http().get(`${RECALLS}?productId=${PRODUCT_T2}`).expect(200)).body.items).toEqual([]);
  });
});

describe('listTrackingIdentityExpiryCorrections', () => {
  it('lists the identity history newest first, one page at a time', async () => {
    if (skipped()) return;
    const res = await http().get(CORRECTIONS(ID_HELD)).expect(200);
    conforms('inventory', 'TrackingIdentityExpiryCorrectionList', res.body);
    expect(res.body.items.map((c: { newExpiryDate: string }) => c.newExpiryDate)).toEqual(['2027-04-30', '2027-03-31']);
    expect(res.body.items[0]).toMatchObject({ reasonCode: 'other', note: 'reprint', oldExpiryDate: '2027-03-31' });
    expect((await walk(CORRECTIONS(ID_HELD), 'limit=1')).map((c) => c.id)).toEqual(
      res.body.items.map((c: { id: string }) => c.id),
    );
    expect((await http().get(CORRECTIONS(ID_POS)).expect(200)).body).toEqual({ items: [], nextCursor: null });
  });

  it('binds the cursor to the identity', async () => {
    if (skipped()) return;
    const page = await http().get(`${CORRECTIONS(ID_HELD)}?limit=1`).expect(200);
    const cursor = encodeURIComponent(page.body.nextCursor as string);
    await http().get(`${CORRECTIONS(ID_POS)}?cursor=${cursor}`).expect(400);
  });

  it('an unknown identity is a non-disclosing 404', async () => {
    if (skipped()) return;
    await http().get(CORRECTIONS(UNKNOWN)).expect(404);
  });
});

describe('getTrackingIdentity and getTrackingIdentityPositions', () => {
  it('reads one identity with the list projection', async () => {
    if (skipped()) return;
    const res = await http().get(IDENTITY(ID_POS)).expect(200);
    conforms('inventory', 'TrackingIdentity', res.body);
    expect(res.body).toEqual({
      id: ID_POS,
      productId: PRODUCT_T,
      kind: 'batch',
      code: 'RT1081-POS',
      expiryDate: '2027-01-31',
      manufacturedOn: null,
      origin: 'erp_external',
    });
    await http().get(IDENTITY(UNKNOWN)).expect(404);
  });

  it('an identity without movements has no positions', async () => {
    if (skipped()) return;
    const res = await http().get(POSITIONS(ID_POS)).expect(200);
    conforms('inventory', 'TrackingIdentityPositions', res.body);
    expect(res.body).toEqual({ trackingIdentityId: ID_POS, tenantProductRef: PRODUCT_T, stores: [] });
  });

  it('sums over the store locations (OD-6) and splits by status, per store', async () => {
    if (skipped()) return;
    const storage = await admin.query<{ id: string }>(
      `INSERT INTO stock_locations (tenant_id, store_id, code, name, kind)
       VALUES ($1, $2, 'RT1081-BACK', 'Back room', 'storage') RETURNING id::text AS id`,
      [TENANT_A, STORE_A_X],
    );
    await seedEffect(STORE_A_X, 'sellable', '5');
    await seedEffect(STORE_A_X, 'sellable', '-5', storage.rows[0]!.id);
    await seedEffect(STORE_A_X, 'quality_hold', '3');
    await seedEffect(STORE_A_Y, 'sellable', '2.5');
    const res = await http().get(POSITIONS(ID_POS)).expect(200);
    conforms('inventory', 'TrackingIdentityPositions', res.body);
    const zero = '0.0000';
    expect(res.body.stores).toEqual(
      [
        {
          storeId: STORE_A_X,
          stockingUnit: 'ea',
          quantity: '3.0000',
          sellableQuantity: zero,
          statusQuantities: [
            { inventoryStatus: 'sellable', quantity: zero },
            { inventoryStatus: 'return_inspection', quantity: zero },
            { inventoryStatus: 'quality_hold', quantity: '3.0000' },
            { inventoryStatus: 'damaged', quantity: zero },
            { inventoryStatus: 'expired', quantity: zero },
            { inventoryStatus: 'recall_hold', quantity: zero },
          ],
        },
        // STORE_A_X sorts before STORE_A_Y: rows are ordered by store id.
        expect.objectContaining({ storeId: STORE_A_Y, quantity: '2.5000', sellableQuantity: '2.5000' }),
      ],
    );
  });

  it('narrows to the stores of a membership with specific store access', async () => {
    if (skipped()) return;
    storeAccess = { kind: 'specific', storeIds: [STORE_A_Y] };
    const res = await http().get(POSITIONS(ID_POS)).expect(200);
    expect(res.body.stores.map((s: { storeId: string }) => s.storeId)).toEqual([STORE_A_Y]);
  });
});

describe('getTenantTrackingSummary', () => {
  it('is true for a tenant with a tracked product that is not retired', async () => {
    if (skipped()) return;
    const res = await http().get(SUMMARY).expect(200);
    conforms('tracking-profile', 'TenantTrackingSummary', res.body);
    expect(res.body).toEqual({ hasTrackedProducts: true });
  });

  it('is false when the only tracked product is retired', async () => {
    if (skipped()) return;
    tenant = { tenantId: TENANT_B, userId: ACTOR_B };
    expect((await http().get(SUMMARY).expect(200)).body).toEqual({ hasTrackedProducts: false });
  });
});

describe('RT-1081 another tenant', () => {
  it('sees no hold, recall or tenant-A identity: empty pages and non-disclosing 404s', async () => {
    if (skipped()) return;
    tenant = { tenantId: TENANT_B, userId: ACTOR_B };
    expect((await http().get(HOLDS).expect(200)).body).toEqual({ items: [], nextCursor: null });
    expect((await http().get(`${HOLDS}?trackingIdentityId=${ID_HELD}`).expect(200)).body.items).toEqual([]);
    expect((await http().get(RECALLS).expect(200)).body).toEqual({ items: [], nextCursor: null });
    await http().get(IDENTITY(ID_POS)).expect(404);
    await http().get(POSITIONS(ID_POS)).expect(404);
    await http().get(CORRECTIONS(ID_HELD)).expect(404);
  });
});

describe('RT-1081 roles', () => {
  it.each(['store_manager', 'store_staff'])('a %s: hold, recall and correction reads 403, identity reads 404', async (r) => {
    if (skipped()) return;
    role = r;
    await http().get(HOLDS).expect(403);
    await http().get(RECALLS).expect(403);
    await http().get(CORRECTIONS(ID_HELD)).expect(403);
    await http().get(IDENTITY(ID_POS)).expect(404);
    await http().get(POSITIONS(ID_POS)).expect(404);
  });

  it('a tenant_admin reads every list and identity', async () => {
    if (skipped()) return;
    role = 'tenant_admin';
    for (const path of [HOLDS, RECALLS, CORRECTIONS(ID_HELD), IDENTITY(ID_POS), POSITIONS(ID_POS), SUMMARY]) {
      await http().get(path).expect(200);
    }
  });

  it('a store_manager reads the tracking summary; a store_staff is a 403', async () => {
    if (skipped()) return;
    role = 'store_manager';
    await http().get(SUMMARY).expect(200);
    role = 'store_staff';
    const res = await http().get(SUMMARY).expect(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});
