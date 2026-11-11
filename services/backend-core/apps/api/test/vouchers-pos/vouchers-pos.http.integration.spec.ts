/**
 * RT-1112 (RT-1098 slice R-3) — Contract V-A (`pos-payments/vouchers.yaml`)
 * over HTTP against real Postgres (Testcontainers, every migration, the
 * NOBYPASSRLS `app_test` pool narrowed to the production voucher grants:
 * UPDATE only on `vouchers (status, cancelled_at, cancelled_by_user_id)`,
 * `voucher_redemption_intents (consumed_at)` and `voucher_redemptions
 * (reversed_at, reversed_by_device_id)`; RT-1112 c16559).
 *
 * Wiring mirrors production: the real AuthModule and VouchersPosModule (with
 * its IdempotencyModule: the replay store is the real Postgres mirror, Redis is
 * the stub) and the GLOBAL FailClosedAuthGuard. Substituted: the audit fan-out
 * and the rate limiter's Redis (an in-memory window, so the failed-lookup
 * budget is real). No guard is overridden.
 *
 * Cases (RT-810 section 6, RT-922 section 7, RT-1112 acceptance criteria and
 * owner decisions c16636):
 *   - credentials: generic 401 for no, an unknown or a revoked device token;
 *     generic 403 `refused` without a cashier admission of this device live
 *     now, checked BEFORE the code lookup;
 *   - validate: the 200 and its contract shape; only the token hash stored; the
 *     intent TTL from the database clock; over-application refused both ways;
 *     zero refused; cancelled, redeemed, expired refused; D4 eligibility; an
 *     unknown and a cross-tenant code are the identical 404;
 *   - redeem: the binding columns copied from the intent; single use; wrong
 *     attempt; expired intent; cross-tenant and other-store token 404;
 *     validate-then-expiry and a lock wait past expiry are `voucher_expired`
 *     with the voucher unchanged; two concurrent redeems and a racing cancel
 *     have exactly one winner;
 *   - idempotency: same key + same body replays (validate, redeem with
 *     `idempotent_replayed: true`, reverse with `already_reversed: true`); same
 *     key + other body is 409; a redeem replay is served after the cashier's
 *     admission ended (decision 1), a fresh redeem is not;
 *   - reverse: same store any device, records the reversing device, attributed
 *     to the redeem-time cashier; twice keeps the original timestamp; another
 *     store is `redemption_branch_mismatch`; another tenant 404; an expired
 *     voucher is restored and still answers `voucher_expired` (decision 2);
 *   - rate limit: 10 failed lookups per device, then 429 with Retry-After; a
 *     found code gives its hit back; a refused claim spends nothing (decision 3);
 *   - secrecy: no code or token in logs or audit rows, no forfeited amount in
 *     audit, no code in idempotency storage.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { hashToken } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";

import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../../src/auth/auth.module";
import { FailClosedAuthGuard } from "../../src/auth/fail-closed-auth.guard";
import { RateLimiter, type RedisLike, type WindowHit } from "../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { LoggingInterceptor } from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { loadOpenApiContracts } from "../../src/openapi/loader";
import { hashVoucherCode } from "../../src/vouchers-admin/voucher-code";
import { VouchersPosModule } from "../../src/vouchers-pos/vouchers-pos.module";
import { INTENT_TTL_SECONDS } from "../../src/vouchers-pos/vouchers-pos.queries";
import { linkClerkUsers } from "../_helpers/identity-links";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

delete process.env["REDIS_URL"];

// `1112` mnemonic, hex-safe.
const id = (n: string): string => `0a111200-0000-4000-8000-0000000${n}`;
const TENANT = id("00001");
const TENANT_B = id("00002");
const STORE = id("000a1");
const STORE_2 = id("000a2");
const STORE_B = id("000a3");
const ROLE_STAFF = id("000b1");
const ROLE_STAFF_B = id("000b2");
const CASHIER = id("000c1");
const CASHIER_2 = id("000c2");
const CASHIER_B = id("000c3");
const CASHIER_RL = id("000c4");
const DEVICE = id("000e1");
const DEVICE_2 = id("000e2");
const DEVICE_S2 = id("000e3");
const DEVICE_B = id("000e4");
const DEVICE_REVOKED = id("000e5");
const DEVICE_RL = id("000e6");
const DEVICE_NOADM = id("000e7");
const ISSUER = id("000c9");
const BATCH = id("000f1");
const TOKEN = "rt1112-device-token-store-till-1";
const TOKEN_2 = "rt1112-device-token-store-till-2";
const TOKEN_S2 = "rt1112-device-token-store-two";
const TOKEN_B = "rt1112-device-token-other-tenant";
const TOKEN_REVOKED = "rt1112-device-token-revoked";
const TOKEN_RL = "rt1112-device-token-rate-limit";
const TOKEN_NOADM = "rt1112-device-token-no-admission";

const VALUE = 1000;

/** The rate limiter's Redis: a real fixed window, in memory. */
class MemoryWindowRedis implements RedisLike {
  private readonly windows = new Map<string, { count: number; until: number }>();
  async incrWindow(key: string, ttlMs: number): Promise<WindowHit> {
    const now = Date.now();
    const w = this.windows.get(key);
    const live = w && w.until > now ? w : { count: 0, until: now + ttlMs };
    live.count += 1;
    this.windows.set(key, live);
    return { count: live.count, ttlMs: live.until - now };
  }
  async pttl(key: string): Promise<number> {
    const w = this.windows.get(key);
    return w ? w.until - Date.now() : -2;
  }
  async decr(key: string): Promise<number> {
    const w = this.windows.get(key);
    if (!w) return -1;
    w.count -= 1;
    return w.count;
  }
  async del(key: string): Promise<number> {
    return this.windows.delete(key) ? 1 : 0;
  }
  count(key: string): number {
    return this.windows.get(key)?.count ?? 0;
  }
}

