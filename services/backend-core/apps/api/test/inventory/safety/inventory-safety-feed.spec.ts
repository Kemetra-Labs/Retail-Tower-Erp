/**
 * Jira RT-449 PR 2 — the POS inventory safety feed against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` role), driven
 * by the real PR 1 safety commands. Contract:
 * `packages/contracts/openapi/inventory/inventory-safety-feed.yaml`.
 *
 * What this proves (RT-449 acceptance criteria and rulings H5, H8):
 *   - the snapshot answers every active hold of the tenant at one revision,
 *     paginated without losing or repeating a hold, and 0 before any change;
 *   - the delta returns only changes after `since`; a recall of two
 *     identities is two upserts from one revision step; a release is a
 *     removal; an expiry correction re-answers the hold with its new expiry; a
 *     tracking-profile change advances the revision with no row;
 *   - `since` above the current revision is `snapshot_required`;
 *   - the effective Safety TTL rides on every answer;
 *   - over HTTP, behind the real `PosDeviceAuthGuard`: no or a revoked token
 *     is 401, a `branch_id` that is not the device's store and a foreign page
 *     token are a non-disclosing 404, another tenant's device sees none of
 *     this tenant's holds, and bodies match the contract schemas.
 *
 * The identities are SEEDED: nothing writes `tracking_identities` until
 * RT-453 (F6). Docker policy: hard failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { Module, type INestApplication } from '@nestjs/common';
import { hashToken } from '@data-pulse-2/auth';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Pool } from 'pg';
import request from 'supertest';

import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from '../../../src/auth/auth.module';
import { PosDeviceAuthGuard } from '../../../src/auth/pos-device-auth.guard';
import { TrackingProfileService } from '../../../src/catalog/tracking-profile/tracking-profile.service';
import { encodePageToken } from '../../../src/inventory/safety/inventory-safety-feed.cursor';
import { InventorySafetyFeedController } from '../../../src/inventory/safety/inventory-safety-feed.controller';
import {
  InventorySafetyFeedService,
  type InventorySafetyDeltaPage,
  type InventorySafetySnapshotPage,
} from '../../../src/inventory/safety/inventory-safety-feed.service';
import { IdentityExpiryService } from '../../../src/inventory/safety/identity-expiry.service';
import { InventoryRecallsService } from '../../../src/inventory/safety/inventory-recalls.service';
import { TrackingHoldsService } from '../../../src/inventory/safety/tracking-holds.service';
import { DeviceRepository } from '../../../src/pos-operators/device.repository';
import { bootDeviceModuleApp, startPgEnvOrSkip } from '../../_helpers/device-module-app';
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

// `0449` / `f2` mnemonic, hex-safe.
const PRODUCT_T = '0a000000-0000-7000-8000-0000044f2001';
const PRODUCT_P = '0a000000-0000-7000-8000-0000044f2002';
const PRODUCT_TB = '0b000000-0000-7000-8000-0000044f2001';
const device = (n: string) => ({
  id: `0a000000-0000-7000-8000-0000044fd00${n}`,
  token: `rt449-feed-device-token-${n}-aaaaaaaaaaaaaaaa`,
});
const DEV_A_X = device('1');
const DEV_B_X = device('2');
const DEV_REVOKED = device('3');

/** Feed controller, service and the real device guard, without the rest of InventoryModule. */
@Module({
  imports: [AuthModule],
  controllers: [InventorySafetyFeedController],
  providers: [
    InventorySafetyFeedService,
    {
      provide: DeviceRepository,
      useFactory: (lookup: Pool, domain: Pool): DeviceRepository => new DeviceRepository(lookup, domain),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    PosDeviceAuthGuard,
  ],
})
class FeedTestModule {}

let env: PgTestEnv | null = null;
let admin: Pool;
let app: INestApplication;
let feed: InventorySafetyFeedService;
let holds: TrackingHoldsService;
let recalls: InventoryRecallsService;
let expiry: IdentityExpiryService;
let profiles: TrackingProfileService;
let seq = 0;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

function conforms(name: string, body: unknown): void {
  const validate = ajv.getSchema(`inventory-safety-feed#/components/schemas/${name}`);
  if (!validate) throw new Error(`ajv cannot resolve ${name}`);
  if (!validate(body)) throw new Error(`contract violation (${name}): ${JSON.stringify(validate.errors)}`);
}

function key(): string {
  seq += 1;
  return `rt449-feed-${String(seq).padStart(6, '0')}`;
}

async function newIdentity(opts: { tenantId?: string; product?: string; expiry?: string | null } = {}): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO tracking_identities (tenant_id, tenant_product_ref, kind, code, expiry_date)
     VALUES ($1, $2, 'batch', $3, $4) RETURNING id::text AS id`,
    [opts.tenantId ?? TENANT_A, opts.product ?? PRODUCT_T, `FEED-${key()}`, opts.expiry ?? null],
  );
  return r.rows[0]!.id;
}

async function placeHold(identity: string, tenantId = TENANT_A, userId = ACTOR_A): Promise<string> {
  const r = await holds.placeQualityHold({
    tenantId,
    userId,
    idempotencyKey: key(),
    trackingIdentityId: identity,
    reasonCode: 'supplier_notice',
    note: null,
  });
  return r.hold.id;
}

async function release(holdId: string): Promise<void> {
  await holds.releaseHold({ tenantId: TENANT_A, userId: ACTOR_A, holdId, note: null });
}

async function currentRevision(tenantId = TENANT_A): Promise<number> {
  const r = await admin.query<{ revision: string }>(
    `SELECT revision::text AS revision FROM tenant_inventory_safety_revisions WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(r.rows[0]?.revision ?? 0);
}

