/**
 * Jira RT-451 slice S1 — the POS lot lookup (`posListTrackedLots`,
 * `pos-sales/tracked-lines.yaml`) over HTTP against real Postgres (every
 * migration, the NOBYPASSRLS `app_test` role on PG_POOL).
 *
 * Wiring mirrors production (the sale-history suite's model): the real
 * SalesModule, PosOperatorsModule and CashierAdmissionsModule and the GLOBAL
 * FailClosedAuthGuard. Only the Clerk JWKS check, the audit fan-out and the
 * rate limiter's store are substituted. No guard is overridden.
 *
 * What this proves:
 *   - the deployment gate: off (the default) is the non-disclosing 404 for
 *     both credentials and writes no audit row; no credential is still 401;
 *   - RT-451 S2: the tenant's switch (0086) off is the same 404 with the gate
 *     on; tracked selling needs both;
 *   - both credentials of the contract: the manager envelope and the device
 *     token alone see the same list of their store; a revoked device is 401;
 *   - G7-5: a lot is listed through its expiry date at the store's business
 *     date (Africa/Cairo, server clock), the day after it is gone;
 *   - RT-449: a lot under an active quality or recall hold is not listed; a
 *     released hold lists it again; `safetyRevision` is the tenant's current;
 *   - G7-13: under `suggest` (expiry_required) positive positions rank first,
 *     then expiry, then code (byte order); under `off` no rank, expiry then code;
 *   - the advisory position is null until positions are live (RT-427
 *     activation), then the identity's `sellable` quantity at the CALLER's
 *     store only; it never removes a lot (Q12);
 *   - a non-batch, retired or inactive product is a 200 with no lots; an
 *     unknown or other-tenant product is the same 404; a malformed id is 400;
 *   - the per-device rate limit (bucket `posReadTrackedLots`) and its 429;
 *   - every 200 body validates against `TrackedLotList`; one
 *     `tracked_lots.listed` audit row per answered request.
 *
 * The identities are SEEDED: nothing writes `tracking_identities` until RT-453.
 */
import { linkClerkUsers } from "../../../_helpers/identity-links";
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { hashToken } from "@data-pulse-2/auth";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import cookieParser from "cookie-parser";
import type { Pool } from "pg";
import request from "supertest";

import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../../../../src/auth/auth.module";
import { FailClosedAuthGuard } from "../../../../src/auth/fail-closed-auth.guard";
import { OPERATOR_TOKEN_VERIFIER, type OperatorTokenVerifier } from "../../../../src/auth/operator-token-verifier";
import { RateLimiter, type RateLimitDecision } from "../../../../src/auth/rate-limit";
import { SalesModule } from "../../../../src/catalog/sales/sales.module";
import { TRACKED_SELLING_GATE } from "../../../../src/catalog/sales/tracked-lines/tracked-selling-gate";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { RequestIdInterceptor } from "../../../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../../../src/common/zod-validation.pipe";
import { InventoryRecallsService } from "../../../../src/inventory/safety/inventory-recalls.service";
import { TrackingHoldsService } from "../../../../src/inventory/safety/tracking-holds.service";
import { CashierAdmissionsModule } from "../../../../src/pos-cashier-admissions/cashier-admissions.module";
import { PosOperatorsModule } from "../../../../src/pos-operators/pos-operators.module";
import { allContracts, contractDocument } from "../../../_helpers/openapi-contract";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../../_helpers/postgres-container";

delete process.env["REDIS_URL"];