const NOOP_AUDIT: AuditJobEnqueuer = { enqueue: async () => undefined };

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let skipped = false;
const logLines: string[] = [];
const rlRedis = new MemoryWindowRedis();
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const E = (): PgTestEnv => {
  if (!env) throw new Error("env not initialized");
  return env;
};
const skip = (): boolean => skipped;
const http = () => request((app as INestApplication).getHttpServer());

let seq = 0;
const key = (): string => `rt1112-key-${randomUUID()}-${(seq += 1)}`;

function conforms(schema: string, body: unknown): void {
  const check = ajv.getSchema(`vouchers#/components/schemas/${schema}`);
  if (!check) throw new Error(`ajv cannot resolve ${schema}`);
  if (!check(body)) throw new Error(`contract violation (${schema}): ${JSON.stringify(check.errors)}`);
}

function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  conforms("Error", res.body);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

interface ValidateBody {
  operatorUserId?: string;
  code?: string;
  payment_attempt_id?: string;
  applied_amount_minor?: number;
  remaining_balance_minor?: number;
  [extra: string]: unknown;
}

function post(path: string, bearer: string | null, body: object, idemKey: string | null = key()) {
  let req = http().post(`/api/pos/v1/vouchers/${path}`);
  if (bearer !== null) req = req.set("Authorization", `Bearer ${bearer}`);
  if (idemKey !== null) req = req.set("Idempotency-Key", idemKey);
  return req.send(body);
}

const validateBody = (code: string, extra: Partial<ValidateBody> = {}): ValidateBody => ({
  operatorUserId: CASHIER,
  code,
  payment_attempt_id: randomUUID(),
  applied_amount_minor: 600,
  remaining_balance_minor: 5000,
  ...extra,
});
const validate = (bearer: string | null, body: ValidateBody, idemKey?: string | null) => post("validate", bearer, body, idemKey);
const redeem = (bearer: string | null, body: object, idemKey?: string | null) => post("redeem", bearer, body, idemKey);
const reverse = (bearer: string | null, body: object, idemKey?: string | null) => post("reverse", bearer, body, idemKey);

interface Validated {
  token: string;
  attempt: string;
}

async function validateOk(code: string, bearer = TOKEN, extra: Partial<ValidateBody> = {}): Promise<Validated> {
  const body = validateBody(code, extra);
  const res = await validate(bearer, body);
  expect([res.status, res.body]).toEqual([200, expect.anything()]);
  conforms("PosValidateVoucherResponse", res.body);
  return { token: (res.body as { redemption_intent_token: string }).redemption_intent_token, attempt: body.payment_attempt_id! };
}