async function activeHoldIds(tenantId = TENANT_A): Promise<string[]> {
  const r = await admin.query<{ id: string }>(
    `SELECT id::text AS id FROM tracking_holds WHERE tenant_id = $1 AND released_at IS NULL ORDER BY id`,
    [tenantId],
  );
  return r.rows.map((row) => row.id);
}

/** Page through the whole snapshot with `limit`. */
async function fullSnapshot(limit: number): Promise<{ revision: number; ids: string[]; pages: number }> {
  let token: string | null = null;
  const ids: string[] = [];
  let revision = -1;
  let pages = 0;
  do {
    const page: InventorySafetySnapshotPage = await feed.getSnapshot(TENANT_A, STORE_A_X, { limit, pageToken: token });
    if (revision === -1) revision = page.revision;
    expect(page.revision).toBe(revision);
    ids.push(...page.holds.map((h) => h.hold_id));
    token = page.next_page_token;
    pages += 1;
  } while (token !== null);
  return { revision, ids, pages };
}

async function delta(since: number, limit?: number): Promise<InventorySafetyDeltaPage> {
  const result = await feed.getDeltas(TENANT_A, since, { limit });
  if (result.kind !== 'page') throw new Error('expected a delta page');
  return result.page;
}

const server = () => app.getHttpServer() as Parameters<typeof request>[0];
const asDevice = (d: { token: string }, path: string) =>
  request(server()).get(path).set('Authorization', `Bearer ${d.token}`);

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-449 inventory safety feed');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'feed-a@fixture.invalid', NULL), ($2, 'feed-b@fixture.invalid', NULL)
     ON CONFLICT DO NOTHING`,
    [ACTOR_A, ACTOR_B],
  );
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode) VALUES
       ($1, $4, 'Feed tracked', 'standard', $6, $6, 'batch'), ($2, $4, 'Feed profile', 'standard', $6, $6, 'batch'),
       ($3, $5, 'Feed tracked B', 'standard', $7, $7, 'batch')`,
    [PRODUCT_T, PRODUCT_P, PRODUCT_TB, TENANT_A, TENANT_B, ACTOR_A, ACTOR_B],
  );
  for (const [d, tenant, store] of [
    [DEV_A_X, TENANT_A, STORE_A_X],
    [DEV_B_X, TENANT_B, STORE_B_X],
    [DEV_REVOKED, TENANT_A, STORE_A_X],
  ] as const) {
    await admin.query(`INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, 'till', $4)`, [
      d.id,
      tenant,
      store,
      hashToken(d.token),
    ]);
  }
  await admin.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEV_REVOKED.id]);
  const pool = env.app as unknown as Pool;
  feed = new InventorySafetyFeedService(pool);
  holds = new TrackingHoldsService(pool);
  recalls = new InventoryRecallsService(pool);
  expiry = new IdentityExpiryService(pool);
  profiles = new TrackingProfileService(pool);
  ajv.addSchema(contractDocument(allContracts(), 'inventory-safety-feed') as object, 'inventory-safety-feed');
  app = await bootDeviceModuleApp(FeedTestModule, { domain: env.app, lookup: admin });
}, 240_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

const skipped = (): boolean => env === null;

// The cases share one database and run in order: each starts from the state
// the previous ones left and reads the revision before acting.