// `0451` / `f4` mnemonic, hex-safe.
const id = (n: string): string => `0a451000-0000-4000-8000-0000000${n}`;
const TENANT = id("00001");
const TENANT_OTHER = id("00002");
const STORE = id("000a1");
const STORE_2 = id("000a2");
const STORE_OTHER = id("000a3");
const ROLE_MANAGER = id("000b1");
const ROLE_OTHER = id("000b2");
const MANAGER = id("000c1");
const OTHER_USER = id("000c2");
const M_MANAGER = id("000d1");
const M_OTHER = id("000d2");
const DEVICE = id("000e1");
const DEVICE_S2 = id("000e2");
const DEVICE_OTHER = id("000e3");
const DEVICE_REVOKED = id("000e4");
const TOKEN = "rt451-s1-device-token-store-till-1";
const TOKEN_S2 = "rt451-s1-device-token-store2-till-1";
const TOKEN_OTHER = "rt451-s1-device-token-other-tenant";
const TOKEN_REVOKED = "rt451-s1-device-token-revoked";
const MANAGER_SUB = "user_clerk_rt451_manager";
const MANAGER_JWT = "jwt-rt451-manager";

// Products.
const P_SUGGEST = id("00f01"); // batch, expiry required → FEFO suggest
const P_OFF = id("00f02"); // batch, no expiry required → FEFO off
const P_NONE = id("00f03"); // not tracked
const P_RETIRED = id("00f04"); // batch, retired
const P_INACTIVE = id("00f05"); // batch, inactive
const P_POS = id("00f06"); // batch, expiry required, for the position cases
const P_OTHER = id("00f07"); // the other tenant's batch product

class StubClerkVerifier implements OperatorTokenVerifier {
  async verify(rawJwt: string): Promise<{ providerKey: string; sub: string }> {
    if (rawJwt !== MANAGER_JWT) throw new Error("StubClerkVerifier: unknown jwt");
    return { providerKey: "clerk", sub: MANAGER_SUB };
  }
}

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  readonly payloads: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.payloads.push(payload);
  }
}

