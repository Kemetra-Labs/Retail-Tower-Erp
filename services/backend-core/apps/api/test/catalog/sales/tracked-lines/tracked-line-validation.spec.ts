/**
 * Jira RT-451 slice S2 — the Tracked Line Validation (`posValidateTrackedLine`,
 * `pos-sales/tracked-lines.yaml`) over HTTP against real Postgres (every
 * migration, the NOBYPASSRLS `app_test` role on PG_POOL).
 *
 * Wiring mirrors production (the S1 lot lookup suite's model): the real
 * SalesModule, PosOperatorsModule and CashierAdmissionsModule and the GLOBAL
 * FailClosedAuthGuard. Only the Clerk JWKS check, the audit fan-out and the
 * rate limiter's store are substituted. No guard is overridden.
 *
 * What this proves:
 *   - the deployment gate off (the default) and, with it on, the tenant's
 *     switch (0086) off are the same non-disclosing 404 for both credentials,
 *     with no validation record and no audit row; no credential is 401;
 *   - the credentials: the manager envelope; the device token with a cashier
 *     claim only while that cashier's admission of this device and store is
 *     live NOW (an ended, expired, other-device or missing admission, or an
 *     ineligible user, is the generic 403 `refused`); a device token without
 *     the claim, or an envelope carrying it, is the generic 401;
 *   - the check order and the single reason: not_sellable (retired, inactive,
 *     inactive by the store override, serial) before profile_mismatch (`none`)
 *     before unknown_identity before wrong_product before recalled before held
 *     before expired;
 *   - G7-5: sellable on its expiry date at the store's business date, refused
 *     the day after; Q12: quantity never refuses;
 *   - the identity by id or by the scanned code (exactly), a scanned expiry
 *     that differs never changes the result; another tenant's identity is
 *     unknown, another tenant's product the 404;
 *   - G7-13: the FEFO suggestion (null under `off`), a deviation is accepted;
 *   - every evaluated call writes one record (accepted or refused) with a new
 *     id; a 400, 401, 403, 404 or 429 writes none;
 *   - every 200 body validates against `TrackedLineValidation`; one
 *     `tracked_line.validated` audit row per answered request; the per-device
 *     rate limit bucket `posValidateTrackedLine`.
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

// `0451` / `f4` mnemonic, hex-safe; `2` for slice S2.
const id = (n: string): string => `0a451200-0000-4000-8000-0000000${n}`;
const TENANT = id("00001");
const TENANT_OTHER = id("00002");
const STORE = id("000a1");
const STORE_OTHER = id("000a3");
const ROLE_MANAGER = id("000b1");
const ROLE_STAFF = id("000b2");
const ROLE_OTHER = id("000b3");
const MANAGER = id("000c1");
const CASHIER = id("000c2");
const OTHER_USER = id("000c3");
const M_MANAGER = id("000d1");
const M_CASHIER = id("000d2");
const M_OTHER = id("000d3");
const DEVICE = id("000e1");
const DEVICE_2 = id("000e2");
const DEVICE_OTHER = id("000e3");
const DEVICE_REVOKED = id("000e4");
const TOKEN = "rt451-s2-device-token-store-till-1";
const TOKEN_2 = "rt451-s2-device-token-store-till-2";
const TOKEN_OTHER = "rt451-s2-device-token-other-tenant";
const TOKEN_REVOKED = "rt451-s2-device-token-revoked";
const MANAGER_SUB = "user_clerk_rt451_s2_manager";
const MANAGER_JWT = "jwt-rt451-s2-manager";

// Products.
const P_SUGGEST = id("00f01"); // batch, expiry required → FEFO suggest
const P_OFF = id("00f02"); // batch, no expiry required → FEFO off
const P_NONE = id("00f03"); // not tracked
const P_RETIRED = id("00f04"); // batch, retired
const P_INACTIVE = id("00f05"); // batch, inactive
const P_STORE_OFF = id("00f06"); // batch, inactive at STORE by its Store Override
const P_SERIAL = id("00f07"); // serial: fail-closed (Q11)
const P_NONE_RETIRED = id("00f08"); // not tracked AND retired: not_sellable comes first
const P_OTHER = id("00f09"); // the other tenant's batch product

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

interface Body {
  productId?: string;
  identity?: Record<string, unknown>;
  quantity?: string;
  selection?: string;
  draftLineRef?: string;
  operatorUserId?: string;
  [extra: string]: unknown;
}

function validate(bearer: string | null, body: Body) {
  const req = http().post("/api/pos/v1/tracked-line-validations");
  return (bearer === null ? req : req.set("Authorization", `Bearer ${bearer}`)).send(body);
}

/** A device-path request of the admitted cashier. */
function line(productId: string, identity: Record<string, unknown>, extra: Partial<Body> = {}): Body {
  return { productId, identity, quantity: "1", selection: "scanned", draftLineRef: `draft-${key()}`, operatorUserId: CASHIER, ...extra };
}