describe('snapshot', () => {
  it('is empty at revision 0 before the tenant has a safety change', async () => {
    if (skipped()) return;
    const page = await feed.getSnapshot(TENANT_A, STORE_A_X, { limit: undefined, pageToken: null });
    expect(page).toMatchObject({ revision: 0, holds: [], next_page_token: null, safety_ttl_seconds: 900 });
    conforms('InventorySafetySnapshotPage', page);
  });

  it('answers every active hold of the tenant, with its identity and product', async () => {
    if (skipped()) return;
    const identity = await newIdentity({ expiry: '2027-03-31' });
    const holdId = await placeHold(identity);
    const page = await feed.getSnapshot(TENANT_A, STORE_A_Y, { limit: undefined, pageToken: null });
    expect(page.revision).toBe(await currentRevision());
    const row = page.holds.find((h) => h.hold_id === holdId);
    expect(row).toMatchObject({
      kind: 'quality_hold',
      tracking_identity_id: identity,
      product_id: PRODUCT_T,
      identity_kind: 'batch',
      expiry_date: '2027-03-31',
      reason_code: 'supplier_notice',
      recall_id: null,
    });
    conforms('InventorySafetySnapshotPage', page);
  });

  it('pages through every active hold once, all pages at the first page revision', async () => {
    if (skipped()) return;
    for (let i = 0; i < 4; i += 1) await placeHold(await newIdentity());
    const released = await placeHold(await newIdentity());
    await release(released);
    const { revision, ids, pages } = await fullSnapshot(2);
    expect(revision).toBe(await currentRevision());
    expect(ids).toEqual(await activeHoldIds());
    expect(ids).not.toContain(released);
    expect(pages).toBeGreaterThan(2);
  });

  it('keeps the first page revision on later pages even after a new change', async () => {
    if (skipped()) return;
    const first = await feed.getSnapshot(TENANT_A, STORE_A_X, { limit: 1, pageToken: null });
    await placeHold(await newIdentity());
    const second = await feed.getSnapshot(TENANT_A, STORE_A_X, { limit: 1, pageToken: first.next_page_token });
    expect(second.revision).toBe(first.revision);
    expect(await currentRevision()).toBe(first.revision + 1);
  });

  it('converges with the deltas when holds change while the pages are read', async () => {
    if (skipped()) return;
    // Three holds of its own, so page 1 (limit 2) is followed by another page when run alone.
    for (let i = 0; i < 3; i += 1) await placeHold(await newIdentity());
    // Page 1, then a release of a hold page 1 served and a new placement, then the rest.
    const first = await feed.getSnapshot(TENANT_A, STORE_A_X, { limit: 2, pageToken: null });
    const held = new Set(first.holds.map((h) => h.hold_id));
    await release(first.holds[0]!.hold_id);
    await placeHold(await newIdentity());
    let token = first.next_page_token;
    while (token !== null) {
      const page = await feed.getSnapshot(TENANT_A, STORE_A_X, { limit: 2, pageToken: token });
      expect(page.revision).toBe(first.revision);
      page.holds.forEach((h) => held.add(h.hold_id));
      token = page.next_page_token;
    }
    // The snapshot is not a point-in-time image; the deltas from its revision make it one.
    let since = first.revision;
    for (;;) {
      const page = await delta(since, 1);
      page.upserts.forEach((h) => held.add(h.hold_id));
      page.removals.forEach((r) => held.delete(r.hold_id));
      since = page.revision;
      if (!page.has_more) break;
    }
    expect([...held].sort()).toEqual(await activeHoldIds());
    expect(since).toBe(await currentRevision());
  });

  it('refuses a page token of another store, another tenant, or garbage', async () => {
    if (skipped()) return;
    // Two holds of its own, so page 1 (limit 1) carries a next page token when run alone.
    for (let i = 0; i < 2; i += 1) await placeHold(await newIdentity());
    const first = await feed.getSnapshot(TENANT_A, STORE_A_X, { limit: 1, pageToken: null });
    const token = first.next_page_token as string;
    await expect(feed.getSnapshot(TENANT_A, STORE_A_Y, { limit: 1, pageToken: token })).rejects.toThrow('scope');
    await expect(feed.getSnapshot(TENANT_B, STORE_A_X, { limit: 1, pageToken: token })).rejects.toThrow('scope');
    for (const bad of [
      'not-base64-json',
      Buffer.from('null').toString('base64url'),
      encodePageToken({ tenantId: TENANT_A, storeId: STORE_A_X, revision: 1, afterHoldId: 'nope' }),
      Buffer.from(JSON.stringify({ t: TENANT_A, s: STORE_A_X, r: -1, a: first.holds[0]!.hold_id })).toString(
        'base64url',
      ),
    ]) {
      await expect(feed.getSnapshot(TENANT_A, STORE_A_X, { limit: 1, pageToken: bad })).rejects.toThrow('malformed');
    }
  });
});

