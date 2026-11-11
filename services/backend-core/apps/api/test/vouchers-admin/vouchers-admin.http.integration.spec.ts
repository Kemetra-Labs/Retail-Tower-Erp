/**
 * RT-1108 — the Console voucher issuance routes over HTTP against real
 * Postgres (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool
 * whose UPDATE on `vouchers` is narrowed to the production columns) and the
 * real module graph. Only cookie authentication is faked (a header names the
 * session). Contract: `vouchers-admin.openapi.yaml`; cases: RT-922 section 7.
 *
 * What this proves:
 *   - authz: owner / tenant_admin only (store_manager and staff are 403), 401
 *     without a session;
 *   - issue: server-generated codes returned once with `no-store`, stored as
 *     `hashToken(normalised code)`, one batch id, eligibility rows only for a
 *     subset; a store of another tenant, an absent or a soft-deleted store is
 *     404 `store_not_found`, an inactive one 409 `store_inactive`; DTO bounds;
 *     a same-key retry is 409 `idempotency_key_conflict` and still one batch;
 *   - secrecy: no code in audit rows, list or get bodies, or idempotency
 *     storage;
 *   - list / get: tenant-scoped, newest first, keyset walk, the filters, the
 *     effective status `expired` derived at read time;
 *   - cancel: conditional, once; a second cancel is `already_cancelled`, an
 *     expired voucher is cancellable, a redeemed one is 409, a race has one
 *     winner; the domain role cannot UPDATE any other column.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import request from "supertest";

import { hashToken } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";

import { LoggingInterceptor } from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import * as voucherAudit from "../../src/vouchers-admin/vouchers-admin-audit";
import { VouchersAdminModule } from "../../src/vouchers-admin/vouchers-admin.module";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import { bootScopedApp } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  recordingIdempotencyProviders,
  SES_ADMIN_X,
  SES_MANAGER,
  SES_OWNER_ALL,
  SES_OWNER_B,
  SES_STAFF,
  seedPayerMembers,
  voucherContractChecker,
  type IdempotencyRecorder,
} from "./__support__/vouchers-http-harness";

const URL = "/api/v1/vouchers";
const S_INACTIVE = "0a000000-0000-7000-8000-0000011081a1";
const S_DELETED = "0a000000-0000-7000-8000-0000011081a2";
const ABSENT = "0a000000-0000-7000-8000-0000011081ff";
// Seeded vouchers (tenant A unless noted). Newest first is created_at DESC.
const V_EXPIRED = "0a000000-0000-7000-8000-0000011082a1";
const V_REDEEMED = "0a000000-0000-7000-8000-0000011082a2";
const V_B = "0b000000-0000-7000-8000-0000011082b1";
const BATCH_SEED = "0a000000-0000-7000-8000-0000011083a1";
const CODE_FORMAT = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

const conforms = voucherContractChecker();

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let recorder: IdempotencyRecorder | null = null;
let skipped = false;
const logLines: string[] = [];
let tenantACurrency = "";

async function seed(e: PgTestEnv): Promise<void> {
  await seedPayerMembers(e);
  await e.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name, is_active, deleted_at) VALUES
       ($1, $3, 'AI', 'RT1108 inactive', false, NULL),
       ($2, $3, 'AD', 'RT1108 deleted',  true,  now())`,
    [S_INACTIVE, S_DELETED, TENANT_A],
  );
  const hash = (n: string): Buffer => hashToken(`SEEDED${n}`);
  await e.admin.query(
    `INSERT INTO vouchers
       (id, tenant_id, batch_id, code_hash, amount_minor, currency_code, status, expires_at, applies_to_all_stores, issued_by_user_id, created_at)
     VALUES
       ($1, $4, $6, $7, 1000, 'USD', 'active',   now() - interval '1 day', true, $9, now() - interval '2 days'),
       ($2, $4, $6, $8, 2000, 'USD', 'redeemed', NULL,                     true, $9, now() - interval '3 days'),
       ($3, $5, $6, $10, 3000, 'USD', 'active',  NULL,                     true, $9, now() - interval '2 days')`,
    [V_EXPIRED, V_REDEEMED, V_B, TENANT_A, TENANT_B, BATCH_SEED, hash("1"), hash("2"), "0a000000-0000-7000-8000-0000004184a1", hash("3")],
  );
  const c = await e.admin.query<{ default_currency_code: string }>(`SELECT default_currency_code FROM tenants WHERE id = $1`, [TENANT_A]);
  tenantACurrency = c.rows[0]!.default_currency_code;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seed(env);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw new Error(`Container start failed: ${reason}`);
    skipped = true;
    return;
  }
  const idem = recordingIdempotencyProviders();
  recorder = idem.recorder;
  app = await bootScopedApp(env, VouchersAdminModule, undefined, {
    // Bearer tokens resolve on the RLS-exempt pool, as the production auth-lookup role does.
    authLookupPool: env.admin,
    providers: idem.providers,
    // The app's real request logger (main.ts), captured in memory.
    beforeInit: (a) =>
      a.useGlobalInterceptors(
        new RequestIdInterceptor(),
        new LoggingInterceptor(createLogger({ service: "rt1108-test", level: "info", destination: { write: (m) => void logLines.push(m) } })),
      ),
  });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

const server = () => app!.getHttpServer() as Parameters<typeof request>[0];
const asSession = (req: request.Test, session: string | null) => (session === null ? req : req.set("x-test-session", session));
let keySeq = 0;
const freshKey = (): string => `rt1108-voucher-key-${(keySeq += 1).toString().padStart(8, "0")}`;
const skip = (): boolean => skipped;

function issue(session: string | null, body: object, key: string | null = freshKey()): request.Test {
  const req = asSession(request(server()).post(URL).set("Origin", "http://127.0.0.1").send(body), session);
  return key === null ? req : req.set("Idempotency-Key", key);
}
function cancel(session: string | null, id: string, key: string | null = freshKey()): request.Test {
  const req = asSession(request(server()).post(`${URL}/${id}/cancel`).set("Origin", "http://127.0.0.1"), session);
  return key === null ? req : req.set("Idempotency-Key", key);
}
const list = (session: string | null, query: Record<string, string | number> = {}): request.Test =>
  asSession(request(server()).get(URL).query(query), session);
const get = (session: string | null, id: string): request.Test => asSession(request(server()).get(`${URL}/${id}`), session);

interface IssuedBody {
  batch_id: string;
  vouchers: Array<{ voucher_id: string; code: string; amount_minor: number; currency_code: string; expires_at: string | null }>;
}

async function issueOk(body: object, session = SES_OWNER_ALL): Promise<IssuedBody> {
  const res = await issue(session, body);
  expect([res.status, res.body]).toEqual([201, expect.anything()]);
  return res.body as IssuedBody;
}

function expectError(res: request.Response, status: number, code: string, schema = "VoucherAdminError"): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  conforms(schema, res.body);
}

async function voucherCount(tenantId = TENANT_A): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM vouchers WHERE tenant_id = $1`, [tenantId]);
  return Number(r.rows[0]!.n);
}

async function auditRows(action: string, targetId: string): Promise<Array<Record<string, unknown>>> {
  const r = await env!.admin.query<Record<string, unknown>>(
    `SELECT * FROM audit_events WHERE action = $1 AND target_id = $2`,
    [action, targetId],
  );
  return r.rows;
}

const ALL = { count: 3, amount_minor: 5000, applies_to_all_stores: true };

describe("authz", () => {
  it("is 401 without a session", async () => {
    if (skip()) return;
    expect((await issue(null, ALL)).status).toBe(401);
    expect((await list(null)).status).toBe(401);
    expect((await get(null, V_EXPIRED)).status).toBe(401);
    expect((await cancel(null, V_EXPIRED)).status).toBe(401);
  });

  it.each([
    ["store_manager", SES_MANAGER],
    ["store_staff", SES_STAFF],
  ])("refuses %s with 403 on all four operations and writes nothing", async (_role, session) => {
    if (skip()) return;
    const before = await voucherCount();
    for (const res of [await issue(session, ALL), await list(session), await get(session, V_EXPIRED), await cancel(session, V_EXPIRED)]) {
      expect(res.status).toBe(403);
      expect((res.body as { error: { code: string } }).error.code).toBe("forbidden");
      conforms("Error", res.body);
    }
    expect(await voucherCount()).toBe(before);
  });

  it("answers a bearer with 401 and a cookie POST without a trusted Origin with 403 origin_rejected, on both POSTs", async () => {
    if (skip()) return;
    const before = await voucherCount();
    const bearer = await request(server()).post(URL).set("Authorization", "Bearer not-a-real-token").set("Idempotency-Key", freshKey()).send(ALL);
    expect(bearer.status).toBe(401);
    const cookie = "dp2_session=rt1108-not-a-session";
    const posts = [
      () => request(server()).post(URL).set("Cookie", cookie).set("Idempotency-Key", freshKey()).send(ALL),
      () => request(server()).post(`${URL}/${V_EXPIRED}/cancel`).set("Cookie", cookie).set("Idempotency-Key", freshKey()),
    ];
    for (const post of posts) {
      const none = await post();
      expectError(none, 403, "origin_rejected", "Error");
      const foreign = await post().set("Origin", "https://evil.example");
      expectError(foreign, 403, "origin_rejected", "Error");
    }
    expect(await voucherCount()).toBe(before);
    const row = await env!.admin.query<{ status: string }>(`SELECT status FROM vouchers WHERE id = $1`, [V_EXPIRED]);
    expect(row.rows[0]!.status).toBe("active");
  });
});

// RT-131 / RT-1108 review: the role never widens a membership. SES_ADMIN_X is a tenant_admin whose
// membership is `specific`, granted STORE_A_X only.
describe("store scope of a specific tenant_admin", () => {
  it("cannot issue an all-stores batch (403 forbidden); a tenant-wide owner can", async () => {
    if (skip()) return;
    const before = await voucherCount();
    expectError(await issue(SES_ADMIN_X, { ...ALL, count: 1 }), 403, "forbidden", "Error");
    expect(await voucherCount()).toBe(before);
    expect((await issue(SES_OWNER_ALL, { ...ALL, count: 1 })).status).toBe(201);
  });

  it("issues for a store in scope, and gets the non-disclosing 404 store_not_found for any store out of scope", async () => {
    if (skip()) return;
    const ok = await issue(SES_ADMIN_X, { count: 1, amount_minor: 100, applies_to_all_stores: false, eligible_store_ids: [STORE_A_X] });
    expect(ok.status).toBe(201);
    const before = await voucherCount();
    for (const stores of [[STORE_A_Y], [STORE_A_X, STORE_A_Y]]) {
      expectError(
        await issue(SES_ADMIN_X, { count: 1, amount_minor: 100, applies_to_all_stores: false, eligible_store_ids: stores }),
        404,
        "store_not_found",
      );
    }
    expect(await voucherCount()).toBe(before);
  });

  it("lists, gets and cancels only vouchers whose eligible stores are all in scope; the rest are voucher_not_found", async () => {
    if (skip()) return;
    const mk = async (stores: string[] | "all"): Promise<string> =>
      (await issueOk(stores === "all" ? { ...ALL, count: 1 } : { count: 1, amount_minor: 10, applies_to_all_stores: false, eligible_store_ids: stores })).vouchers[0]!.voucher_id;
    const inScope = await mk([STORE_A_X]);
    const allStores = await mk("all");
    const mixed = await mk([STORE_A_X, STORE_A_Y]);
    const other = await mk([STORE_A_Y]);

    const ids = async (session: string): Promise<string[]> => {
      const out: string[] = [];
      let cursor: string | undefined;
      do {
        const res = await list(session, { page_size: 2, ...(cursor ? { cursor } : {}) });
        expect(res.status).toBe(200);
        out.push(...(res.body as { items: Array<{ voucher_id: string }> }).items.map((v) => v.voucher_id));
        cursor = (res.body as { next_cursor: string | null }).next_cursor ?? undefined;
      } while (cursor);
      return out;
    };
    const scoped = await ids(SES_ADMIN_X);
    expect(scoped).toContain(inScope);
    for (const hidden of [allStores, mixed, other, V_EXPIRED, V_REDEEMED]) expect(scoped).not.toContain(hidden);
    expect(new Set(scoped).size).toBe(scoped.length);

    // A tenant-wide member still sees everything.
    const all = await ids(SES_OWNER_ALL);
    for (const id of [inScope, allStores, mixed, other]) expect(all).toContain(id);

    expect((await get(SES_ADMIN_X, inScope)).status).toBe(200);
    for (const hidden of [allStores, mixed, other, V_EXPIRED, V_REDEEMED]) {
      expectError(await get(SES_ADMIN_X, hidden), 404, "voucher_not_found");
      expectError(await cancel(SES_ADMIN_X, hidden), 404, "voucher_not_found");
    }
    expect((await get(SES_OWNER_ALL, allStores)).status).toBe(200);
    // The refused cancels changed nothing.
    const rows = await env!.admin.query<{ id: string; status: string }>(`SELECT id::text, status FROM vouchers WHERE id = ANY($1::uuid[])`, [[allStores, mixed, other, V_REDEEMED]]);
    expect(rows.rows.find((r) => r.id === allStores)!.status).toBe("active");
    expect(rows.rows.find((r) => r.id === mixed)!.status).toBe("active");

    const cancelled = await cancel(SES_ADMIN_X, inScope);
    expect([cancelled.status, (cancelled.body as { already_cancelled: boolean }).already_cancelled]).toEqual([200, false]);
  });
});

describe("consoleIssueVouchers", () => {
  it("issues an all-stores batch: codes once with no-store, hashed at rest, tenant currency, one batch, no eligibility rows", async () => {
    if (skip()) return;
    const res = await issue(SES_OWNER_ALL, ALL);
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    conforms("VoucherIssueResponse", res.body);
    const issued = res.body as IssuedBody;
    expect(issued.vouchers).toHaveLength(3);
    expect(new Set(issued.vouchers.map((v) => v.code)).size).toBe(3);
    for (const v of issued.vouchers) {
      expect(v.code).toMatch(CODE_FORMAT);
      expect(v).toMatchObject({ amount_minor: 5000, currency_code: tenantACurrency, expires_at: null });
    }
    const rows = await env!.admin.query<{ id: string; code_hash: Buffer; batch_id: string; status: string; applies_to_all_stores: boolean; issued_by_user_id: string }>(
      `SELECT id::text, code_hash, batch_id::text, status, applies_to_all_stores, issued_by_user_id::text FROM vouchers WHERE batch_id = $1`,
      [issued.batch_id],
    );
    expect(rows.rows).toHaveLength(3);
    for (const v of issued.vouchers) {
      const row = rows.rows.find((r) => r.id === v.voucher_id)!;
      expect(row.code_hash.equals(hashToken(v.code.replace(/-/g, "")))).toBe(true);
      expect(row).toMatchObject({ status: "active", applies_to_all_stores: true });
    }
    const eligible = await env!.admin.query(`SELECT 1 FROM voucher_eligible_stores WHERE voucher_id = ANY($1::uuid[])`, [issued.vouchers.map((v) => v.voucher_id)]);
    expect(eligible.rows).toHaveLength(0);
  });

  it("issues a subset batch with expiry and note, and one eligibility row per voucher and store", async () => {
    if (skip()) return;
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const issued = await issueOk({ count: 2, amount_minor: 750, applies_to_all_stores: false, eligible_store_ids: [STORE_A_X, STORE_A_Y], expires_at: expiresAt, note: "spring" });
    expect(issued.vouchers.every((v) => v.expires_at === expiresAt)).toBe(true);
    const eligible = await env!.admin.query<{ voucher_id: string; store_id: string }>(
      `SELECT voucher_id::text, store_id::text FROM voucher_eligible_stores WHERE voucher_id = ANY($1::uuid[]) ORDER BY 1, 2`,
      [issued.vouchers.map((v) => v.voucher_id)],
    );
    expect(eligible.rows).toHaveLength(4);
    const row = await env!.admin.query<{ note: string; applies_to_all_stores: boolean }>(`SELECT note, applies_to_all_stores FROM vouchers WHERE id = $1`, [issued.vouchers[0]!.voucher_id]);
    expect(row.rows[0]).toEqual({ note: "spring", applies_to_all_stores: false });
  });

  it("accepts the largest amount the table CHECK allows (2^53 - 1)", async () => {
    if (skip()) return;
    const issued = await issueOk({ count: 1, amount_minor: 9_007_199_254_740_991, applies_to_all_stores: true });
    expect(issued.vouchers[0]!.amount_minor).toBe(9_007_199_254_740_991);
  });

  it("writes a voucher.issued audit row on the transaction, with no code, hash or note", async () => {
    if (skip()) return;
    const issued = await issueOk({ ...ALL, count: 2, note: "internal-note-xyz" });
    const [audit, ...rest] = await auditRows("voucher.issued", issued.batch_id);
    expect(rest).toHaveLength(0);
    expect(audit).toMatchObject({ tenant_id: TENANT_A, store_id: null, target_type: "voucher_batch", actor_user_id: expect.any(String) });
    expect(audit!["metadata"]).toMatchObject({ batch_id: issued.batch_id, count: 2, amount_minor: 5000, currency_code: tenantACurrency, applies_to_all_stores: true });
    const text = JSON.stringify(audit);
    for (const v of issued.vouchers) {
      expect(text).not.toContain(v.code);
      expect(text).not.toContain(v.code.replace(/-/g, ""));
    }
    expect(text).not.toContain("code_hash");
    expect(text).not.toContain("internal-note-xyz");
  });

  it("keeps every code out of idempotency storage (marker only) and a same-key retry is 409 with exactly one batch", async () => {
    if (skip()) return;
    const key = freshKey();
    const before = await voucherCount();
    const first = await issue(SES_OWNER_ALL, ALL, key);
    expect(first.status).toBe(201);
    const issued = first.body as IssuedBody;
    expect(await voucherCount()).toBe(before + 3);

    const retry = await issue(SES_OWNER_ALL, ALL, key);
    expectError(retry, 409, "idempotency_key_conflict");
    expect(JSON.stringify(retry.body)).not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/);
    const changed = await issue(SES_OWNER_ALL, { ...ALL, count: 4 }, key);
    expectError(changed, 409, "idempotency_key_conflict");
    expect(await voucherCount()).toBe(before + 3);

    const stored = [...recorder!.redisValues, ...recorder!.mirrorWrites].join("\n");
    expect(stored.length).toBeGreaterThan(0);
    for (const v of issued.vouchers) {
      expect(stored).not.toContain(v.code);
      expect(stored).not.toContain(v.code.replace(/-/g, ""));
    }
    expect(stored).toContain(issued.batch_id);
  });

  it("logs the request with the app's real logger and the log carries no code", async () => {
    if (skip()) return;
    logLines.length = 0;
    const issued = await issueOk(ALL);
    const logged = logLines.join("");
    expect(logged).toContain("request completed");
    expect(logged).toContain("/api/v1/vouchers");
    for (const v of issued.vouchers) {
      expect(logged).not.toContain(v.code);
      expect(logged).not.toContain(v.code.replace(/-/g, ""));
    }
  });

  it("is atomic: a failure after the batch insert leaves no voucher, eligibility row or audit row", async () => {
    if (skip()) return;
    const vouchers = await voucherCount();
    const eligible = Number((await env!.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM voucher_eligible_stores`)).rows[0]!.n);
    const audits = Number((await env!.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events WHERE action = 'voucher.issued'`)).rows[0]!.n);
    const spy = jest.spyOn(voucherAudit, "insertVoucherAudit").mockRejectedValueOnce(new Error("audit boom"));
    try {
      const res = await issue(SES_OWNER_ALL, { count: 3, amount_minor: 10, applies_to_all_stores: false, eligible_store_ids: [STORE_A_X, STORE_A_Y] });
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(await voucherCount()).toBe(vouchers);
    const after = await env!.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM voucher_eligible_stores`);
    expect(Number(after.rows[0]!.n)).toBe(eligible);
    const auditAfter = await env!.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events WHERE action = 'voucher.issued'`);
    expect(Number(auditAfter.rows[0]!.n)).toBe(audits);
  });

  it("requires a well-formed Idempotency-Key", async () => {
    if (skip()) return;
    const before = await voucherCount();
    expectError(await issue(SES_OWNER_ALL, ALL, null), 400, "idempotency_key_required");
    expectError(await issue(SES_OWNER_ALL, ALL, "short"), 400, "idempotency_key_malformed");
    expect(await voucherCount()).toBe(before);
  });

  it("refuses a store of another tenant, an absent store and a soft-deleted store with the same 404 store_not_found, and writes nothing", async () => {
    if (skip()) return;
    const before = await voucherCount();
    const bodies: unknown[] = [];
    for (const store of [STORE_B_X, ABSENT, S_DELETED]) {
      const res = await issue(SES_OWNER_ALL, { count: 1, amount_minor: 100, applies_to_all_stores: false, eligible_store_ids: [STORE_A_X, store] });
      expectError(res, 404, "store_not_found");
      bodies.push(res.body);
    }
    expect(new Set(bodies.map((b) => JSON.stringify((b as { error: { message: string } }).error.message))).size).toBe(1);
    expect(await voucherCount()).toBe(before);
  });

  it("refuses an inactive store with 409 store_inactive, and a missing store wins over an inactive one", async () => {
    if (skip()) return;
    const before = await voucherCount();
    expectError(
      await issue(SES_OWNER_ALL, { count: 1, amount_minor: 100, applies_to_all_stores: false, eligible_store_ids: [S_INACTIVE] }),
      409,
      "store_inactive",
    );
    expectError(
      await issue(SES_OWNER_ALL, { count: 1, amount_minor: 100, applies_to_all_stores: false, eligible_store_ids: [S_INACTIVE, ABSENT] }),
      404,
      "store_not_found",
    );
    expect(await voucherCount()).toBe(before);
  });

  it("answers 400 validation_failure for every refused body, writing nothing", async () => {
    if (skip()) return;
    const before = await voucherCount();
    const past = new Date(Date.now() - 60_000).toISOString();
    const bad: object[] = [
      { ...ALL, count: 0 },
      { ...ALL, count: 101 },
      { ...ALL, amount_minor: 0 },
      { ...ALL, amount_minor: 9_007_199_254_740_992 },
      { ...ALL, applies_to_all_stores: false },
      { ...ALL, applies_to_all_stores: false, eligible_store_ids: [] },
      { ...ALL, eligible_store_ids: [STORE_A_X] },
      { ...ALL, expires_at: past },
      { ...ALL, note: "x".repeat(201) },
      { ...ALL, code: "AAAA-AAAA-AAAA-AAAA" },
      { ...ALL, tenant_id: TENANT_B },
      { ...ALL, applies_to_all_stores: false, eligible_store_ids: Array.from({ length: 101 }, (_, i) => `0a000000-0000-7000-8000-${String(i).padStart(12, "0")}`) },
    ];
    for (const body of bad) expectError(await issue(SES_OWNER_ALL, body), 400, "validation_failure");
    expect(await voucherCount()).toBe(before);
  });
});

describe("consoleListVouchers and consoleGetVoucher", () => {
  it("is tenant-scoped, newest first, a keyset walk visits each voucher once, and never carries a code or hash", async () => {
    if (skip()) return;
    const issued = await issueOk({ ...ALL, count: 5 });
    const all: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await list(SES_OWNER_ALL, { page_size: 2, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      conforms("VoucherPage", res.body);
      all.push(...(res.body as { items: Array<Record<string, unknown>> }).items);
      cursor = (res.body as { next_cursor: string | null }).next_cursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 50);
    const ids = all.map((v) => v["voucher_id"]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of issued.vouchers) expect(ids).toContain(v.voucher_id);
    expect(ids).not.toContain(V_B);
    const created = all.map((v) => Date.parse(v["created_at"] as string));
    expect([...created].sort((a, b) => b - a)).toEqual(created);
    const text = JSON.stringify(all);
    expect(text).not.toContain("code_hash");
    for (const v of issued.vouchers) expect(text).not.toContain(v.code.replace(/-/g, ""));
    expect(all.every((v) => !("code" in v) && !("tenant_id" in v))).toBe(true);

    const b = await list(SES_OWNER_B);
    expect((b.body as { items: Array<{ voucher_id: string }> }).items.map((v) => v.voucher_id)).toEqual([V_B]);
  });

  it("derives the effective status: active excludes an expired voucher, expired includes it, get shows it", async () => {
    if (skip()) return;
    const active = ((await list(SES_OWNER_ALL, { status: "active", page_size: 100 })).body as { items: Array<{ voucher_id: string }> }).items;
    const expired = ((await list(SES_OWNER_ALL, { status: "expired", page_size: 100 })).body as { items: Array<{ voucher_id: string; status: string }> }).items;
    expect(active.map((v) => v.voucher_id)).not.toContain(V_EXPIRED);
    expect(expired.map((v) => v.voucher_id)).toEqual([V_EXPIRED]);
    const one = await get(SES_OWNER_ALL, V_EXPIRED);
    expect(one.status).toBe(200);
    conforms("Voucher", one.body);
    expect(one.body).toMatchObject({ voucher_id: V_EXPIRED, status: "expired", amount_minor: 1000, redemption: null, eligible_store_ids: [] });
    const redeemed = ((await list(SES_OWNER_ALL, { status: "redeemed" })).body as { items: Array<{ voucher_id: string }> }).items;
    expect(redeemed.map((v) => v.voucher_id)).toEqual([V_REDEEMED]);
  });

  it("filters by batch, eligible store and expiry window", async () => {
    if (skip()) return;
    const subset = await issueOk({ count: 2, amount_minor: 10, applies_to_all_stores: false, eligible_store_ids: [STORE_A_X], expires_at: "2099-06-01T00:00:00.000Z" });
    const ids = (res: request.Response): string[] => (res.body as { items: Array<{ voucher_id: string }> }).items.map((v) => v.voucher_id);
    expect(ids(await list(SES_OWNER_ALL, { batch_id: subset.batch_id }))).toHaveLength(2);
    expect(ids(await list(SES_OWNER_ALL, { batch_id: BATCH_SEED })).sort()).toEqual([V_EXPIRED, V_REDEEMED].sort());
    // Store X: the subset batch and every all-stores voucher; store Y: no subset voucher of the batch.
    const x = ids(await list(SES_OWNER_ALL, { eligible_store_id: STORE_A_X, page_size: 100 }));
    const y = ids(await list(SES_OWNER_ALL, { eligible_store_id: STORE_A_Y, page_size: 100 }));
    for (const v of subset.vouchers) {
      expect(x).toContain(v.voucher_id);
      expect(y).not.toContain(v.voucher_id);
    }
    expect(y).toContain(V_EXPIRED);
    // A store that is not of the tenant matches nothing (not an error).
    const foreign = await list(SES_OWNER_ALL, { eligible_store_id: STORE_B_X });
    expect([foreign.status, ids(foreign)]).toEqual([200, []]);
    // Expiry window: inclusive lower bound, exclusive upper, null never matches.
    const win = ids(await list(SES_OWNER_ALL, { expires_from: "2099-06-01T00:00:00.000Z", expires_before: "2099-06-01T00:00:00.001Z" }));
    expect(win.sort()).toEqual(subset.vouchers.map((v) => v.voucher_id).sort());
    expect(ids(await list(SES_OWNER_ALL, { expires_before: "2099-06-01T00:00:00.000Z", expires_from: "2000-01-01T00:00:00.000Z" }))).not.toContain(V_REDEEMED);
  });

  it("returns the eligible store ids of a subset voucher on get", async () => {
    if (skip()) return;
    const issued = await issueOk({ count: 1, amount_minor: 10, applies_to_all_stores: false, eligible_store_ids: [STORE_A_Y, STORE_A_X] });
    const res = await get(SES_OWNER_ALL, issued.vouchers[0]!.voucher_id);
    conforms("Voucher", res.body);
    expect(res.body).toMatchObject({ applies_to_all_stores: false, eligible_store_ids: [STORE_A_X, STORE_A_Y].sort(), status: "active" });
  });

  it("answers 400 validation_failure for a malformed filter, cursor, page_size or id", async () => {
    if (skip()) return;
    for (const query of [{ status: "pending" }, { batch_id: "x" }, { page_size: 0 }, { page_size: 101 }, { cursor: "not-a-cursor" }, { cursor: Buffer.from('{"c":"2026-02-31T00:00:00.000000","i":"0a000000-0000-7000-8000-0000011082a1"}').toString("base64url") }, { expires_from: "yesterday" }]) {
      expectError(await list(SES_OWNER_ALL, query), 400, "validation_failure");
    }
    expectError(await get(SES_OWNER_ALL, "not-a-uuid"), 400, "validation_failure");
  });

  it("answers the same 404 for another tenant's voucher and one that never existed", async () => {
    if (skip()) return;
    const other = await get(SES_OWNER_ALL, V_B);
    const absent = await get(SES_OWNER_ALL, ABSENT);
    expectError(other, 404, "voucher_not_found");
    expectError(absent, 404, "voucher_not_found");
    expect((other.body as { error: { message: string } }).error.message).toBe((absent.body as { error: { message: string } }).error.message);
  });
});

describe("consoleCancelVoucher", () => {
  it("cancels once with the audit row; a second cancel is already_cancelled with no second audit row", async () => {
    if (skip()) return;
    const issued = await issueOk({ ...ALL, count: 1 });
    const id = issued.vouchers[0]!.voucher_id;
    const first = await cancel(SES_OWNER_ALL, id);
    expect(first.status).toBe(200);
    conforms("VoucherCancelResult", first.body);
    expect(first.body).toMatchObject({ voucher_id: id, status: "cancelled", already_cancelled: false });
    const row = await env!.admin.query<{ status: string; cancelled_by_user_id: string; cancelled_at: Date }>(
      `SELECT status, cancelled_by_user_id::text, cancelled_at FROM vouchers WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]).toMatchObject({ status: "cancelled", cancelled_by_user_id: expect.any(String) });

    const second = await cancel(SES_OWNER_ALL, id);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ voucher_id: id, already_cancelled: true, cancelled_at: (first.body as { cancelled_at: string }).cancelled_at });
    const audit = await auditRows("voucher.cancelled", id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tenant_id: TENANT_A, target_type: "voucher", store_id: null });
    expect(JSON.stringify(audit[0])).not.toContain(issued.vouchers[0]!.code.replace(/-/g, ""));
    expect((await get(SES_OWNER_ALL, id)).body).toMatchObject({ status: "cancelled" });
  });

  it("replays the stored 200 on a same-key retry (Idempotent-Replayed); the store key binds voucher_id, so another voucher is its own request", async () => {
    if (skip()) return;
    const a = (await issueOk({ ...ALL, count: 2 })).vouchers;
    const key = freshKey();
    const first = await cancel(SES_OWNER_ALL, a[0]!.voucher_id, key);
    const replay = await cancel(SES_OWNER_ALL, a[0]!.voucher_id, key);
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    // Voucher A's stored response is never replayed for voucher B (store key = template + path params).
    const other = await cancel(SES_OWNER_ALL, a[1]!.voucher_id, key);
    expect(other.status).toBe(200);
    expect(other.headers["idempotent-replayed"]).toBeUndefined();
    expect(other.body).toMatchObject({ voucher_id: a[1]!.voucher_id, already_cancelled: false });
  });

  it("cancels an expired (stored active) voucher", async () => {
    if (skip()) return;
    const res = await cancel(SES_OWNER_ALL, V_EXPIRED);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ voucher_id: V_EXPIRED, already_cancelled: false });
    expect((await get(SES_OWNER_ALL, V_EXPIRED)).body).toMatchObject({ status: "cancelled" });
  });

  it("refuses a redeemed voucher with 409 voucher_already_redeemed and leaves it unchanged", async () => {
    if (skip()) return;
    expectError(await cancel(SES_OWNER_ALL, V_REDEEMED), 409, "voucher_already_redeemed");
    const row = await env!.admin.query<{ status: string }>(`SELECT status FROM vouchers WHERE id = $1`, [V_REDEEMED]);
    expect(row.rows[0]!.status).toBe("redeemed");
    expect(await auditRows("voucher.cancelled", V_REDEEMED)).toHaveLength(0);
  });

  it("answers the same 404 for another tenant's voucher and an absent one; a bad id is 400", async () => {
    if (skip()) return;
    expectError(await cancel(SES_OWNER_ALL, V_B), 404, "voucher_not_found");
    expectError(await cancel(SES_OWNER_ALL, ABSENT), 404, "voucher_not_found");
    expectError(await cancel(SES_OWNER_ALL, "not-a-uuid"), 400, "validation_failure");
    const row = await env!.admin.query<{ status: string }>(`SELECT status FROM vouchers WHERE id = $1`, [V_B]);
    expect(row.rows[0]!.status).toBe("active");
  });

  it("settles two concurrent cancels with one winner and one audit row", async () => {
    if (skip()) return;
    const id = (await issueOk({ ...ALL, count: 1 })).vouchers[0]!.voucher_id;
    const [a, b] = await Promise.all([cancel(SES_OWNER_ALL, id), cancel(SES_OWNER_ALL, id)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const flags = [a, b].map((r) => (r.body as { already_cancelled: boolean }).already_cancelled).sort();
    expect(flags).toEqual([false, true]);
    expect(await auditRows("voucher.cancelled", id)).toHaveLength(1);
  });
});

describe("the domain role's column grants on vouchers (test-harness precondition)", () => {
  it("can UPDATE only status, cancelled_at and cancelled_by_user_id, and never DELETE", async () => {
    if (skip()) return;
    for (const column of ["amount_minor", "code_hash", "note", "expires_at", "currency_code", "tenant_id", "batch_id", "issued_by_user_id"]) {
      await expect(env!.app.query(`UPDATE vouchers SET ${column} = ${column} WHERE false`)).rejects.toThrow(/permission denied/);
    }
    await expect(env!.app.query(`UPDATE vouchers SET status = status WHERE false`)).resolves.toBeDefined();
    await expect(env!.app.query(`DELETE FROM vouchers WHERE false`)).rejects.toThrow(/permission denied/);
    await expect(env!.app.query(`DELETE FROM voucher_eligible_stores WHERE false`)).rejects.toThrow(/permission denied/);
    await expect(env!.app.query(`UPDATE voucher_eligible_stores SET store_id = store_id WHERE false`)).rejects.toThrow(/permission denied/);
  });
});