function conforms(body: unknown): void {
  const check = ajv.getSchema("tracked-lines#/components/schemas/TrackedLineValidation");
  if (!check) throw new Error("ajv cannot resolve TrackedLineValidation");
  if (!check(body)) throw new Error(`contract violation: ${JSON.stringify(check.errors)}`);
}

function key(): string {
  seq += 1;
  return `rt451-s2-${String(seq).padStart(6, "0")}`;
}

const HOUR = 3600 * 1000;
const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

/** The store's business date (server clock, store time zone) plus `days`. */
async function businessDate(days = 0): Promise<string> {
  const r = await E().admin.query<{ d: string }>(
    `SELECT ((now() AT TIME ZONE timezone)::date + $2::int)::text AS d FROM stores WHERE id = $1`,
    [STORE, days],
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

async function admission(opts: { createdAt: string; expiresAt: string; endedAt?: string; device?: string; user?: string }): Promise<void> {
  await E().admin.query(
    `INSERT INTO cashier_admissions
       (id, tenant_id, store_id, user_id, device_id, mode, created_at, renewed_at, expires_at, ended_at, end_reason)
     VALUES ($1, $2, $3, $4, $5, 'online', $6::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9)`,
    [
      randomUUID(),
      TENANT,
      STORE,
      opts.user ?? CASHIER,
      opts.device ?? DEVICE,
      opts.createdAt,
      opts.expiresAt,
      opts.endedAt ?? null,
      opts.endedAt ? "device_end" : null,
    ],
  );
}

const liveAdmission = (): Promise<void> => admission({ createdAt: at(-HOUR), expiresAt: at(11 * HOUR) });

async function records(): Promise<
  Array<{ id: string; outcome: string; refusal_reason: string | null; auth_path: string; operator_user_id: string }>
> {
  const r = await E().admin.query(
    `SELECT id::text AS id, outcome, refusal_reason, auth_path, operator_user_id::text AS operator_user_id
       FROM tracked_line_validations ORDER BY validated_at, id`,
  );
  return r.rows;
}

async function recordById(validationId: string): Promise<Record<string, unknown>> {
  const r = await E().admin.query(
    `SELECT tenant_id::text, store_id::text, device_id::text, operator_user_id::text, auth_path,
            tenant_product_ref::text, requested_identity_id::text, requested_code, scanned_expiry_date::text,
            resolved_identity_id::text, suggested_identity_id::text, selection, quantity::text, draft_line_ref,
            outcome, refusal_reason, safety_revision::int
       FROM tracked_line_validations WHERE id = $1`,
    [validationId],
  );
  return r.rows[0];
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

async function qualityHold(identityId: string): Promise<string> {
  const placed = await holds.placeQualityHold({
    tenantId: TENANT,
    userId: MANAGER,
    idempotencyKey: key(),
    trackingIdentityId: identityId,
    reasonCode: "supplier_notice",
    note: null,
  });
  return placed.hold.id;
}

async function recall(product: string, identityId: string): Promise<void> {
  await recalls.createRecall({
    tenantId: TENANT,
    userId: MANAGER,
    idempotencyKey: key(),
    tenantProductRef: product,
    trackingIdentityIds: [identityId],
    reasonCode: "supplier_notice",
    reference: `RT451-S2-${key()}`,
    note: null,
    effectiveAt: null,
  });
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
      console.warn(`\n[tracked-line-validation] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt451-s2-tenant', 'RT-451 S2'), ($2, 'rt451-s2-other', 'RT-451 S2 Other')`,
    [TENANT, TENANT_OTHER],
  );
  await a.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $4, 'store_manager', 'Manager'), ($2, $4, 'store_staff', 'Cashier'), ($3, $5, 'store_manager', 'Manager')`,
    [ROLE_MANAGER, ROLE_STAFF, ROLE_OTHER, TENANT, TENANT_OTHER],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name, timezone) VALUES
       ($1, $3, 'S1', 'Store 1', 'Africa/Cairo'), ($2, $4, 'SO', 'Other Store', 'Africa/Cairo')`,
    [STORE, STORE_OTHER, TENANT, TENANT_OTHER],
  );
  await a.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES
       ($1, 'manager@rt451s2.example', 'Manager', $4),
       ($2, 'cashier@rt451s2.example', 'Cashier', 'user_clerk_rt451_s2_cashier'),
       ($3, 'other@rt451s2.example', 'Other', 'user_clerk_rt451_s2_other')`,
    [MANAGER, CASHIER, OTHER_USER, MANAGER_SUB],
  );
  await linkClerkUsers(a);
  await a.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $4, $6, $9, 'specific'), ($2, $4, $7, $10, 'all'), ($3, $5, $8, $11, 'all')`,
    [M_MANAGER, M_CASHIER, M_OTHER, TENANT, TENANT_OTHER, MANAGER, CASHIER, OTHER_USER, ROLE_MANAGER, ROLE_STAFF, ROLE_OTHER],
  );
  await a.query(`INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`, [M_MANAGER, STORE, TENANT]);
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES
       ($1, $5, $6, 'till-1', $9), ($2, $5, $6, 'till-2', $10), ($3, $7, $8, 'other', $11), ($4, $5, $6, 'revoked', $12)`,
    [
      DEVICE, DEVICE_2, DEVICE_OTHER, DEVICE_REVOKED,
      TENANT, STORE, TENANT_OTHER, STORE_OTHER,
      hashToken(TOKEN), hashToken(TOKEN_2), hashToken(TOKEN_OTHER), hashToken(TOKEN_REVOKED),
    ],
  );
  await a.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEVICE_REVOKED]);
  await a.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode, expiry_required, is_active, retired_at)
     VALUES
       ($1, $10, 'Suggest', 'standard', $12, $12, 'batch', true, true, NULL),
       ($2, $10, 'Off', 'standard', $12, $12, 'batch', false, true, NULL),
       ($3, $10, 'Untracked', 'standard', $12, $12, 'none', false, true, NULL),
       ($4, $10, 'Retired', 'standard', $12, $12, 'batch', true, true, now()),
       ($5, $10, 'Inactive', 'standard', $12, $12, 'batch', true, false, NULL),
       ($6, $10, 'Store off', 'standard', $12, $12, 'batch', true, true, NULL),
       ($7, $10, 'Serial', 'standard', $12, $12, 'serial', false, true, NULL),
       ($8, $10, 'Untracked retired', 'standard', $12, $12, 'none', false, true, now()),
       ($9, $11, 'Other tenant', 'standard', $13, $13, 'batch', true, true, NULL)`,
    [
      P_SUGGEST, P_OFF, P_NONE, P_RETIRED, P_INACTIVE, P_STORE_OFF, P_SERIAL, P_NONE_RETIRED, P_OTHER,
      TENANT, TENANT_OTHER, MANAGER, OTHER_USER,
    ],
  );
  await a.query(
    `INSERT INTO store_product_overrides (id, tenant_id, store_id, product_id, is_active, created_by, updated_by)
     VALUES ($1, $2, $3, $4, false, $5, $5)`,
    [randomUUID(), TENANT, STORE, P_STORE_OFF, MANAGER],
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
  if (env) {
    // Both tenants have switched tracked selling on; a test proving the
    // switch's 404 turns it off itself.
    await tenantSwitch(TENANT, true);
    await tenantSwitch(TENANT_OTHER, true);
    await env.admin.query(`DELETE FROM auth_tokens WHERE scope = 'pos_operator'`);
    await env.admin.query(`DELETE FROM cashier_admissions`);
    await env.admin.query(`DELETE FROM tracked_line_validations`);
    await liveAdmission();
  }
  audit.payloads.length = 0;
  limiter.deny = false;
  limiter.calls.length = 0;
});