async function redeemOk(v: Validated, bearer = TOKEN, operatorUserId = CASHIER): Promise<string> {
  const res = await redeem(bearer, { operatorUserId, redemption_intent_token: v.token, payment_attempt_id: v.attempt });
  expect([res.status, res.body]).toEqual([200, expect.anything()]);
  conforms("PosRedeemVoucherResponse", res.body);
  return (res.body as { redemption_id: string }).redemption_id;
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

let codeSeq = 0;
/** A fresh normalised code (16 Crockford chars, unique per test run). */
function freshCode(): string {
  codeSeq += 1;
  return `RT1112${String(codeSeq).padStart(10, "0")}`;
}

interface VoucherSeed {
  tenant?: string;
  status?: "active" | "redeemed" | "cancelled";
  expiresAt?: string | null;
  allStores?: boolean;
  stores?: readonly string[];
  amount?: number;
}

/** Seed one voucher; returns its id and its code as a till would type it. */
async function seedVoucher(opts: VoucherSeed = {}): Promise<{ id: string; code: string; typed: string }> {
  const voucherId = randomUUID();
  const code = freshCode();
  const tenant = opts.tenant ?? TENANT;
  const status = opts.status ?? "active";
  await E().admin.query(
    `INSERT INTO vouchers
       (id, tenant_id, batch_id, code_hash, amount_minor, currency_code, status, expires_at, applies_to_all_stores,
        issued_by_user_id, cancelled_at, cancelled_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'USD', $6, $7::timestamptz, $8, $9,
             CASE WHEN $6 = 'cancelled' THEN now() END, CASE WHEN $6 = 'cancelled' THEN $9::uuid END)`,
    [voucherId, tenant, BATCH, hashVoucherCode(code), opts.amount ?? VALUE, status, opts.expiresAt ?? null, opts.allStores ?? true, ISSUER],
  );
  for (const store of opts.stores ?? []) {
    await E().admin.query(`INSERT INTO voucher_eligible_stores (tenant_id, voucher_id, store_id) VALUES ($1, $2, $3)`, [
      tenant,
      voucherId,
      store,
    ]);
  }
  // The till types it in lower case with hyphens: the lookup normalises.
  const typed = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12)}`.toLowerCase();
  return { id: voucherId, code, typed };
}

const inSeconds = (s: number): string => new Date(Date.now() + s * 1000).toISOString();

async function voucherStatus(voucherId: string): Promise<string> {
  const r = await E().admin.query<{ status: string }>(`SELECT status FROM vouchers WHERE id = $1`, [voucherId]);
  return r.rows[0]!.status;
}

async function admission(device: string, user: string, tenant = TENANT, store = STORE): Promise<void> {
  await E().admin.query(
    `INSERT INTO cashier_admissions
       (id, tenant_id, store_id, user_id, device_id, mode, created_at, renewed_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'online', now() - interval '1 hour', now() - interval '1 hour', now() + interval '11 hours')`,
    [randomUUID(), tenant, store, user, device],
  );
}

async function auditRows(action: string): Promise<Array<{ actor_user_id: string; store_id: string; target_id: string; metadata: Record<string, unknown> }>> {
  const r = await E().admin.query(
    `SELECT actor_user_id::text, store_id::text, target_id::text, metadata FROM audit_events WHERE action = $1 ORDER BY occurred_at, id`,
    [action],
  );
  return r.rows;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw new Error(`Container start failed: ${reason}`);
    // eslint-disable-next-line no-console
    console.warn(`\n[vouchers-pos] Docker NOT AVAILABLE: ${reason}\n`);
    skipped = true;
    return;
  }
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt1112-a', 'RT-1112 A'), ($2, 'rt1112-b', 'RT-1112 B')`, [TENANT, TENANT_B]);
  await a.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $3, 'store_staff', 'Cashier'), ($2, $4, 'store_staff', 'Cashier')`,
    [ROLE_STAFF, ROLE_STAFF_B, TENANT, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name, timezone) VALUES
       ($1, $4, 'S1', 'Store 1', 'Africa/Cairo'), ($2, $4, 'S2', 'Store 2', 'Africa/Cairo'), ($3, $5, 'SB', 'Store B', 'Africa/Cairo')`,
    [STORE, STORE_2, STORE_B, TENANT, TENANT_B],
  );
  await a.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES
       ($1, 'cashier@rt1112.example', 'Cashier', 'user_clerk_rt1112_cashier'),
       ($2, 'cashier2@rt1112.example', 'Cashier Two', 'user_clerk_rt1112_cashier2'),
       ($3, 'cashierb@rt1112.example', 'Cashier B', 'user_clerk_rt1112_cashierb'),
       ($4, 'issuer@rt1112.example', 'Issuer', 'user_clerk_rt1112_issuer'),
       ($5, 'cashierrl@rt1112.example', 'Cashier RL', 'user_clerk_rt1112_cashierrl')`,
    [CASHIER, CASHIER_2, CASHIER_B, ISSUER, CASHIER_RL],
  );
  await linkClerkUsers(a);
  await a.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $4, $6, $9, 'all'), ($2, $4, $7, $9, 'all'), ($3, $5, $8, $10, 'all'), ($11, $4, $12, $9, 'all')`,
    [randomUUID(), randomUUID(), randomUUID(), TENANT, TENANT_B, CASHIER, CASHIER_2, CASHIER_B, ROLE_STAFF, ROLE_STAFF_B, randomUUID(), CASHIER_RL],
  );
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES
       ($1, $8, $9, 'till-1', $11), ($2, $8, $9, 'till-2', $12), ($3, $8, $10, 'store-2', $13),
       ($4, $14, $15, 'other', $16), ($5, $8, $9, 'revoked', $17), ($6, $8, $9, 'rate-limit', $18), ($7, $8, $9, 'no-admission', $19)`,
    [
      DEVICE, DEVICE_2, DEVICE_S2, DEVICE_B, DEVICE_REVOKED, DEVICE_RL, DEVICE_NOADM,
      TENANT, STORE, STORE_2,
      hashToken(TOKEN), hashToken(TOKEN_2), hashToken(TOKEN_S2),
      TENANT_B, STORE_B, hashToken(TOKEN_B),
      hashToken(TOKEN_REVOKED), hashToken(TOKEN_RL), hashToken(TOKEN_NOADM),
    ],
  );
  await a.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEVICE_REVOKED]);

  const dir = resolve(__dirname, "..", "..", "..", "..", "packages", "contracts", "openapi", "pos-payments");
  const contract = loadOpenApiContracts({ dir }).find((c) => c.id === "vouchers");
  if (!contract) throw new Error("vouchers.yaml not found");
  ajv.addSchema(contract.document as object, "vouchers");

  const moduleRef = await Test.createTestingModule({
    imports: [AuthModule, VouchersPosModule],
    providers: [{ provide: APP_GUARD, useClass: FailClosedAuthGuard }],
  })
    .overrideProvider(PG_POOL)
    .useValue(env.app)
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(env.admin)
    .overrideProvider(AUDIT_JOB_ENQUEUER)
    .useValue(NOOP_AUDIT)
    .overrideProvider(RateLimiter)
    .useValue(new RateLimiter(rlRedis))
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true, logger: false });
  app.useGlobalInterceptors(
    new RequestIdInterceptor(),
    new LoggingInterceptor(createLogger({ service: "rt1112-test", level: "info", destination: { write: (m) => void logLines.push(m) } })),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
}, 240_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  if (!env) return;
  await env.admin.query(`DELETE FROM cashier_admissions`);
  await admission(DEVICE, CASHIER);
  await admission(DEVICE_2, CASHIER_2);
  await admission(DEVICE_S2, CASHIER, TENANT, STORE_2);
  await admission(DEVICE_RL, CASHIER_RL);
  await admission(DEVICE_B, CASHIER_B, TENANT_B, STORE_B);
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe("credentials (RT-1110)", () => {
  it("is the generic 401 for no, an unknown or a revoked device token, on all three operations", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    for (const bearer of [null, "not-a-device-token", TOKEN_REVOKED]) {
      expect((await validate(bearer, validateBody(v.typed))).status).toBe(401);
      expect((await redeem(bearer, { operatorUserId: CASHIER, redemption_intent_token: "x".repeat(43), payment_attempt_id: randomUUID() })).status).toBe(401);
      expect((await reverse(bearer, { redemption_id: randomUUID() })).status).toBe(401);
    }
  });

  it("refuses a claim without a cashier admission of THIS device live now with the generic 403, before any lookup", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const before = rlRedis.count(`rl:posVoucherLookupFailure:${DEVICE_NOADM}`);
    // No admission on this device; CASHIER_2 is admitted on DEVICE_2 only; an unknown code reveals nothing either.
    for (const [bearer, user, code] of [
      [TOKEN_NOADM, CASHIER, v.typed],
      [TOKEN, CASHIER_2, v.typed],
      [TOKEN_NOADM, CASHIER, "UNKNOWN-CODE-0000"],
    ] as const) {
      const res = await validate(bearer, validateBody(code, { operatorUserId: user }));
      expectError(res, 403, "refused");
    }
    expect(rlRedis.count(`rl:posVoucherLookupFailure:${DEVICE_NOADM}`)).toBe(before);
    await E().admin.query(`UPDATE cashier_admissions SET ended_at = now(), end_reason = 'device_end' WHERE device_id = $1`, [DEVICE]);
    expectError(await validate(TOKEN, validateBody(v.typed)), 403, "refused");
    expect(await voucherStatus(v.id)).toBe("active");
  });

  it("is 400 validation_failure for a malformed body from an authenticated device", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    for (const body of [
      validateBody(v.typed, { applied_amount_minor: 0 }),
      validateBody(v.typed, { tenant_id: TENANT_B }),
      validateBody(v.typed, { remaining_balance_minor: Number.MAX_SAFE_INTEGER + 2 }),
    ]) {
      expectError(await validate(TOKEN, body), 400, "validation_failure");
    }
  });

  it("requires the Idempotency-Key on all three operations", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    expectError(await validate(TOKEN, validateBody(v.typed), null), 400, "idempotency_key_required");
    expectError(await reverse(TOKEN, { redemption_id: randomUUID() }, null), 400, "idempotency_key_required");
  });
});

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

describe("posValidateVoucher", () => {
  it("issues a short-lived intent bound to the attempt; stores only the token hash; returns the forfeit", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const body = validateBody(v.typed, { applied_amount_minor: 600, remaining_balance_minor: 5000 });
    const res = await validate(TOKEN, body);
    expect(res.status).toBe(200);
    conforms("PosValidateVoucherResponse", res.body);
    expect(res.body).toMatchObject({ kind: "validated", applied_amount_minor: 600, forfeited_amount_minor: VALUE - 600 });
    const token = (res.body as { redemption_intent_token: string }).redemption_intent_token;
    const r = await E().admin.query(
      `SELECT store_id::text, voucher_id::text, payment_attempt_id::text, applied_amount_minor::int, forfeited_amount_minor::int,
              operator_user_id::text, device_id::text, token_hash, consumed_at,
              extract(epoch FROM expires_at - created_at)::int AS ttl
         FROM voucher_redemption_intents WHERE voucher_id = $1`,
      [v.id],
    );
    expect(r.rows).toEqual([
      {
        store_id: STORE,
        voucher_id: v.id,
        payment_attempt_id: body.payment_attempt_id,
        applied_amount_minor: 600,
        forfeited_amount_minor: VALUE - 600,
        operator_user_id: CASHIER,
        device_id: DEVICE,
        token_hash: hashToken(token),
        consumed_at: null,
        ttl: INTENT_TTL_SECONDS,
      },
    ]);
    expect(Date.parse((res.body as { intent_expires_at: string }).intent_expires_at)).toBeGreaterThan(Date.now());
    expect(await voucherStatus(v.id)).toBe("active");
  });

  it("refuses over-application above the voucher value or the remaining balance (no intent written)", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    expectError(await validate(TOKEN, validateBody(v.typed, { applied_amount_minor: VALUE + 1, remaining_balance_minor: 5000 })), 400, "non_cash_overpayment_refused");
    expectError(await validate(TOKEN, validateBody(v.typed, { applied_amount_minor: 500, remaining_balance_minor: 499 })), 400, "non_cash_overpayment_refused");
    const r = await E().admin.query(`SELECT count(*)::int AS n FROM voucher_redemption_intents WHERE voucher_id = $1`, [v.id]);
    expect(r.rows[0].n).toBe(0);
    // The full value is fine: nothing forfeited.
    const full = await validate(TOKEN, validateBody(v.typed, { applied_amount_minor: VALUE }));
    expect(full.body).toMatchObject({ forfeited_amount_minor: 0 });
  });

  it("refuses a cancelled, a redeemed and an expired voucher (expired: stored active, expires_at passed)", async () => {
    if (skip()) return;
    expectError(await validate(TOKEN, validateBody((await seedVoucher({ status: "cancelled" })).typed)), 400, "voucher_cancelled");
    expectError(await validate(TOKEN, validateBody((await seedVoucher({ status: "redeemed" })).typed)), 400, "voucher_already_redeemed");
    expectError(await validate(TOKEN, validateBody((await seedVoucher({ expiresAt: inSeconds(-60) })).typed)), 400, "voucher_expired");
  });

  it("D4: an all-stores voucher validates in a store created after it; a subset voucher only in its stores", async () => {
    if (skip()) return;
    const all = await seedVoucher({ allStores: true });
    const subset = await seedVoucher({ allStores: false, stores: [STORE] });
    const late = id("000a9");
    const lateDevice = id("000e9");
    const lateToken = "rt1112-device-token-late-store";
    await E().admin.query(`INSERT INTO stores (id, tenant_id, code, name, timezone) VALUES ($1, $2, 'SL', 'Late', 'Africa/Cairo')`, [late, TENANT]);
    await E().admin.query(`INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, 'late', $4)`, [
      lateDevice,
      TENANT,
      late,
      hashToken(lateToken),
    ]);
    await admission(lateDevice, CASHIER, TENANT, late);
    expect((await validate(lateToken, validateBody(all.typed))).status).toBe(200);
    expectError(await validate(lateToken, validateBody(subset.typed)), 400, "voucher_branch_mismatch");
    expectError(await validate(TOKEN_S2, validateBody(subset.typed)), 400, "voucher_branch_mismatch");
    expect((await validate(TOKEN, validateBody(subset.typed))).status).toBe(200);
  });

  it("answers an unknown code and another tenant's code with the identical non-disclosing 404", async () => {
    if (skip()) return;
    const other = await seedVoucher({ tenant: TENANT_B });
    const unknown = await validate(TOKEN, validateBody("ZZZZ-ZZZZ-ZZZZ-ZZZZ"));
    const crossTenant = await validate(TOKEN, validateBody(other.typed));
    expectError(unknown, 404, "voucher_not_found");
    expectError(crossTenant, 404, "voucher_not_found");
    const strip = (b: { error: { request_id?: unknown } }) => ({ ...b.error, request_id: undefined });
    expect(strip(crossTenant.body)).toEqual(strip(unknown.body));
    // The other tenant's own device finds it.
    expect((await validate(TOKEN_B, validateBody(other.typed, { operatorUserId: CASHIER_B }))).status).toBe(200);
  });

  it("replays the same key + same body (same token, Idempotent-Replayed) and refuses the same key + another body with 409", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const k = key();
    const body = validateBody(v.typed);
    const first = await validate(TOKEN, body, k);
    const again = await validate(TOKEN, body, k);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body).toEqual(first.body);
    expectError(await validate(TOKEN, { ...body, applied_amount_minor: 1 }, k), 409, "idempotency_key_conflict");
    const r = await E().admin.query(`SELECT count(*)::int AS n FROM voucher_redemption_intents WHERE voucher_id = $1`, [v.id]);
    expect(r.rows[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------

describe("posRedeemVoucher", () => {
  it("consumes the whole voucher once, copying the intent's binding columns; the token is single use", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const intent = await validateOk(v.typed, TOKEN, { applied_amount_minor: 700 });
    // Another till of the same store, another cashier, may redeem it (c16559).
    const redemptionId = await redeemOk(intent, TOKEN_2, CASHIER_2);
    expect(await voucherStatus(v.id)).toBe("redeemed");
    const r = await E().admin.query(
      `SELECT r.store_id::text, r.voucher_id::text, r.payment_attempt_id::text, r.applied_amount_minor::int,
              r.forfeited_amount_minor::int, r.operator_user_id::text, r.device_id::text, r.reversed_at,
              i.consumed_at IS NOT NULL AS consumed
         FROM voucher_redemptions r JOIN voucher_redemption_intents i ON i.id = r.intent_id
        WHERE r.id = $1`,
      [redemptionId],
    );
    expect(r.rows).toEqual([
      {
        store_id: STORE,
        voucher_id: v.id,
        payment_attempt_id: intent.attempt,
        applied_amount_minor: 700,
        forfeited_amount_minor: VALUE - 700,
        operator_user_id: CASHIER_2,
        device_id: DEVICE_2,
        reversed_at: null,
        consumed: true,
      },
    ]);
    // Single use: the same token under a new key is the 404.
    expectError(
      await redeem(TOKEN, { operatorUserId: CASHIER, redemption_intent_token: intent.token, payment_attempt_id: intent.attempt }),
      404,
      "intent_token_not_found",
    );
  });

  it("refuses a wrong payment attempt, an expired intent, an unknown token, another store's and another tenant's token", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const intent = await validateOk(v.typed);
    expectError(
      await redeem(TOKEN, { operatorUserId: CASHIER, redemption_intent_token: intent.token, payment_attempt_id: randomUUID() }),
      400,
      "intent_token_payment_attempt_mismatch",
    );
    const body = { redemption_intent_token: intent.token, payment_attempt_id: intent.attempt };
    expectError(await redeem(TOKEN_S2, { operatorUserId: CASHIER, ...body }), 404, "intent_token_not_found");
    expectError(await redeem(TOKEN_B, { operatorUserId: CASHIER_B, ...body }), 404, "intent_token_not_found");
    expectError(
      await redeem(TOKEN, { operatorUserId: CASHIER, redemption_intent_token: "u".repeat(43), payment_attempt_id: intent.attempt }),
      404,
      "intent_token_not_found",
    );
    await E().admin.query(
      `UPDATE voucher_redemption_intents SET created_at = now() - interval '10 minutes', expires_at = now() - interval '6 minutes'
        WHERE token_hash = $1`,
      [hashToken(intent.token)],
    );
    expectError(await redeem(TOKEN, { operatorUserId: CASHIER, ...body }), 400, "intent_token_expired");
    expect(await voucherStatus(v.id)).toBe("active");
  });

  it("a validate before expiry followed by a redeem after it is voucher_expired, and the voucher is unchanged", async () => {
    if (skip()) return;
    const v = await seedVoucher({ expiresAt: inSeconds(2) });
    const intent = await validateOk(v.typed);
    await new Promise((r) => setTimeout(r, 2_500));
    expectError(
      await redeem(TOKEN, { operatorUserId: CASHIER, redemption_intent_token: intent.token, payment_attempt_id: intent.attempt }),
      409,
      "voucher_expired",
    );
    expect(await voucherStatus(v.id)).toBe("active");
    const r = await E().admin.query(
      `SELECT (SELECT count(*)::int FROM voucher_redemptions WHERE voucher_id = $1) AS redemptions,
              (SELECT count(*)::int FROM voucher_redemption_intents WHERE voucher_id = $1 AND consumed_at IS NOT NULL) AS consumed`,
      [v.id],
    );
    expect(r.rows[0]).toEqual({ redemptions: 0, consumed: 0 });
  });

  it("a redeem that waits on the voucher row lock past expiry is voucher_expired once the lock is granted", async () => {
    if (skip()) return;
    const v = await seedVoucher({ expiresAt: inSeconds(3) });
    const intent = await validateOk(v.typed);
    const holder = await E().admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM vouchers WHERE id = $1 FOR UPDATE`, [v.id]);
      const pending = redeem(TOKEN, { operatorUserId: CASHIER, redemption_intent_token: intent.token, payment_attempt_id: intent.attempt }).then(
        (res) => ({ res, at: Date.now() }),
      );
      await new Promise((r) => setTimeout(r, 4_000));
      const releasedAt = Date.now();
      await holder.query("COMMIT");
      const { res, at } = await pending;
      expect(at).toBeGreaterThanOrEqual(releasedAt);
      expectError(res, 409, "voucher_expired");
    } finally {
      holder.release();
    }
    expect(await voucherStatus(v.id)).toBe("active");
  });

  it("of two concurrent redeems of one voucher, exactly one wins", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const a = await validateOk(v.typed, TOKEN);
    const b = await validateOk(v.typed, TOKEN_2, { operatorUserId: CASHIER_2 });
    const [ra, rb] = await Promise.all([
      redeem(TOKEN, { operatorUserId: CASHIER, redemption_intent_token: a.token, payment_attempt_id: a.attempt }),
      redeem(TOKEN_2, { operatorUserId: CASHIER_2, redemption_intent_token: b.token, payment_attempt_id: b.attempt }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expectError(ra.status === 409 ? ra : rb, 409, "voucher_already_redeemed");
    const r = await E().admin.query(`SELECT count(*)::int AS n FROM voucher_redemptions WHERE voucher_id = $1`, [v.id]);
    expect(r.rows[0].n).toBe(1);
    expect(await voucherStatus(v.id)).toBe("redeemed");
  });

  it("a cancel racing a redeem: exactly one wins and the final status is one of them", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const intent = await validateOk(v.typed);
    // The Console cancel's own conditional write (vouchers-admin CANCEL_SQL): status-guarded, under the row lock.
    const cancel = E().admin.query(
      `UPDATE vouchers SET status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $2
        WHERE id = $1 AND status = 'active' RETURNING id`,
      [v.id, ISSUER],
    );
    const redeemed = redeem(TOKEN, { operatorUserId: CASHIER, redemption_intent_token: intent.token, payment_attempt_id: intent.attempt });
    const [c, res] = await Promise.all([cancel, redeemed]);
    const status = await voucherStatus(v.id);
    if (c.rowCount === 1) {
      expect(status).toBe("cancelled");
      expectError(res, 409, "voucher_cancelled");
    } else {
      expect(status).toBe("redeemed");
      expect(res.status).toBe(200);
    }
  });

  it("refuses a voucher cancelled after validate with voucher_cancelled", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const intent = await validateOk(v.typed);
    await E().admin.query(`UPDATE vouchers SET status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $2 WHERE id = $1`, [v.id, ISSUER]);
    expectError(
      await redeem(TOKEN, { operatorUserId: CASHIER, redemption_intent_token: intent.token, payment_attempt_id: intent.attempt }),
      409,
      "voucher_cancelled",
    );
  });

  it("replays the same key + same body with idempotent_replayed: true, even after the cashier signed out (decision 1)", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const intent = await validateOk(v.typed);
    const k = key();
    const body = { operatorUserId: CASHIER, redemption_intent_token: intent.token, payment_attempt_id: intent.attempt };
    const first = await redeem(TOKEN, body, k);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ idempotent_replayed: false });
    await E().admin.query(`UPDATE cashier_admissions SET ended_at = now(), end_reason = 'device_end' WHERE device_id = $1`, [DEVICE]);
    const again = await redeem(TOKEN, body, k);
    expect(again.status).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    conforms("PosRedeemVoucherResponse", again.body);
    expect(again.body).toEqual({ ...first.body, idempotent_replayed: true });
    // The admission is still checked first for anything that is not a stored success.
    expectError(await redeem(TOKEN, { ...body, payment_attempt_id: randomUUID() }, k), 403, "refused");
    expectError(await redeem(TOKEN, body), 403, "refused");
    // Another device never gets this device's replay.
    expectError(await redeem(TOKEN_2, { ...body, operatorUserId: CASHIER_2 }, k), 404, "intent_token_not_found");
  });

  it("refuses the same key + another body with 409 while the cashier is admitted", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const intent = await validateOk(v.typed);
    const k = key();
    const body = { operatorUserId: CASHIER, redemption_intent_token: intent.token, payment_attempt_id: intent.attempt };
    expect((await redeem(TOKEN, body, k)).status).toBe(200);
    expectError(await redeem(TOKEN, { ...body, payment_attempt_id: randomUUID() }, k), 409, "idempotency_key_conflict");
  });
});