describe('delta', () => {
  it('returns only the changes after since', async () => {
    if (skipped()) return;
    const since = await currentRevision();
    expect(await delta(since)).toMatchObject({ from_revision: since, revision: since, upserts: [], removals: [], has_more: false });
    const holdId = await placeHold(await newIdentity());
    const page = await delta(since);
    expect(page.upserts.map((h) => h.hold_id)).toEqual([holdId]);
    expect(page).toMatchObject({ revision: since + 1, removals: [], has_more: false });
    conforms('InventorySafetyDeltaPage', page);
  });

  it('answers a recall of two identities as two upserts from one revision step', async () => {
    if (skipped()) return;
    const since = await currentRevision();
    const [one, two] = [await newIdentity(), await newIdentity()];
    const { recall } = await recalls.createRecall({
      tenantId: TENANT_A,
      userId: ACTOR_A,
      idempotencyKey: key(),
      tenantProductRef: PRODUCT_T,
      trackingIdentityIds: [one, two],
      reasonCode: 'authority_notice',
      reference: 'EDA-2026-449',
      note: null,
      effectiveAt: null,
    });
    const page = await delta(since);
    expect(page.revision).toBe(since + 1);
    expect(page.upserts.map((h) => h.tracking_identity_id).sort()).toEqual([one, two].sort());
    expect(page.upserts.every((h) => h.kind === 'recall_hold' && h.recall_id === recall.id)).toBe(true);
  });

  it('answers a released hold as a removal, and a place-then-release inside one call as a removal only', async () => {
    if (skipped()) return;
    const placedEarlier = await placeHold(await newIdentity());
    const since = await currentRevision();
    await release(placedEarlier);
    const both = await placeHold(await newIdentity());
    await release(both);
    const page = await delta(since);
    expect(page.upserts).toEqual([]);
    expect(page.removals.map((r) => r.hold_id).sort()).toEqual([placedEarlier, both].sort());
    expect(page.revision).toBe(since + 3);
  });

  it('re-answers the holds of a corrected identity with its new expiry', async () => {
    if (skipped()) return;
    const identity = await newIdentity({ expiry: '2027-01-31' });
    const holdId = await placeHold(identity);
    const since = await currentRevision();
    await expiry.correctExpiry({
      tenantId: TENANT_A,
      userId: ACTOR_A,
      idempotencyKey: key(),
      trackingIdentityId: identity,
      expiryDate: '2026-12-31',
      reasonCode: 'label_misprint',
      note: null,
    });
    const page = await delta(since);
    expect(page.upserts).toEqual([expect.objectContaining({ hold_id: holdId, expiry_date: '2026-12-31' })]);
    expect(page.revision).toBe(since + 1);
  });

  it('advances the revision for a tracking-profile change with no row', async () => {
    if (skipped()) return;
    const since = await currentRevision();
    const set = await profiles.set({
      tenantId: TENANT_A,
      productId: PRODUCT_P,
      trackingMode: 'none',
      expiryRequired: false,
      actorUserId: ACTOR_A,
    });
    expect(set.kind).toBe('ok');
    expect(await delta(since)).toMatchObject({ revision: since + 1, upserts: [], removals: [], has_more: false });
  });

  it('pages by revision step with has_more, and converges on the snapshot', async () => {
    if (skipped()) return;
    const before = await activeHoldIds();
    const since = await currentRevision();
    const placed = [await placeHold(await newIdentity()), await placeHold(await newIdentity())];
    await release(placed[0]!);
    const first = await delta(since, 2);
    expect(first).toMatchObject({ revision: since + 2, has_more: true });
    const second = await delta(first.revision, 2);
    expect(second).toMatchObject({ revision: since + 3, has_more: false });
    // Apply both pages to the state at `since`.
    const state = new Set(before);
    for (const page of [first, second]) {
      for (const u of page.upserts) state.add(u.hold_id);
      for (const r of page.removals) state.delete(r.hold_id);
    }
    expect([...state].sort()).toEqual(await activeHoldIds());
  });

  it('asks for a snapshot when since is above the current revision', async () => {
    if (skipped()) return;
    const current = await currentRevision();
    expect(await feed.getDeltas(TENANT_A, current + 1, { limit: undefined })).toEqual({ kind: 'snapshot_required' });
  });

  it('answers the tenant configured Safety TTL', async () => {
    if (skipped()) return;
    await admin.query(
      `INSERT INTO tenant_inventory_settings (tenant_id, safety_ttl_seconds, updated_by) VALUES ($1, 300, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET safety_ttl_seconds = 300`,
      [TENANT_A, ACTOR_A],
    );
    expect((await delta(await currentRevision())).safety_ttl_seconds).toBe(300);
    expect((await feed.getSnapshot(TENANT_A, STORE_A_X, { limit: 1, pageToken: null })).safety_ttl_seconds).toBe(300);
  });
});