class SwitchRateLimiter {
  deny = false;
  readonly calls: Array<{ bucket: string; key: string }> = [];
  async check(bucket: string, key: string): Promise<RateLimitDecision> {
    this.calls.push({ bucket, key });
    return { allowed: !this.deny, count: 1, remaining: 0, resetMs: 30_000 };
  }
  async release(): Promise<void> {}
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
let holds: TrackingHoldsService;
let recalls: InventoryRecallsService;
const audit = new SpyAuditEnqueuer();
const limiter = new SwitchRateLimiter();
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
let seq = 0;

function E(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => dockerSkipped;
const http = () => request((app as INestApplication).getHttpServer());

function lots(productId: string, bearer: string | null) {
  const req = http().get(`/api/pos/v1/products/${productId}/tracked-lots`);
  return bearer === null ? req : req.set("Authorization", `Bearer ${bearer}`);
}

function conforms(body: unknown): void {
  const validate = ajv.getSchema("tracked-lines#/components/schemas/TrackedLotList");
  if (!validate) throw new Error("ajv cannot resolve TrackedLotList");
  if (!validate(body)) throw new Error(`contract violation: ${JSON.stringify(validate.errors)}`);
}

function key(): string {
  seq += 1;
  return `rt451-s1-${String(seq).padStart(6, "0")}`;
}

/** The store's business date (server clock, store time zone) plus `days`. */
async function businessDate(days = 0, store = STORE): Promise<string> {
  const r = await E().admin.query<{ d: string }>(
    `SELECT ((now() AT TIME ZONE timezone)::date + $2::int)::text AS d FROM stores WHERE id = $1`,
    [store, days],
  );
  return r.rows[0]!.d;
}

async function identity(product: string, code: string, expiry: string | null, tenant = TENANT): Promise<string> {
  const r = await E().admin.query<{ id: string }>(
    `INSERT INTO tracking_identities (tenant_id, tenant_product_ref, kind, code, expiry_date)
     VALUES ($1, $2, 'batch', $3, $4) RETURNING id::text AS id`,
    [tenant, product, code, expiry],
  );
  return r.rows[0]!.id;
}

async function primaryLocation(store: string): Promise<string> {
  const r = await E().admin.query<{ id: string }>(
    `SELECT id::text AS id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`,
    [store],
  );
  return r.rows[0]!.id;
}

async function movement(opts: {
  identity: string;
  product: string;
  quantity: string;
  store?: string;
  status?: string;
}): Promise<void> {
  const store = opts.store ?? STORE;
  await E().admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason,
        occurred_at, created_by, stock_location_id, inventory_status, tracking_identity_id)
     VALUES (gen_random_uuid(), $1, $2, 'adjustment', $3::numeric, 'ea', $4, 'rt451 s1 fixture', now(), $5,
             $6, $7, $8)`,
    [TENANT, store, opts.quantity, opts.product, MANAGER, await primaryLocation(store), opts.status ?? "sellable", opts.identity],
  );
}

async function currentRevision(): Promise<number> {
  const r = await E().admin.query<{ revision: string }>(
    `SELECT COALESCE((SELECT revision FROM tenant_inventory_safety_revisions WHERE tenant_id = $1), 0)::text AS revision`,
    [TENANT],
  );
  return Number(r.rows[0]!.revision);
}

async function signInManager(): Promise<string> {
  const res = await http()
    .post("/api/pos/v1/operators/sign-in")
    .set("Authorization", `Bearer ${MANAGER_JWT}`)
    .send({ kind: "manager_admin", device_token_attestation: TOKEN });
  expect(res.status).toBe(200);
  return res.body.operator_session.envelope as string;
}

/**
 * RT-451 S2: the tenant's tracked-selling switch (0086). Tracked selling is in
 * effect only while the deployment gate is on AND this switch is on.
 */
async function tenantSwitch(tenantId: string, on: boolean): Promise<void> {
  await E().admin.query(
    `INSERT INTO tenant_inventory_settings
       (tenant_id, updated_by, tracked_selling_enabled, tracked_selling_changed_at, tracked_selling_changed_by)
     VALUES ($1, $2, $3, now(), $2)
     ON CONFLICT (tenant_id) DO UPDATE
       SET tracked_selling_enabled = $3, tracked_selling_changed_at = now(), tracked_selling_changed_by = $2`,
    [tenantId, MANAGER, on],
  );
}

const gateOn = (): void => {
  process.env[TRACKED_SELLING_GATE] = "true";
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[tracked-lots] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt451-s1-tenant', 'RT-451'), ($2, 'rt451-s1-other', 'RT-451 Other')`,
    [TENANT, TENANT_OTHER],
  );
  await a.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $3, 'store_manager', 'Manager'), ($2, $4, 'store_manager', 'Manager')`,
    [ROLE_MANAGER, ROLE_OTHER, TENANT, TENANT_OTHER],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name, timezone) VALUES
       ($1, $4, 'S1', 'Store 1', 'Africa/Cairo'), ($2, $4, 'S2', 'Store 2', 'Africa/Cairo'),
       ($3, $5, 'SO', 'Other Store', 'Africa/Cairo')`,
    [STORE, STORE_2, STORE_OTHER, TENANT, TENANT_OTHER],
  );
  await a.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES
       ($1, 'manager@rt451.example', 'Manager', $3), ($2, 'other@rt451.example', 'Other', 'user_clerk_rt451_other')`,
    [MANAGER, OTHER_USER, MANAGER_SUB],
  );
  await linkClerkUsers(a);
  await a.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $3, $5, $7, 'specific'), ($2, $4, $6, $8, 'all')`,
    [M_MANAGER, M_OTHER, TENANT, TENANT_OTHER, MANAGER, OTHER_USER, ROLE_MANAGER, ROLE_OTHER],
  );
  await a.query(`INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`, [
    M_MANAGER,
    STORE,
    TENANT,
  ]);
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES
       ($1, $5, $6, 'till-1', $9), ($2, $5, $7, 's2-till', $10), ($3, $8, $11, 'other', $12), ($4, $5, $6, 'revoked', $13)`,
    [
      DEVICE, DEVICE_S2, DEVICE_OTHER, DEVICE_REVOKED,
      TENANT, STORE, STORE_2, TENANT_OTHER, hashToken(TOKEN), hashToken(TOKEN_S2), STORE_OTHER,
      hashToken(TOKEN_OTHER), hashToken(TOKEN_REVOKED),
    ],
  );
  await a.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEVICE_REVOKED]);
  await a.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode, expiry_required, is_active, retired_at)
     VALUES
       ($1, $8, 'Suggest', 'standard', $10, $10, 'batch', true, true, NULL),
       ($2, $8, 'Off', 'standard', $10, $10, 'batch', false, true, NULL),
       ($3, $8, 'Untracked', 'standard', $10, $10, 'none', false, true, NULL),
       ($4, $8, 'Retired', 'standard', $10, $10, 'batch', true, true, now()),
       ($5, $8, 'Inactive', 'standard', $10, $10, 'batch', true, false, NULL),
       ($6, $8, 'Positions', 'standard', $10, $10, 'batch', true, true, NULL),
       ($7, $9, 'Other tenant', 'standard', $11, $11, 'batch', true, true, NULL)`,
    [P_SUGGEST, P_OFF, P_NONE, P_RETIRED, P_INACTIVE, P_POS, P_OTHER, TENANT, TENANT_OTHER, MANAGER, OTHER_USER],
  );

  const pool = env.app as unknown as Pool;
  holds = new TrackingHoldsService(pool);
  recalls = new InventoryRecallsService(pool);
  ajv.addSchema(contractDocument(allContracts(), "tracked-lines") as object, "tracked-lines");

  const moduleRef = await Test.createTestingModule({
    imports: [AuthModule, PosOperatorsModule, CashierAdmissionsModule, SalesModule],
    providers: [{ provide: APP_GUARD, useClass: FailClosedAuthGuard }],
  })
    .overrideProvider(PG_POOL)
    .useValue(env.app)
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(env.admin)
    .overrideProvider(OPERATOR_TOKEN_VERIFIER)
    .useValue(new StubClerkVerifier())
    .overrideProvider(AUDIT_JOB_ENQUEUER)
    .useValue(audit)
    .overrideProvider(RateLimiter)
    .useValue(limiter)
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true, logger: false });
  app.use(cookieParser());
  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
}, 240_000);