// ---------------------------------------------------------------------------
// Reverse
// ---------------------------------------------------------------------------

describe("posReverseVoucher", () => {
  it("restores the voucher; same store any device; records the device; attributed to the redeem-time cashier", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const redemptionId = await redeemOk(await validateOk(v.typed));
    const res = await reverse(TOKEN_2, { redemption_id: redemptionId });
    expect(res.status).toBe(200);
    conforms("PosReverseVoucherResponse", res.body);
    expect(res.body).toMatchObject({ kind: "reversed", redemption_id: redemptionId, already_reversed: false });
    expect(await voucherStatus(v.id)).toBe("active");
    const r = await E().admin.query(`SELECT reversed_by_device_id::text AS d, reversed_at FROM voucher_redemptions WHERE id = $1`, [redemptionId]);
    expect(r.rows[0].d).toBe(DEVICE_2);
    expect(new Date(r.rows[0].reversed_at).toISOString()).toBe((res.body as { reversed_at: string }).reversed_at);
    const audits = (await auditRows("voucher.reversed")).filter((a) => a.metadata["redemption_id"] === redemptionId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: CASHIER, store_id: STORE, target_id: v.id });
    expect(audits[0]!.metadata).toMatchObject({ reversed_by_device_id: DEVICE_2 });
    // The restored voucher validates again with its full value.
    expect((await validate(TOKEN, validateBody(v.typed, { applied_amount_minor: VALUE }))).body).toMatchObject({ forfeited_amount_minor: 0 });
  });

  it("twice keeps the original reversed_at with already_reversed: true; a same-key replay says already_reversed too", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const redemptionId = await redeemOk(await validateOk(v.typed));
    const k = key();
    const first = await reverse(TOKEN, { redemption_id: redemptionId }, k);
    const second = await reverse(TOKEN, { redemption_id: redemptionId });
    const replay = await reverse(TOKEN, { redemption_id: redemptionId }, k);
    expect(second.body).toEqual({ ...first.body, already_reversed: true });
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual({ ...first.body, already_reversed: true });
    expect(await auditRows("voucher.reversed").then((rows) => rows.filter((a) => a.metadata["redemption_id"] === redemptionId))).toHaveLength(1);
  });

  it("refuses another store with redemption_branch_mismatch, and another tenant or an unknown id with the same 404", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const redemptionId = await redeemOk(await validateOk(v.typed));
    expectError(await reverse(TOKEN_S2, { redemption_id: redemptionId }), 400, "redemption_branch_mismatch");
    expectError(await reverse(TOKEN_B, { redemption_id: redemptionId }), 404, "redemption_not_found");
    expectError(await reverse(TOKEN, { redemption_id: randomUUID() }), 404, "redemption_not_found");
    expect(await voucherStatus(v.id)).toBe("redeemed");
  });

  it("reverses a voucher that expired since it was redeemed; it is active again and still answers voucher_expired (decision 2)", async () => {
    if (skip()) return;
    const v = await seedVoucher({ expiresAt: inSeconds(600) });
    const redemptionId = await redeemOk(await validateOk(v.typed));
    await E().admin.query(`UPDATE vouchers SET expires_at = now() - interval '1 minute' WHERE id = $1`, [v.id]);
    const res = await reverse(TOKEN, { redemption_id: redemptionId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ already_reversed: false });
    expect(await voucherStatus(v.id)).toBe("active");
    expectError(await validate(TOKEN, validateBody(v.typed)), 400, "voucher_expired");
  });
});

