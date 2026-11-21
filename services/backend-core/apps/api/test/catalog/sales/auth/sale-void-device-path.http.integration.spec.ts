/**
 * sale-void-device-path.http.integration.spec.ts — RT-1403 (RT-530 owner
 * decision c12029; [GATED: contract] approval: RT-1403 c18071; the separate route: c18113).
 *
 * `recordCashierVoid` (POST /api/pos/v1/sales/{saleRef}/cashier-void,
 * sales.yaml 1.26.0-draft) takes the paired terminal's DEVICE bearer plus the
 * requesting cashier's `operatorUserId` in the body. `recordVoid` stays the
 * manager and admin envelope route, unchanged. The server accepts the claim only when
 * a cashier admission of that device and store for that user is live NOW and
 * the cashier is still eligible; the verified cashier is then the void's actor,
 * so every RT-530 check applies unchanged (requester bound to the actor,
 * four-eyes, same business day, approver eligibility, approval bound to this
 * void).
 *
 * Wiring mirrors production: the real SalesModule, PosOperatorsModule and
 * CashierAdmissionsModule, AUTH_LOOKUP_POOL = the RLS-exempt admin pool,
 * PG_POOL = the NOBYPASSRLS `app_test` role, and the GLOBAL
 * FailClosedAuthGuard, so the route's @DeviceBearer marker is exercised the
 * way the app runs it. No guard is overridden.
 *
 * NOTE: CI runs Testcontainers (db-integration). Locally without Docker this
 * suite skips when MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { hashToken } from "@data-pulse-2/auth";
import cookieParser from "cookie-parser";
import request from "supertest";

import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import { AuthModule } from "../../../../src/auth/auth.module";
import { RateLimiter, type RateLimitDecision } from "../../../../src/auth/rate-limit";
import { FailClosedAuthGuard } from "../../../../src/auth/fail-closed-auth.guard";
import { SalesModule } from "../../../../src/catalog/sales/sales.module";
import { sha256CanonicalHex } from "../../../../src/common/hashing/payload-hash";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { RequestIdInterceptor } from "../../../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../../../src/common/zod-validation.pipe";
import { AUTH_LOOKUP_POOL, PG_POOL } from "../../../../src/database";
import { CashierAdmissionsModule } from "../../../../src/pos-cashier-admissions/cashier-admissions.module";
import { PosOperatorsModule } from "../../../../src/pos-operators/pos-operators.module";
import { linkClerkUsers } from "../../../_helpers/identity-links";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";

// No real Redis: AuthModule falls back to its no-op client.
delete process.env["REDIS_URL"];

const TENANT = "0a140300-0000-4000-8000-000000000001";
const STORE = "0a140300-0000-4000-8000-0000000000a1";
const ROLE_STAFF = "0a140300-0000-4000-8000-0000000000b1";
const ROLE_MANAGER = "0a140300-0000-4000-8000-0000000000b2";
const CASHIER = "0a140300-0000-4000-8000-0000000000c1";
const CASHIER_2 = "0a140300-0000-4000-8000-0000000000c2";
const MANAGER = "0a140300-0000-4000-8000-0000000000c3";
const M_CASHIER = "0a140300-0000-4000-8000-0000000000d1";
const M_CASHIER_2 = "0a140300-0000-4000-8000-0000000000d2";
const M_MANAGER = "0a140300-0000-4000-8000-0000000000d3";
const DEVICE = "0a140300-0000-4000-8000-0000000000e1";
const DEVICE_2 = "0a140300-0000-4000-8000-0000000000e2";
const TOKEN = "rt1403-device-token-till-1";
const TOKEN_2 = "rt1403-device-token-till-2";

const HOUR = 3_600_000;
const fromNow = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  readonly payloads: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.payloads.push(payload);
  }
}

/** The per-device limiter, recording every check; it denies `denyBucket` for `denyKey`. */
class SwitchRateLimiter {
  denyBucket: string | null = null;
  denyKey: string | null = null;
  readonly calls: Array<{ bucket: string; key: string }> = [];
  async check(bucket: string, key: string): Promise<RateLimitDecision> {
    this.calls.push({ bucket, key });
    const allowed = !(bucket === this.denyBucket && key === this.denyKey);
    return { allowed, count: 1, remaining: 0, resetMs: 30_000 };
  }
  async release(): Promise<void> {}
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
const audit = new SpyAuditEnqueuer();
const limiter = new SwitchRateLimiter();

function E(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
function http(): ReturnType<typeof request> {
  if (!app) throw new Error("app not initialized");
  return request(app.getHttpServer());
}
const skip = (): boolean => dockerSkipped;

/** A cashier admission of the till, live from an hour ago for eight hours. */
async function liveAdmission(
  opts: { user?: string; device?: string; endedAt?: string; expiresAt?: string } = {},
): Promise<void> {
  await E().admin.query(
    `INSERT INTO cashier_admissions
       (id, tenant_id, store_id, user_id, device_id, mode,
        created_at, renewed_at, expires_at, ended_at, end_reason)
     VALUES ($1, $2, $3, $4, $5, 'online',
             $6::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9)`,
    [
      randomUUID(),
      TENANT,
      STORE,
      opts.user ?? CASHIER,
      opts.device ?? DEVICE,
      fromNow(-HOUR),
      opts.expiresAt ?? fromNow(8 * HOUR),
      opts.endedAt ?? null,
      opts.endedAt ? "device_end" : null,
    ],
  );
}

interface SoldSale {
  readonly saleRef: string;
  readonly businessDate: string;
}

/** A sale captured by CASHIER from the till (device path), at the current time. */
async function captureSale(): Promise<SoldSale> {
  const res = await http()
    .post("/api/pos/v1/sales")
    .set("Idempotency-Key", randomUUID().replace(/-/g, ""))
    .set("Authorization", `Bearer ${TOKEN}`)
    .send({
      sourceSystem: "pos-pulse",
      externalId: `rt1403-sale-${randomUUID().slice(0, 8)}`,
      currencyCode: "EGP",
      posTotal: "12.50",
      occurredAt: fromNow(-1_000),
      operatorUserId: CASHIER,
      lines: [
        { lineName: "Widget", unitPrice: "5.00", currencyCode: "EGP", quantity: "1", lineAmount: "5.00", unit: "unit" },
        { lineName: "Gadget", unitPrice: "7.50", currencyCode: "EGP", quantity: "1", lineAmount: "7.50", unit: "unit" },
      ],
    });
  expect(res.status).toBe(201);
  const saleRef = res.body.saleRef as string;
  const r = await E().admin.query<{ business_date: string }>(
    `SELECT business_date::text AS business_date FROM sales WHERE id = $1`,
    [saleRef],
  );
  return { saleRef, businessDate: r.rows[0]!.business_date };
}

interface VoidOverrides {
  readonly operatorUserId?: string | null;
  readonly requesterUserId?: string;
  readonly approverUserId?: string;
  readonly businessDate?: string;
}

/** A void body with a valid bound approval; the cashier route needs `operatorUserId`. */
function voidBody(sale: SoldSale, o: VoidOverrides = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sourceSystem: "pos-pulse",
    externalId: `pos-pulse-void:${randomUUID()}`,
    businessDate: o.businessDate ?? sale.businessDate,
    approval: {
      approvalId: randomUUID(),
      action: "sale.void",
      saleRef: sale.saleRef,
      amount: "12.50",
      requesterUserId: o.requesterUserId ?? CASHIER,
      approverUserId: o.approverUserId ?? MANAGER,
      policyVersion: "rt114-v1",
      approvedAt: fromNow(-5_000),
    },
  };
  if (o.operatorUserId !== undefined) body["operatorUserId"] = o.operatorUserId;
  return body;
}

function postVoid(opts: {
  sale: SoldSale;
  bearer: string | null;
  body: Record<string, unknown>;
  key?: string;
  /** The route: the cashier route by default; `void` is the manager envelope route. */
  route?: "cashier-void" | "void";
}): request.Test {
  const req = http()
    .post(`/api/pos/v1/sales/${opts.sale.saleRef}/${opts.route ?? "cashier-void"}`)
    .set("Idempotency-Key", opts.key ?? randomUUID().replace(/-/g, ""));
  if (opts.bearer !== null) req.set("Authorization", `Bearer ${opts.bearer}`);
  return req.send(opts.body);
}

async function voidRows(saleRef: string): Promise<
  Array<{
    created_by: string;
    requested_by_user_id: string;
    approved_by_user_id: string;
    payload_hash: string;
  }>
> {
  const r = await E().admin.query(
    `SELECT created_by::text, requested_by_user_id::text, approved_by_user_id::text, payload_hash
       FROM sale_voids WHERE sale_id = $1`,
    [saleRef],
  );
  return r.rows;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[sale-void-device-path] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt1403-tenant', 'RT-1403 Tenant')`, [TENANT]);
  await a.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $3, 'store_staff', 'Cashier'), ($2, $3, 'store_manager', 'Manager')`,
    [ROLE_STAFF, ROLE_MANAGER, TENANT],
  );
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S1', 'Store 1')`, [STORE, TENANT]);
  await a.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES
       ($1, 'cashier@rt1403.example',  'Cashier One', 'user_clerk_rt1403_c1'),
       ($2, 'cashier2@rt1403.example', 'Cashier Two', 'user_clerk_rt1403_c2'),
       ($3, 'manager@rt1403.example',  'Manager',     'user_clerk_rt1403_m')`,
    [CASHIER, CASHIER_2, MANAGER],
  );
  await linkClerkUsers(a);
  await a.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $4, $5, $8, 'specific'), ($2, $4, $6, $8, 'specific'), ($3, $4, $7, $9, 'specific')`,
    [M_CASHIER, M_CASHIER_2, M_MANAGER, TENANT, CASHIER, CASHIER_2, MANAGER, ROLE_STAFF, ROLE_MANAGER],
  );
  await a.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $4, $5), ($2, $4, $5), ($3, $4, $5)`,
    [M_CASHIER, M_CASHIER_2, M_MANAGER, STORE, TENANT],
  );
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES
       ($1, $2, $3, 'till-1', $4), ($5, $2, $3, 'till-2', $6)`,
    [DEVICE, TENANT, STORE, hashToken(TOKEN), DEVICE_2, hashToken(TOKEN_2)],
  );

  const moduleRef = await Test.createTestingModule({
    imports: [AuthModule, PosOperatorsModule, CashierAdmissionsModule, SalesModule],
    providers: [{ provide: APP_GUARD, useClass: FailClosedAuthGuard }],
  })
    .overrideProvider(PG_POOL)
    .useValue(env.app)
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(env.admin)
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
  if (app) await app.close().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (!env) return;
  await env.admin.query(`DELETE FROM cashier_admissions`);
  await env.admin.query(`UPDATE devices SET revoked_at = NULL`);
  await env.admin.query(`DELETE FROM cashier_suspensions`);
  audit.payloads.length = 0;
  limiter.denyBucket = null;
  limiter.denyKey = null;
  limiter.calls.length = 0;
});