describe('tenant isolation', () => {
  it('never answers another tenant hold, and tenant B starts at its own revision', async () => {
    if (skipped()) return;
    const bIdentity = await newIdentity({ tenantId: TENANT_B, product: PRODUCT_TB });
    const bHold = await placeHold(bIdentity, TENANT_B, ACTOR_B);
    const a = await fullSnapshot(1000);
    expect(a.ids).not.toContain(bHold);
    const b = await feed.getSnapshot(TENANT_B, STORE_B_X, { limit: undefined, pageToken: null });
    expect(b.holds.map((h) => h.hold_id)).toEqual([bHold]);
    expect(b.revision).toBe(1);
    const bDelta = await feed.getDeltas(TENANT_B, 0, { limit: undefined });
    expect(bDelta.kind === 'page' && bDelta.page.upserts.map((h) => h.hold_id)).toEqual([bHold]);
  });
});

describe('HTTP behind the real device guard', () => {
  const SNAPSHOT = '/api/pos/v1/inventory-safety/snapshot';
  const DELTAS = '/api/pos/v1/inventory-safety/deltas';

  it('refuses no token and a revoked device with a generic 401', async () => {
    if (skipped()) return;
    expect((await request(server()).get(SNAPSHOT)).status).toBe(401);
    expect((await asDevice(DEV_REVOKED, SNAPSHOT)).status).toBe(401);
  });

  it('serves the device its tenant snapshot and deltas, matching the contract', async () => {
    if (skipped()) return;
    const snap = await asDevice(DEV_A_X, SNAPSHOT).query({ branch_id: STORE_A_X, limit: 2 });
    expect(snap.status).toBe(200);
    conforms('InventorySafetySnapshotPage', snap.body);
    expect(snap.body.revision).toBe(await currentRevision());
    const next = await asDevice(DEV_A_X, SNAPSHOT).query({ page_token: snap.body.next_page_token });
    expect(next.status).toBe(200);
    const deltas = await asDevice(DEV_A_X, DELTAS).query({ since: 0, limit: 1000 });
    expect(deltas.status).toBe(200);
    conforms('InventorySafetyDeltaPage', deltas.body);
    expect(deltas.body).toMatchObject({ from_revision: 0, revision: await currentRevision(), has_more: false });
  });

  it('refuses a branch_id that is not the device store, and a foreign page token, with a non-disclosing 404', async () => {
    if (skipped()) return;
    const wrongBranch = await asDevice(DEV_A_X, SNAPSHOT).query({ branch_id: STORE_A_Y });
    expect(wrongBranch.status).toBe(404);
    expect(wrongBranch.body.error).toMatchObject({ code: 'not_found' });
    expect((await asDevice(DEV_A_X, DELTAS).query({ since: 0, branch_id: STORE_B_X })).status).toBe(404);
    const bPage = await asDevice(DEV_B_X, SNAPSHOT).query({ limit: 1 });
    const foreign = encodePageToken({ tenantId: TENANT_B, storeId: STORE_B_X, revision: 1, afterHoldId: bPage.body.holds[0].hold_id });
    const res = await asDevice(DEV_A_X, SNAPSHOT).query({ page_token: foreign });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'not_found' });
  });

  it("answers another tenant's device with that tenant's holds only", async () => {
    if (skipped()) return;
    const res = await asDevice(DEV_B_X, SNAPSHOT);
    expect(res.status).toBe(200);
    const aHolds = new Set(await activeHoldIds(TENANT_A));
    expect(res.body.holds.some((h: { hold_id: string }) => aHolds.has(h.hold_id))).toBe(false);
  });

  it('answers 409 snapshot_required and 400 for a malformed since or limit', async () => {
    if (skipped()) return;
    const ahead = await asDevice(DEV_A_X, DELTAS).query({ since: (await currentRevision()) + 5 });
    expect(ahead.status).toBe(409);
    expect(ahead.body.error).toMatchObject({ code: 'snapshot_required' });
    for (const query of [{}, { since: '' }, { since: '-1' }, { since: '1.5' }, { since: 1, limit: 0 }, { since: 1, limit: 1001 }]) {
      const res = await asDevice(DEV_A_X, DELTAS).query(query);
      expect([query, res.status]).toEqual([query, 400]);
    }
    expect((await asDevice(DEV_A_X, SNAPSHOT).query({ branch_id: 'not-a-uuid' })).status).toBe(400);
  });
});