// ---------------------------------------------------------------------------
// Failed-lookup rate limit (decision 3)
// ---------------------------------------------------------------------------

describe("failed-lookup rate limit (ADR 0009)", () => {
  it("allows 10 failed lookups per device, then 429 RATE_LIMITED with Retry-After; found codes give their hit back", async () => {
    if (skip()) return;
    const found = await seedVoucher();
    const rl = (code: string) => validateBody(code, { operatorUserId: CASHIER_RL });
    for (let i = 0; i < 10; i += 1) {
      // A found code never spends the budget (its hit is given back); it runs
      // first, because a lookup over budget is refused whatever it would find.
      expect((await validate(TOKEN_RL, rl(found.typed))).status).toBe(200);
      expectError(await validate(TOKEN_RL, rl(`MISS-${String(i).padStart(12, "0")}`)), 404, "voucher_not_found");
    }
    const limited = await validate(TOKEN_RL, rl("MISS-LAST-00000000"));
    expectError(limited, 429, "RATE_LIMITED");
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(300);
    // Over budget, even a code that exists is not looked up.
    expectError(await validate(TOKEN_RL, rl(found.typed)), 429, "RATE_LIMITED");
    // The budget is the device's: another till still looks codes up.
    expect((await validate(TOKEN, validateBody(found.typed))).status).toBe(200);
    // Redeem's failed token lookups share it.
    expectError(
      await redeem(TOKEN_RL, { operatorUserId: CASHIER_RL, redemption_intent_token: "m".repeat(43), payment_attempt_id: randomUUID() }),
      429,
      "RATE_LIMITED",
    );
  });
});