afterAll(async () => {
  delete process.env[TRACKED_SELLING_GATE];
  if (app) await app.close().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  delete process.env[TRACKED_SELLING_GATE];
  // Both tenants have switched tracked selling on (RT-451 S2); a test that
  // proves the switch's 404 turns it off itself.
  if (env) {
    await tenantSwitch(TENANT, true);
    await tenantSwitch(TENANT_OTHER, true);
  }
  // One operator session per till: a second sign-in would be a takeover answer.
  if (env) await env.admin.query(`DELETE FROM auth_tokens WHERE scope = 'pos_operator'`);
  audit.payloads.length = 0;
  limiter.deny = false;
  limiter.calls.length = 0;
});

// ---------------------------------------------------------------------------
// Gate and credentials
// ---------------------------------------------------------------------------

describe("RT-451 S1 — the gate and the credentials", () => {
  it("no credential is the generic 401, with the gate off and on", async () => {
    if (skip()) return;
    expect((await lots(P_SUGGEST, null)).status).toBe(401);
    gateOn();
    expect((await lots(P_SUGGEST, null)).status).toBe(401);
    expect((await lots(P_SUGGEST, "not-a-token")).status).toBe(401);
  });

  it("a revoked device is the generic 401", async () => {
    if (skip()) return;
    gateOn();
    expect((await lots(P_SUGGEST, TOKEN_REVOKED)).status).toBe(401);
  });

  it("with the gate off (the default) both credentials get the non-disclosing 404 and nothing is audited", async () => {
    if (skip()) return;
    await identity(P_SUGGEST, `GATE-${key()}`, await businessDate(5));
    const envelope = await signInManager();
    audit.payloads.length = 0;
    const byDevice = await lots(P_SUGGEST, TOKEN);
    const byEnvelope = await lots(P_SUGGEST, envelope);
    const unknown = await lots(randomUUID(), TOKEN);
    expect([byDevice.status, byEnvelope.status, unknown.status]).toEqual([404, 404, 404]);
    expect(byDevice.body.error.code).toBe(unknown.body.error.code);
    expect(audit.payloads.filter((p) => p.action === "tracked_lots.listed")).toEqual([]);
  });

  it("RT-451 S2: with the gate on but the tenant's switch off, both credentials get the same non-disclosing 404 and nothing is audited", async () => {
    if (skip()) return;
    gateOn();
    await tenantSwitch(TENANT, false);
    await identity(P_SUGGEST, `SWITCH-${key()}`, await businessDate(5));
    const envelope = await signInManager();
    audit.payloads.length = 0;
    const byDevice = await lots(P_SUGGEST, TOKEN);
    const byEnvelope = await lots(P_SUGGEST, envelope);
    const unknown = await lots(randomUUID(), TOKEN);
    expect([byDevice.status, byEnvelope.status, unknown.status]).toEqual([404, 404, 404]);
    expect({ ...byDevice.body.error, request_id: null }).toEqual({ ...unknown.body.error, request_id: null });
    expect(audit.payloads.filter((p) => p.action === "tracked_lots.listed")).toEqual([]);
    // Switching it back on serves the list again.
    await tenantSwitch(TENANT, true);
    expect((await lots(P_SUGGEST, TOKEN)).status).toBe(200);
  });

  it("the envelope and the device token alone get the same list of their store", async () => {
    if (skip()) return;
    gateOn();
    const envelope = await signInManager();
    const byDevice = await lots(P_SUGGEST, TOKEN);
    const byEnvelope = await lots(P_SUGGEST, envelope);
    expect(byDevice.status).toBe(200);
    expect(byEnvelope.status).toBe(200);
    expect(byEnvelope.body).toEqual(byDevice.body);
    conforms(byDevice.body);
  });

  it("a malformed product id is a 400; an unknown or other-tenant product is the same 404", async () => {
    if (skip()) return;
    gateOn();
    expect((await lots("not-a-uuid", TOKEN)).status).toBe(400);
    const unknown = await lots(randomUUID(), TOKEN);
    const foreign = await lots(P_OTHER, TOKEN);
    expect(unknown.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect({ ...foreign.body.error, request_id: null }).toEqual({ ...unknown.body.error, request_id: null });
    // And the other tenant's device does not see this tenant's product.
    expect((await lots(P_SUGGEST, TOKEN_OTHER)).status).toBe(404);
  });

  it("throttles per device on posReadTrackedLots and answers 429 with Retry-After", async () => {
    if (skip()) return;
    gateOn();
    expect((await lots(P_SUGGEST, TOKEN)).status).toBe(200);
    expect(limiter.calls).toContainEqual({ bucket: "posReadTrackedLots", key: DEVICE });
    limiter.deny = true;
    const res = await lots(P_SUGGEST, TOKEN);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("30");
  });

  it("audits one tracked_lots.listed per answered request, with the product, count and device", async () => {
    if (skip()) return;
    gateOn();
    const res = await lots(P_SUGGEST, TOKEN);
    expect(res.status).toBe(200);
    const listed = audit.payloads.filter((p) => p.action === "tracked_lots.listed");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tenant_id: TENANT, store_id: STORE });
    expect(listed[0]?.metadata).toEqual({ product_id: P_SUGGEST, lot_count: res.body.lots.length, device_id: DEVICE });
    audit.payloads.length = 0;
    expect((await lots(randomUUID(), TOKEN)).status).toBe(404);
    expect(audit.payloads.filter((p) => p.action === "tracked_lots.listed")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Which lots, in which order
// ---------------------------------------------------------------------------

describe("RT-451 S1 — the lots (G7-5, G7-13, RT-449)", () => {
  it("lists a lot through its expiry date at the store's business date, and not the day after", async () => {
    if (skip()) return;
    gateOn();
    const today = await businessDate(0);
    const expiresToday = await identity(P_OFF, "EXP-TODAY", today);
    const expiredYesterday = await identity(P_OFF, "EXP-YESTERDAY", await businessDate(-1));
    const res = await lots(P_OFF, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.businessDate).toBe(today);
    const ids = res.body.lots.map((l: { identityId: string }) => l.identityId);
    expect(ids).toContain(expiresToday);
    expect(ids).not.toContain(expiredYesterday);
    conforms(res.body);
  });

  it("under off: no rank, ordered by expiry (none last) then code in byte order", async () => {
    if (skip()) return;
    gateOn();
    await E().admin.query(`DELETE FROM tracking_identities WHERE tenant_product_ref = $1`, [P_OFF]);
    const d = await businessDate(10);
    await identity(P_OFF, "b", d);
    await identity(P_OFF, "B", d);
    await identity(P_OFF, "a", d);
    await identity(P_OFF, "NOEXP", null);
    await identity(P_OFF, "EARLY", await businessDate(3));
    const res = await lots(P_OFF, TOKEN);
    expect(res.body.fefoPolicy).toBe("off");
    expect(res.body.lots.map((l: { code: string }) => l.code)).toEqual(["EARLY", "B", "a", "b", "NOEXP"]);
    expect(res.body.lots.every((l: { fefoRank: unknown }) => l.fefoRank === null)).toBe(true);
    conforms(res.body);
  });

  it("under suggest: 1-based ranks in expiry order before positions are live, every position null", async () => {
    if (skip()) return;
    gateOn();
    const late = await identity(P_SUGGEST, "S-LATE", await businessDate(30));
    const early = await identity(P_SUGGEST, "S-EARLY", await businessDate(2));
    const res = await lots(P_SUGGEST, TOKEN);
    expect(res.body.fefoPolicy).toBe("suggest");
    const listed = res.body.lots as Array<{ identityId: string; fefoRank: number; sellablePosition: unknown }>;
    expect(listed.map((l) => l.fefoRank)).toEqual(listed.map((_, i) => i + 1));
    expect(listed.findIndex((l) => l.identityId === early)).toBeLessThan(listed.findIndex((l) => l.identityId === late));
    expect(listed.every((l) => l.sellablePosition === null)).toBe(true);
    conforms(res.body);
  });

  it("leaves out a lot under a quality or recall hold, lists it again on release, and answers the current revision", async () => {
    if (skip()) return;
    gateOn();
    const quality = await identity(P_SUGGEST, `HQ-${key()}`, await businessDate(5));
    const recalled = await identity(P_SUGGEST, `HR-${key()}`, await businessDate(5));
    const placed = await holds.placeQualityHold({
      tenantId: TENANT,
      userId: MANAGER,
      idempotencyKey: key(),
      trackingIdentityId: quality,
      reasonCode: "supplier_notice",
      note: null,
    });
    await recalls.createRecall({
      tenantId: TENANT,
      userId: MANAGER,
      idempotencyKey: key(),
      tenantProductRef: P_SUGGEST,
      trackingIdentityIds: [recalled],
      reasonCode: "supplier_notice",
      reference: "RT451-S1",
      note: null,
      effectiveAt: null,
    });
    const held = await lots(P_SUGGEST, TOKEN);
    const heldIds = held.body.lots.map((l: { identityId: string }) => l.identityId);
    expect(heldIds).not.toContain(quality);
    expect(heldIds).not.toContain(recalled);
    expect(held.body.safetyRevision).toBe(await currentRevision());
    expect(held.body.safetyRevision).toBeGreaterThanOrEqual(2);

    await holds.releaseHold({ tenantId: TENANT, userId: MANAGER, holdId: placed.hold.id, note: null });
    const released = await lots(P_SUGGEST, TOKEN);
    expect(released.body.lots.map((l: { identityId: string }) => l.identityId)).toContain(quality);
    expect(released.body.safetyRevision).toBe(held.body.safetyRevision + 1);
  });

  it("answers a 200 with no lots for an untracked, retired or inactive product", async () => {
    if (skip()) return;
    gateOn();
    await identity(P_RETIRED, "RET-1", await businessDate(5));
    await identity(P_INACTIVE, "INA-1", await businessDate(5));
    for (const [product, policy] of [
      [P_NONE, "off"],
      [P_RETIRED, "suggest"],
      [P_INACTIVE, "suggest"],
    ] as const) {
      const res = await lots(product, TOKEN);
      expect({ product, status: res.status, lots: res.body.lots, policy: res.body.fefoPolicy }).toEqual({
        product,
        status: 200,
        lots: [],
        policy,
      });
      conforms(res.body);
    }
  });
});

describe("RT-451 S1 — the advisory position (RT-427 activation, Q12)", () => {
  it("is the identity's sellable quantity at the caller's store once positions are live; positive lots rank first", async () => {
    if (skip()) return;
    gateOn();
    const early = await identity(P_POS, "POS-EARLY", await businessDate(1)); // no stock here
    const middle = await identity(P_POS, "POS-MIDDLE", await businessDate(5)); // positive here
    const late = await identity(P_POS, "POS-LATE", await businessDate(9)); // negative here
    const elsewhere = await identity(P_POS, "POS-ELSEWHERE", await businessDate(2)); // stock only in S2

    await movement({ identity: middle, product: P_POS, quantity: "4" });
    await movement({ identity: middle, product: P_POS, quantity: "2.5" });
    await movement({ identity: middle, product: P_POS, quantity: "7", status: "quality_hold" });
    await movement({ identity: late, product: P_POS, quantity: "-1" });
    await movement({ identity: elsewhere, product: P_POS, quantity: "9", store: STORE_2 });

    // Not live yet: every position null, pure expiry order.
    const before = await lots(P_POS, TOKEN);
    expect(before.body.lots.map((l: { identityId: string }) => l.identityId)).toEqual([early, elsewhere, middle, late]);
    expect(before.body.lots.every((l: { sellablePosition: unknown }) => l.sellablePosition === null)).toBe(true);

    await E().admin.query(
      `INSERT INTO tenant_inventory_settings (tenant_id, updated_by, sale_effects_activated_at, sale_effects_activated_by)
       VALUES ($1, $2, now(), $2)
       ON CONFLICT (tenant_id) DO UPDATE SET sale_effects_activated_at = now(), sale_effects_activated_by = $2`,
      [TENANT, MANAGER],
    );
    try {
      const after = await lots(P_POS, TOKEN);
      expect(after.status).toBe(200);
      const rows = after.body.lots as Array<{ identityId: string; sellablePosition: string; fefoRank: number }>;
      // Positive first, then the rest by expiry; nothing is removed for quantity.
      expect(rows.map((l) => l.identityId)).toEqual([middle, early, elsewhere, late]);
      expect(rows.map((l) => l.sellablePosition)).toEqual(["6.5000", "0.0000", "0.0000", "-1.0000"]);
      expect(rows.map((l) => l.fefoRank)).toEqual([1, 2, 3, 4]);
      conforms(after.body);

      // The S2 till sees its own store's position.
      const s2 = await lots(P_POS, TOKEN_S2);
      const s2Rows = s2.body.lots as Array<{ identityId: string; sellablePosition: string }>;
      expect(s2Rows[0]).toMatchObject({ identityId: elsewhere, sellablePosition: "9.0000" });
    } finally {
      // Undo only the activation: the tenant's tracked-selling switch stays.
      await E().admin.query(
        `UPDATE tenant_inventory_settings SET sale_effects_activated_at = NULL, sale_effects_activated_by = NULL
          WHERE tenant_id = $1`,
        [TENANT],
      );
    }
  });
});