const validated = () => audit.payloads.filter((p) => p.action === "tracked_line.validated");

// ---------------------------------------------------------------------------
// Gate, switch and credentials
// ---------------------------------------------------------------------------

describe("RT-451 S2 TLV — the gate, the tenant switch and the credentials", () => {
  it("no credential is the generic 401, with the gate off and on", async () => {
    if (skip()) return;
    const lot = await identity(P_OFF, `NC-${key()}`, null);
    expect((await validate(null, line(P_OFF, { identityId: lot }))).status).toBe(401);
    gateOn();
    expect((await validate(null, line(P_OFF, { identityId: lot }))).status).toBe(401);
    expect((await validate("not-a-token", line(P_OFF, { identityId: lot }))).status).toBe(401);
    expect((await validate(TOKEN_REVOKED, line(P_OFF, { identityId: lot }))).status).toBe(401);
    expect(await records()).toEqual([]);
  });

  it("with the gate off (the default) both credentials get the non-disclosing 404, nothing recorded or audited", async () => {
    if (skip()) return;
    const lot = await identity(P_OFF, `GATE-${key()}`, null);
    const envelope = await signInManager();
    audit.payloads.length = 0;
    const { operatorUserId: _claim, ...envelopeBody } = line(P_OFF, { identityId: lot });
    const byDevice = await validate(TOKEN, line(P_OFF, { identityId: lot }));
    const byEnvelope = await validate(envelope, envelopeBody);
    const unknownProduct = await validate(TOKEN, line(randomUUID(), { identityId: lot }));
    expect([byDevice.status, byEnvelope.status, unknownProduct.status]).toEqual([404, 404, 404]);
    expect(byDevice.body.error.code).toBe(unknownProduct.body.error.code);
    expect(await records()).toEqual([]);
    expect(validated()).toEqual([]);
  });

  it("with the gate on but the tenant's switch off, the same 404, nothing recorded or audited", async () => {
    if (skip()) return;
    gateOn();
    await tenantSwitch(TENANT, false);
    const lot = await identity(P_OFF, `SW-${key()}`, null);
    const res = await validate(TOKEN, line(P_OFF, { identityId: lot }));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe((await validate(TOKEN, line(randomUUID(), { identityId: lot }))).body.error.code);
    expect(await records()).toEqual([]);
    expect(validated()).toEqual([]);
  });

  it("accepts the manager envelope (no claim) and records the envelope path and the operator", async () => {
    if (skip()) return;
    gateOn();
    const lot = await identity(P_OFF, `ENV-${key()}`, null);
    const envelope = await signInManager();
    const { operatorUserId: _claim, ...body } = line(P_OFF, { identityId: lot });
    const res = await validate(envelope, body);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("accepted");
    conforms(res.body);
    expect(await records()).toEqual([
      { id: res.body.validationId, outcome: "accepted", refusal_reason: null, auth_path: "envelope", operator_user_id: MANAGER },
    ]);
  });

  it("accepts the device token with the claim of a cashier admitted on this device NOW, recorded as that cashier", async () => {
    if (skip()) return;
    gateOn();
    const lot = await identity(P_OFF, `DEV-${key()}`, null);
    const res = await validate(TOKEN, line(P_OFF, { identityId: lot }));
    expect(res.status).toBe(200);
    expect((await records())[0]).toMatchObject({ auth_path: "device", operator_user_id: CASHIER });
  });

  it("a wrong-path claim is the generic 401: a device token without the claim, an envelope carrying it", async () => {
    if (skip()) return;
    gateOn();
    const lot = await identity(P_OFF, `WP-${key()}`, null);
    const { operatorUserId: _claim, ...noClaim } = line(P_OFF, { identityId: lot });
    expect((await validate(TOKEN, noClaim)).status).toBe(401);
    const envelope = await signInManager();
    expect((await validate(envelope, line(P_OFF, { identityId: lot }, { operatorUserId: MANAGER }))).status).toBe(401);
    expect(await records()).toEqual([]);
  });

  it.each<[string, () => Promise<void>]>([
    ["no admission", async () => undefined],
    ["an admission that ended a minute ago", () => admission({ createdAt: at(-2 * HOUR), expiresAt: at(10 * HOUR), endedAt: at(-60_000) })],
    ["an admission that expired a minute ago", () => admission({ createdAt: at(-12 * HOUR), expiresAt: at(-60_000) })],
    ["an admission that starts in a minute", () => admission({ createdAt: at(60_000), expiresAt: at(12 * HOUR) })],
    ["an admission on another device", () => admission({ createdAt: at(-HOUR), expiresAt: at(11 * HOUR), device: DEVICE_2 })],
  ])("refuses the claim with the generic 403 `refused` given %s, recording nothing", async (_why, seed) => {
    if (skip()) return;
    gateOn();
    await E().admin.query(`DELETE FROM cashier_admissions`);
    await seed();
    const lot = await identity(P_OFF, `ADM-${key()}`, null);
    const res = await validate(TOKEN, line(P_OFF, { identityId: lot }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("refused");
    expect(await records()).toEqual([]);
  });

  it("refuses the claim of a user who is not an eligible cashier, even with a live admission (403 `refused`)", async () => {
    if (skip()) return;
    gateOn();
    // MANAGER holds the store_manager role, not the cashier role.
    await admission({ createdAt: at(-HOUR), expiresAt: at(11 * HOUR), user: MANAGER });
    const lot = await identity(P_OFF, `ELIG-${key()}`, null);
    const res = await validate(TOKEN, line(P_OFF, { identityId: lot }, { operatorUserId: MANAGER }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("refused");
  });

  it.each<[string, Body]>([
    ["both identityId and code", { identity: { identityId: randomUUID(), code: "LOT" } }],
    ["neither identityId nor code", { identity: {} }],
    ["an expiryDate with identityId", { identity: { identityId: randomUUID(), expiryDate: "2030-01-01" } }],
    ["an impossible expiryDate", { identity: { code: "LOT", expiryDate: "2030-02-30" } }],
    ["a zero quantity", { quantity: "0" }],
    ["an unknown selection", { selection: "guessed" }],
    ["an unknown key", { extra: 1 }],
    ["a body-supplied tenant", { tenant_id: TENANT }],
    ["an empty draftLineRef", { draftLineRef: "" }],
    ["a NUL in the code", { identity: { code: "LOT\u0000" } }],
    ["a 101-code-point draftLineRef", { draftLineRef: "d".repeat(101) }],
    ["a non-uuid operatorUserId", { operatorUserId: "cashier" }],
    ["a null operatorUserId", { operatorUserId: null as unknown as string }],
  ])("a malformed body (%s) is the 400 validation_error on both paths and records nothing", async (_why, change) => {
    if (skip()) return;
    gateOn();
    // The device path (the guard parses the body before the claim) and the envelope path (the handler's pipe).
    const device = await validate(TOKEN, { ...line(P_OFF, { identityId: randomUUID() }), ...change });
    expect(device.status).toBe(400);
    expect(device.body.error.code).toBe("validation_error");
    if (!("operatorUserId" in change)) {
      const envelope = await signInManager();
      const { operatorUserId: _claim, ...body } = { ...line(P_OFF, { identityId: randomUUID() }), ...change };
      const byEnvelope = await validate(envelope, body);
      expect(byEnvelope.status).toBe(400);
      expect(byEnvelope.body.error.code).toBe("validation_error");
    }
    expect(await records()).toEqual([]);
  });

  it("accepts a draftLineRef of 100 code points that are 200 UTF-16 units (the contract's maxLength)", async () => {
    if (skip()) return;
    gateOn();
    const lot = await identity(P_OFF, `CP-${key()}`, null);
    const res = await validate(TOKEN, line(P_OFF, { identityId: lot }, { draftLineRef: "\u{1F600}".repeat(100) }));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("accepted");
  });

  it("is rate limited per device in the posValidateTrackedLine bucket; a 429 records nothing", async () => {
    if (skip()) return;
    gateOn();
    const lot = await identity(P_OFF, `RL-${key()}`, null);
    await validate(TOKEN, line(P_OFF, { identityId: lot }));
    expect(limiter.calls.map((c) => c.bucket)).toEqual(["posValidateTrackedLine"]);
    expect(limiter.calls[0]!.key).toContain(DEVICE);
    limiter.deny = true;
    await E().admin.query(`DELETE FROM tracked_line_validations`);
    const res = await validate(TOKEN, line(P_OFF, { identityId: lot }));
    expect(res.status).toBe(429);
    expect(await records()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

describe("RT-451 S2 TLV — the check order and the single reason", () => {
  it("accepts a lot by id: the identity as Inventory knows it, the current revision, one record and one audit row", async () => {
    if (skip()) return;
    gateOn();
    const expiry = await businessDate(30);
    const lot = await identity(P_SUGGEST, `OK-${key()}`, expiry);
    const res = await validate(TOKEN, line(P_SUGGEST, { identityId: lot }, { quantity: "2.5", draftLineRef: "draft-ok" }));
    expect(res.status).toBe(200);
    conforms(res.body);
    expect(res.body).toMatchObject({
      outcome: "accepted",
      safetyRevision: await currentRevision(),
      identity: { identityId: lot, expiryDate: expiry },
    });
    expect(Date.parse(res.body.validatedAt)).not.toBeNaN();
    expect(await recordById(res.body.validationId)).toMatchObject({
      tenant_id: TENANT,
      store_id: STORE,
      device_id: DEVICE,
      operator_user_id: CASHIER,
      auth_path: "device",
      tenant_product_ref: P_SUGGEST,
      requested_identity_id: lot,
      requested_code: null,
      resolved_identity_id: lot,
      selection: "scanned",
      quantity: "2.500000",
      draft_line_ref: "draft-ok",
      outcome: "accepted",
      refusal_reason: null,
    });
    expect(validated()).toHaveLength(1);
    expect(validated()[0]!.metadata).toMatchObject({
      product_id: P_SUGGEST,
      validation_id: res.body.validationId,
      outcome: "accepted",
      device_id: DEVICE,
    });
  });

  it("matches a scanned code exactly; a scanned expiry that differs is recorded and never changes the result", async () => {
    if (skip()) return;
    gateOn();
    const code = `CODE-${key()}`;
    const lot = await identity(P_OFF, code, await businessDate(10));
    const res = await validate(TOKEN, line(P_OFF, { code, expiryDate: "2001-01-01" }));
    expect(res.body).toMatchObject({ outcome: "accepted", identity: { identityId: lot, code } });
    expect(await recordById(res.body.validationId)).toMatchObject({
      requested_identity_id: null,
      requested_code: code,
      scanned_expiry_date: "2001-01-01",
      resolved_identity_id: lot,
    });
    const lower = await validate(TOKEN, line(P_OFF, { code: code.toLowerCase() }));
    expect(lower.body).toMatchObject({ outcome: "refused", reason: "unknown_identity" });
  });

  it.each<[string, string]>([
    ["a retired product", P_RETIRED],
    ["an inactive product", P_INACTIVE],
    ["a product inactive at the store by its Store Override", P_STORE_OFF],
    ["a serial product (fail-closed)", P_SERIAL],
    ["an untracked product that is also retired (not_sellable before profile_mismatch)", P_NONE_RETIRED],
  ])("refuses %s as not_sellable, before the identity is looked up", async (_why, product) => {
    if (skip()) return;
    gateOn();
    const res = await validate(TOKEN, line(product, { identityId: randomUUID() }));
    expect(res.status).toBe(200);
    conforms(res.body);
    expect(res.body).toMatchObject({ outcome: "refused", reason: "not_sellable" });
    expect(await recordById(res.body.validationId)).toMatchObject({ resolved_identity_id: null, refusal_reason: "not_sellable" });
  });

  it("refuses an untracked product as profile_mismatch, before the identity is looked up", async () => {
    if (skip()) return;
    gateOn();
    const res = await validate(TOKEN, line(P_NONE, { identityId: randomUUID() }));
    expect(res.body).toMatchObject({ outcome: "refused", reason: "profile_mismatch" });
  });

  it("refuses an unknown id or code, and another tenant's identity, as unknown_identity", async () => {
    if (skip()) return;
    gateOn();
    const foreign = await identity(P_OTHER, `FOREIGN-${key()}`, null, TENANT_OTHER);
    for (const ref of [{ identityId: randomUUID() }, { code: `NOPE-${key()}` }, { identityId: foreign }]) {
      const res = await validate(TOKEN, line(P_OFF, ref));
      expect(res.body).toMatchObject({ outcome: "refused", reason: "unknown_identity" });
      conforms(res.body);
    }
  });

  it("Q11: a serial identity of a batch product is never a lot (unknown_identity), by id or by code", async () => {
    if (skip()) return;
    gateOn();
    const code = `SERIAL-${key()}`;
    const r = await E().admin.query<{ id: string }>(
      `INSERT INTO tracking_identities (tenant_id, tenant_product_ref, kind, code) VALUES ($1, $2, 'serial', $3)
       RETURNING id::text AS id`,
      [TENANT, P_OFF, code],
    );
    for (const ref of [{ identityId: r.rows[0]!.id }, { code }]) {
      expect((await validate(TOKEN, line(P_OFF, ref))).body).toMatchObject({ outcome: "refused", reason: "unknown_identity" });
    }
  });

  it("refuses another tenant's product as the non-disclosing 404, recording nothing", async () => {
    if (skip()) return;
    gateOn();
    const res = await validate(TOKEN, line(P_OTHER, { identityId: randomUUID() }));
    expect(res.status).toBe(404);
    expect(await records()).toEqual([]);
  });

  it("refuses another product's identity, by id or by code, as wrong_product", async () => {
    if (skip()) return;
    gateOn();
    const code = `WRONG-${key()}`;
    const other = await identity(P_SUGGEST, code, await businessDate(10));
    for (const ref of [{ identityId: other }, { code }]) {
      const res = await validate(TOKEN, line(P_OFF, ref));
      expect(res.body).toMatchObject({ outcome: "refused", reason: "wrong_product" });
    }
  });

  it("refuses a recalled lot as recalled (before held), a held one as held, and accepts it again on release", async () => {
    if (skip()) return;
    gateOn();
    const both = await identity(P_SUGGEST, `RH-${key()}`, await businessDate(10));
    await qualityHold(both);
    await recall(P_SUGGEST, both);
    expect((await validate(TOKEN, line(P_SUGGEST, { identityId: both }))).body).toMatchObject({ reason: "recalled" });

    const held = await identity(P_SUGGEST, `HQ-${key()}`, await businessDate(10));
    const holdId = await qualityHold(held);
    const refused = await validate(TOKEN, line(P_SUGGEST, { identityId: held }));
    expect(refused.body).toMatchObject({ outcome: "refused", reason: "held", safetyRevision: await currentRevision() });
    await holds.releaseHold({ tenantId: TENANT, userId: MANAGER, holdId, note: null });
    expect((await validate(TOKEN, line(P_SUGGEST, { identityId: held }))).body.outcome).toBe("accepted");
  });

  it("a held and expired lot is held (held before expired)", async () => {
    if (skip()) return;
    gateOn();
    const lot = await identity(P_OFF, `HE-${key()}`, await businessDate(-3));
    await qualityHold(lot);
    expect((await validate(TOKEN, line(P_OFF, { identityId: lot }))).body).toMatchObject({ reason: "held" });
  });

  it("G7-5: sellable on its expiry date at the store's business date, expired the day after", async () => {
    if (skip()) return;
    gateOn();
    const today = await identity(P_OFF, `EXP-TODAY-${key()}`, await businessDate(0));
    const yesterday = await identity(P_OFF, `EXP-YDAY-${key()}`, await businessDate(-1));
    expect((await validate(TOKEN, line(P_OFF, { identityId: today }))).body.outcome).toBe("accepted");
    const expired = await validate(TOKEN, line(P_OFF, { identityId: yesterday }));
    expect(expired.body).toMatchObject({ outcome: "refused", reason: "expired" });
    conforms(expired.body);
  });

  it("RT-451 comment 16246: a lot without an expiry is expired for a product that requires one, accepted otherwise", async () => {
    if (skip()) return;
    gateOn();
    const required = await identity(P_SUGGEST, `NOEXP-${key()}`, null);
    const res = await validate(TOKEN, line(P_SUGGEST, { identityId: required }));
    expect(res.body).toMatchObject({ outcome: "refused", reason: "expired" });
    conforms(res.body);
    const optional = await identity(P_OFF, `NOEXP-OFF-${key()}`, null);
    expect((await validate(TOKEN, line(P_OFF, { identityId: optional }))).body.outcome).toBe("accepted");
  });

  it("Q12: quantity never refuses, and nothing is reserved", async () => {
    if (skip()) return;
    gateOn();
    const lot = await identity(P_OFF, `QTY-${key()}`, null);
    const res = await validate(TOKEN, line(P_OFF, { identityId: lot }, { quantity: "9999999999999.999999" }));
    expect(res.body.outcome).toBe("accepted");
    const movements = await E().admin.query(`SELECT 1 FROM stock_movements WHERE tracking_identity_id = $1`, [lot]);
    expect(movements.rowCount).toBe(0);
  });

  it("records every call with a new id: a retry is a new validation, and a refusal is recorded too", async () => {
    if (skip()) return;
    gateOn();
    const lot = await identity(P_OFF, `RETRY-${key()}`, null);
    const body = line(P_OFF, { identityId: lot });
    const first = await validate(TOKEN, body);
    const second = await validate(TOKEN, body);
    const refused = await validate(TOKEN, line(P_OFF, { identityId: randomUUID() }));
    expect(new Set([first.body.validationId, second.body.validationId, refused.body.validationId]).size).toBe(3);
    expect((await records()).map((r) => [r.outcome, r.refusal_reason])).toEqual([
      ["accepted", null],
      ["accepted", null],
      ["refused", "unknown_identity"],
    ]);
    expect(validated()).toHaveLength(3);
    expect(validated()[2]!.metadata).toMatchObject({ outcome: "refused", reason: "unknown_identity" });
  });
});

// ---------------------------------------------------------------------------
// FEFO
// ---------------------------------------------------------------------------

describe("RT-451 S2 TLV — the FEFO suggestion (G7-13)", () => {
  it("under suggest: the earliest non-expired, non-held lot; a deviation is accepted and recorded", async () => {
    if (skip()) return;
    gateOn();
    // No earlier test leaves a P_SUGGEST lot expiring today, so today's lot is first.
    const earliest = await identity(P_SUGGEST, `FEFO-A-${key()}`, await businessDate(0));
    const later = await identity(P_SUGGEST, `FEFO-B-${key()}`, await businessDate(60));
    await identity(P_SUGGEST, `FEFO-EXPIRED-${key()}`, await businessDate(-1));
    const res = await validate(TOKEN, line(P_SUGGEST, { identityId: later }, { selection: "operator_selected" }));
    expect(res.body.outcome).toBe("accepted");
    conforms(res.body);
    expect(res.body.fefoSuggestion).toMatchObject({ identityId: earliest, expiryDate: await businessDate(0) });
    expect(await recordById(res.body.validationId)).toMatchObject({
      suggested_identity_id: earliest,
      selection: "operator_selected",
      resolved_identity_id: later,
    });
    // A held lot is never suggested.
    await qualityHold(earliest);
    const next = await validate(TOKEN, line(P_SUGGEST, { identityId: later }));
    expect(next.body.fefoSuggestion?.identityId).not.toBe(earliest);
  });

  it("never suggests a lot without an expiry for an expiry_required product, even with the only positive position", async () => {
    if (skip()) return;
    gateOn();
    const product = randomUUID();
    await E().admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode, expiry_required)
       VALUES ($1, $2, 'FEFO no expiry', 'standard', $3, $3, 'batch', true)`,
      [product, TENANT, MANAGER],
    );
    const undated = await identity(product, `UNDATED-${key()}`, null);
    const dated = await identity(product, `DATED-${key()}`, await businessDate(10));
    const target = await identity(product, `TARGET-${key()}`, await businessDate(20));
    const location = (
      await E().admin.query<{ id: string }>(`SELECT id::text AS id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE])
    ).rows[0]!.id;
    await E().admin.query(
      `INSERT INTO stock_movements
         (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason,
          occurred_at, created_by, stock_location_id, inventory_status, tracking_identity_id)
       VALUES (gen_random_uuid(), $1, $2, 'adjustment', 5, 'ea', $3, 'rt451 fixture', now(), $4, $5, 'sellable', $6)`,
      [TENANT, STORE, product, MANAGER, location, undated],
    );
    await E().admin.query(
      `UPDATE tenant_inventory_settings SET sale_effects_activated_at = now(), sale_effects_activated_by = $2 WHERE tenant_id = $1`,
      [TENANT, MANAGER],
    );
    try {
      const res = await validate(TOKEN, line(product, { identityId: target }));
      expect(res.body.outcome).toBe("accepted");
      // Positive-position-first would rank the undated lot first; fail closed leaves it out.
      expect(res.body.fefoSuggestion).toMatchObject({ identityId: dated });
    } finally {
      await E().admin.query(
        `UPDATE tenant_inventory_settings SET sale_effects_activated_at = NULL, sale_effects_activated_by = NULL WHERE tenant_id = $1`,
        [TENANT],
      );
    }
  });

  it("under off (no expiry required): no suggestion", async () => {
    if (skip()) return;
    gateOn();
    const lot = await identity(P_OFF, `OFF-${key()}`, await businessDate(5));
    const res = await validate(TOKEN, line(P_OFF, { identityId: lot }));
    expect(res.body).toMatchObject({ outcome: "accepted", fefoSuggestion: null });
    expect(await recordById(res.body.validationId)).toMatchObject({ suggested_identity_id: null });
  });
});