// ---------------------------------------------------------------------------
// Secrecy
// ---------------------------------------------------------------------------

describe("secrecy (RT-810 section 6, RT-922 section 7)", () => {
  it("writes no code or token into logs or audit rows, no forfeited amount into audit, and no code into idempotency storage", async () => {
    if (skip()) return;
    const v = await seedVoucher();
    const k = key();
    const res = await validate(TOKEN, validateBody(v.typed, { applied_amount_minor: 650 }), k);
    const token = (res.body as { redemption_intent_token: string }).redemption_intent_token;
    const attempt = (await E().admin.query(`SELECT payment_attempt_id::text AS p FROM voucher_redemption_intents WHERE token_hash = $1`, [hashToken(token)])).rows[0].p;
    const redemptionId = await redeemOk({ token, attempt });
    await reverse(TOKEN, { redemption_id: redemptionId });

    const audits = await E().admin.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY occurred_at`,
      [v.id],
    );
    expect(audits.rows.map((a) => a.action)).toEqual(["voucher.validated", "voucher.redeemed", "voucher.reversed"]);
    const allowed = ["voucher_id", "intent_id", "redemption_id", "payment_attempt_id", "applied_amount_minor", "device_id", "reversed_by_device_id"];
    for (const a of audits.rows) {
      for (const field of Object.keys(a.metadata)) expect(allowed).toContain(field);
    }
    const haystacks = {
      audit: JSON.stringify(audits.rows),
      logs: logLines.join("\n"),
    };
    for (const [where, text] of Object.entries(haystacks)) {
      expect({ where, code: text.includes(v.code) }).toEqual({ where, code: false });
      expect({ where, typed: text.toUpperCase().includes(v.typed.toUpperCase()) }).toEqual({ where, typed: false });
      expect({ where, token: text.includes(token) }).toEqual({ where, token: false });
      expect({ where, forfeited: text.includes("forfeited") }).toEqual({ where, forfeited: false });
    }
    // Idempotency storage: never the code (only the body hash). The validate 200
    // itself, token included, is the one accepted exception (its replay, for the
    // intent's lifetime; vouchers-pos.service.ts header).
    const stored = await E().admin.query(
      `SELECT response_body::text AS b, expires_at - created_at <= interval '241 seconds' AS short FROM idempotency_keys WHERE key LIKE $1`,
      [`%${k}`],
    );
    expect(stored.rows.length).toBeGreaterThan(0);
    for (const row of stored.rows) {
      expect(String(row.b).toUpperCase()).not.toContain(v.code);
      expect(row.short).toBe(true);
    }
  });
});