describe("recordCashierVoid — cashier device route (RT-1403)", () => {
  it("a live admitted cashier voids their own sale: 201, requester = approver-bound cashier, then a 200 replay", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    const body = voidBody(sale, { operatorUserId: CASHIER });
    const key = randomUUID().replace(/-/g, "");

    const first = await postVoid({ sale, bearer: TOKEN, body, key });
    expect(first.status).toBe(201);
    expect(first.body.kind).toBe("void");

    const rows = await voidRows(sale.saleRef);
    expect(rows).toHaveLength(1);
    // The verified cashier is the actor and the requester; the manager approved.
    expect(rows[0]!.created_by).toBe(CASHIER);
    expect(rows[0]!.requested_by_user_id).toBe(CASHIER);
    expect(rows[0]!.approved_by_user_id).toBe(MANAGER);
    // The claim is not a void fact: the stored hash is the one an envelope void would store.
    const { operatorUserId: _claim, ...hashed } = body;
    expect(rows[0]!.payload_hash).toBe(sha256CanonicalHex(hashed));

    const replay = await postVoid({ sale, bearer: TOKEN, body, key });
    expect(replay.status).toBe(201); // same Idempotency-Key replays the stored 201
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(await voidRows(sale.saleRef)).toHaveLength(1);

    // A different key on the same void provenance is the deterministic 200 replay.
    const provenanceReplay = await postVoid({ sale, bearer: TOKEN, body });
    expect(provenanceReplay.status).toBe(200);
    expect(provenanceReplay.headers["idempotent-replayed"]).toBe("true");
    expect(await voidRows(sale.saleRef)).toHaveLength(1);
  });

  it("no live admission (ended) -> the generic 403 refused, nothing recorded", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    await E().admin.query(`DELETE FROM cashier_admissions`);
    await liveAdmission({ endedAt: fromNow(-60_000) });
    const res = await postVoid({ sale, bearer: TOKEN, body: voidBody(sale, { operatorUserId: CASHIER }) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("refused");
    expect(await voidRows(sale.saleRef)).toHaveLength(0);
  });

  it("another cashier's admission does not authorize the claimed cashier -> 403 refused", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    await liveAdmission({ user: CASHIER_2 });
    await E().admin.query(`DELETE FROM cashier_admissions WHERE user_id = $1`, [CASHIER]);
    const res = await postVoid({ sale, bearer: TOKEN, body: voidBody(sale, { operatorUserId: CASHIER }) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("refused");
    expect(await voidRows(sale.saleRef)).toHaveLength(0);
  });

  it("the approval's requester must be the verified cashier -> 403 void_requester_mismatch", async () => {
    if (skip()) return;
    await liveAdmission();
    await liveAdmission({ user: CASHIER_2 });
    const sale = await captureSale();
    // CASHIER_2 is admitted and claimed, but the approval names CASHIER as the requester.
    const res = await postVoid({
      sale,
      bearer: TOKEN,
      body: voidBody(sale, { operatorUserId: CASHIER_2, requesterUserId: CASHIER }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("void_requester_mismatch");
    expect(await voidRows(sale.saleRef)).toHaveLength(0);
  });

  it("four-eyes still holds on the device path: approver = requester -> 403 void_self_approval", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    const res = await postVoid({
      sale,
      bearer: TOKEN,
      body: voidBody(sale, { operatorUserId: CASHIER, approverUserId: CASHIER }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("void_self_approval");
    expect(await voidRows(sale.saleRef)).toHaveLength(0);
  });

  it("a void outside the sale's business day is still refused -> 422 void_outside_business_day", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    const res = await postVoid({
      sale,
      bearer: TOKEN,
      body: voidBody(sale, { operatorUserId: CASHIER, businessDate: "2020-01-01" }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("void_outside_business_day");
    expect(await voidRows(sale.saleRef)).toHaveLength(0);
  });

  it("an approver who is not a manager is refused -> 403 void_approver_not_eligible", async () => {
    if (skip()) return;
    await liveAdmission();
    await liveAdmission({ user: CASHIER_2 });
    const sale = await captureSale();
    const res = await postVoid({
      sale,
      bearer: TOKEN,
      body: voidBody(sale, { operatorUserId: CASHIER, approverUserId: CASHIER_2 }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("void_approver_not_eligible");
  });

  it("a body without operatorUserId from an authenticated device is the usual 400 (there is no envelope fallback)", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    const res = await postVoid({ sale, bearer: TOKEN, body: voidBody(sale) });
    expect(res.status).toBe(400);
    expect(await voidRows(sale.saleRef)).toHaveLength(0);
  });

  it("the manager route recordVoid refuses the device token: generic 401, nothing recorded (it stays envelope-only)", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    const res = await postVoid({ sale, bearer: TOKEN, body: voidBody(sale), route: "void" });
    expect(res.status).toBe(401);
    expect(await voidRows(sale.saleRef)).toHaveLength(0);
  });

  it("the manager route recordVoid refuses a body carrying operatorUserId even with the device token: 401, nothing recorded", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    const res = await postVoid({
      sale,
      bearer: TOKEN,
      body: voidBody(sale, { operatorUserId: CASHIER }),
      route: "void",
    });
    expect(res.status).toBe(401);
    expect(await voidRows(sale.saleRef)).toHaveLength(0);
  });

  it("an envelope-style bearer carrying operatorUserId is the generic 401 (an envelope is not a device credential)", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    const res = await postVoid({
      sale,
      bearer: "not-a-device-token",
      body: voidBody(sale, { operatorUserId: CASHIER }),
    });
    expect(res.status).toBe(401);
    expect(await voidRows(sale.saleRef)).toHaveLength(0);
  });

  it("no bearer at all is a 401", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    const res = await postVoid({ sale, bearer: null, body: voidBody(sale, { operatorUserId: CASHIER }) });
    expect(res.status).toBe(401);
  });

  it("an admission of ANOTHER device does not authorize the claim: a cashier admitted on till 2 is refused with till 1's token", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    await E().admin.query(`DELETE FROM cashier_admissions`);
    await liveAdmission({ device: DEVICE_2 });
    const res = await postVoid({ sale, bearer: TOKEN, body: voidBody(sale, { operatorUserId: CASHIER }) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("refused");
    expect(await voidRows(sale.saleRef)).toHaveLength(0);
    // The same cashier with till 2's own token is accepted: the device row is the scope.
    const ok = await postVoid({ sale, bearer: TOKEN_2, body: voidBody(sale, { operatorUserId: CASHIER }) });
    expect(ok.status).toBe(201);
  });

  it("an expired admission (expires_at in the past, never ended) is refused: 403 refused, nothing recorded", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    await E().admin.query(`DELETE FROM cashier_admissions`);
    await liveAdmission({ expiresAt: fromNow(-60_000) });
    const res = await postVoid({ sale, bearer: TOKEN, body: voidBody(sale, { operatorUserId: CASHIER }) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("refused");
    expect(await voidRows(sale.saleRef)).toHaveLength(0);
  });

  it("a cashier SUSPENDED at the store with a still-live admission is refused: generic 403 refused, nothing recorded (review H2)", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    // Suspending does not end the live admission; the void must still be refused.
    await E().admin.query(
      `INSERT INTO cashier_suspensions (tenant_id, store_id, user_id, status, changed_by_user_id)
       VALUES ($1, $2, $3, 'suspended', $4)`,
      [TENANT, STORE, CASHIER, MANAGER],
    );
    const res = await postVoid({ sale, bearer: TOKEN, body: voidBody(sale, { operatorUserId: CASHIER }) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("refused");
    expect(await voidRows(sale.saleRef)).toHaveLength(0);
    // Reinstated (status active): the same void is accepted.
    await E().admin.query(`UPDATE cashier_suspensions SET status = 'active' WHERE user_id = $1`, [CASHIER]);
    const ok = await postVoid({ sale, bearer: TOKEN, body: voidBody(sale, { operatorUserId: CASHIER }) });
    expect(ok.status).toBe(201);
  });

  it("the per-device write limit runs after the guard, on the cashier route's own bucket (review M1)", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    const ok = await postVoid({ sale, bearer: TOKEN, body: voidBody(sale, { operatorUserId: CASHIER }) });
    expect(ok.status).toBe(201);
    expect(limiter.calls).toContainEqual({ bucket: "posWriteSaleVoid", key: DEVICE });

    const sale2 = await captureSale();
    limiter.denyBucket = "posWriteSaleVoid";
    limiter.denyKey = DEVICE;
    const denied = await postVoid({ sale: sale2, bearer: TOKEN, body: voidBody(sale2, { operatorUserId: CASHIER }) });
    expect(denied.status).toBe(429);
    expect(denied.headers["retry-after"]).toBe("30");
    expect(await voidRows(sale2.saleRef)).toHaveLength(0);
    // Another till has its own budget (one live admission per cashier: move it to till 2).
    await E().admin.query(`DELETE FROM cashier_admissions`);
    await liveAdmission({ device: DEVICE_2 });
    const other = await postVoid({ sale: sale2, bearer: TOKEN_2, body: voidBody(sale2, { operatorUserId: CASHIER }) });
    expect(other.status).toBe(201);
  });

  it("an unauthenticated request never spends the limiter (the guard runs first)", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    limiter.calls.length = 0;
    const res = await postVoid({ sale, bearer: "not-a-device-token", body: voidBody(sale, { operatorUserId: CASHIER }) });
    expect(res.status).toBe(401);
    expect(limiter.calls.filter((c) => c.bucket === "posWriteSaleVoid")).toEqual([]);
  });

  it("a revoked device is the generic 401, never the 403 refused", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    await E().admin.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEVICE]);
    const res = await postVoid({ sale, bearer: TOKEN, body: voidBody(sale, { operatorUserId: CASHIER }) });
    expect(res.status).toBe(401);
    expect(await voidRows(sale.saleRef)).toHaveLength(0);
  });

  it("a malformed operatorUserId from an authenticated device is the usual 400", async () => {
    if (skip()) return;
    await liveAdmission();
    const sale = await captureSale();
    const res = await postVoid({ sale, bearer: TOKEN, body: voidBody(sale, { operatorUserId: "not-a-uuid" }) });
    expect(res.status).toBe(400);
  });
});
