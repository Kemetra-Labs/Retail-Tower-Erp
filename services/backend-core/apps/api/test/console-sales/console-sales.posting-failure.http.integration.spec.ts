/**
 * RT-1061 (RT-977 slice 1, decisions D1-D9) — `consoleGetSale.erpPostingFailure`
 * over HTTP against real Postgres (Testcontainers, every migration, the
 * NOBYPASSRLS `app_test` pool) and the real module graphs: `ConsoleSalesModule`
 * for the read and `ErpnextReconciliationModule` for `repairPosting`, on the
 * same database. Only cookie authentication is faked (a header names the
 * session).
 *
 * What this proves (RT-977 §5, §10 slice 1; RT-1061 acceptance 3 and 4):
 *   - disclosure by role: `owner`, `tenant_admin` and a platform admin's
 *     session (with no membership, or holding a `store_manager` one) get
 *     `full`; `store_manager` gets `category_only`, with `reason`,
 *     `reconciliationDocumentRef` and `repair` null;
 *   - no dead buttons: every handle the read returns is accepted by
 *     `repairPosting` for the same session (201 or 200, never 404), and the
 *     sessions that get none are refused by it;
 *   - the handle rules: no handle for `reconciliation_required` (its evidence
 *     is shown) or for a deleted store;
 *   - the probe keys: a failed void reversal is on the reversal side; a failed
 *     return reversal (same `sale_id`, another `source_ref_id`) is never
 *     shown, and a sale whose only failure is such a return reads null;
 *   - pre-0071 / Backend-Core-raised rows give `reason: null`;
 *   - a stale handle (the row moved to `failed_transient`) is still answered
 *     by its current state, never 404;
 *   - tenant and store isolation are unchanged (the same non-disclosing 404);
 *   - the audit metadata is unchanged and never carries the reason;
 *   - `syncStatusVersion` is on the detail summary and on every list item.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import type { ValidateFunction } from "ajv";
import request from "supertest";

import type { AuditJobPayload } from "../../src/audit/audit-job.types";
import { ErpnextReconciliationModule } from "../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.module";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import {
  bootScopedApp,
  S_DELETED,
  SES_ADMIN_SPEC,
  SES_OWNER_ALL,
  SES_OWNER_SPEC,
} from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  CASHIER,
  seedConsoleSalesFixture,
  SES_MANAGER,
  SES_PLATFORM,
  SES_PLATFORM_ACTIVE,
  SES_PLATFORM_MANAGER,
  SES_STAFF,
  X_FULL,
  X_OCT01,
} from "./__support__/console-sales-fixture";
import { expectValid, useConsoleHttpHarness } from "./__support__/console-http-harness";
import type { PgTestEnv } from "../_helpers/postgres-container";

const CONTRACT_ID = "console-sales.openapi";
const detailPath = (saleRef: string): string => `/api/v1/sales/${saleRef}`;
const repairPath = (workItemRef: string): string =>
  `/api/v1/catalog/erpnext-reconciliation/postings/${workItemRef}/repair`;

const id = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const ZERO_HASH = "0".repeat(64);
const REASON = "ValidationError: Item WIDGET-1 has no price list rate (RT-1061 fixture)";
const VOID_REASON = "Period closed for posting date (RT-1061 fixture)";
const RETURN_REASON = "RETURN REVERSAL REASON MUST NEVER SHOW (RT-1061 fixture)";
const EVIDENCE = { doctype: "Sales Invoice", name: "ACC-SINV-1061" };

// Sales (STORE_A_X unless noted), all in October so the fixture's ranges are untouched.
const PF_SALE = id("1061a1"); // sale_post dead-lettered (validation), plus a failed RETURN reversal
const PF_RECON = id("1061a2"); // sale_post reconciliation_required with evidence
const PF_VOID = id("1061a3"); // sale posted; void reversal dead-lettered (closed_period)
const PF_RETURN_ONLY = id("1061a4"); // sale posted; only a failed return reversal
const PF_NO_REASON = id("1061a5"); // dead-lettered without a stored message (pre-0071 / Backend-Core-raised)
const PF_STALE = id("1061a6"); // dead-lettered, then moved to failed_transient behind the reader's back
const PF_DELETED = id("1061a7"); // S_DELETED store: dead-lettered
const PF_Y = id("1061a8"); // STORE_A_Y: dead-lettered
const PF_B = "0b000000-0000-7000-8000-0000001061b1"; // tenant B

const WI = {
  sale: id("1061b1"),
  saleReturn: id("1061b2"),
  recon: id("1061b3"),
  voidSale: id("1061b4"),
  voidReversal: id("1061b5"),
  returnOnlySale: id("1061b6"),
  returnOnly: id("1061b7"),
  noReason: id("1061b8"),
  stale: id("1061b9"),
  deleted: id("1061ba"),
  y: id("1061bb"),
  b: id("1061bc"),
} as const;
const VOID_ROW = id("1061c1");

async function seedSale(env: PgTestEnv, saleId: string, storeId: string, tenantId = TENANT_A): Promise<void> {
  await env.admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by, sync_status, tender_count)
     VALUES ($1, $2, $3, 'EGP', 5.00, '2026-10-20T09:00:00Z', '2026-10-20', 'rt1061-seed', $4, $5, $6, 'synced', 0)`,
    [saleId, tenantId, storeId, `rt1061-${saleId}`, ZERO_HASH, CASHIER],
  );
  await env.admin.query(
    `INSERT INTO sale_lines
       (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity, line_amount, unit)
     VALUES (gen_random_uuid(), $1, $2, $3, 'Widget', 5.00, 'EGP', 1, 5.00, 'unit')`,
    [saleId, tenantId, storeId],
  );
}

interface PostingSeed {
  readonly id: string;
  readonly saleId: string;
  readonly storeId: string;
  readonly kind: "sale_post" | "reversal";
  readonly sourceRefId: string;
  readonly status: "permanently_rejected" | "posted";
  readonly category?: string | null;
  readonly message?: string | null;
  readonly evidence?: string | null;
  readonly tenantId?: string;
}

async function seedPosting(env: PgTestEnv, p: PostingSeed): Promise<void> {
  await env.admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash,
        status, document_ref, rejection_category, rejection_message, reconciliation_document_ref)
     VALUES ($1, $2, $3, $4, $5, $6, 'rt1061-seed', $7, $8, $9, $10, $11, $12, $13)`,
    [
      p.id,
      p.tenantId ?? TENANT_A,
      p.storeId,
      p.saleId,
      p.kind,
      p.sourceRefId,
      `rt1061-post-${p.id}`,
      ZERO_HASH,
      p.status,
      p.status === "posted" ? `SINV-${p.id.slice(-4)}` : null,
      p.status === "permanently_rejected" ? (p.category === undefined ? "validation" : p.category) : null,
      p.message ?? null,
      p.evidence ?? null,
    ],
  );
}

async function seedPostingFailures(env: PgTestEnv): Promise<void> {
  await seedConsoleSalesFixture(env);
  for (const [saleId, storeId] of [
    [PF_SALE, STORE_A_X],
    [PF_RECON, STORE_A_X],
    [PF_VOID, STORE_A_X],
    [PF_RETURN_ONLY, STORE_A_X],
    [PF_NO_REASON, STORE_A_X],
    [PF_STALE, STORE_A_X],
    [PF_DELETED, S_DELETED],
    [PF_Y, STORE_A_Y],
  ] as const) {
    await seedSale(env, saleId, storeId);
  }
  await seedSale(env, PF_B, STORE_B_X, TENANT_B);

  const X = STORE_A_X;
  await seedPosting(env, { id: WI.sale, saleId: PF_SALE, storeId: X, kind: "sale_post", sourceRefId: PF_SALE, status: "permanently_rejected", message: REASON });
  // A failed RETURN reversal of the same sale: same sale_id, source_ref_id = the return (never shown).
  await seedPosting(env, { id: WI.saleReturn, saleId: PF_SALE, storeId: X, kind: "reversal", sourceRefId: id("1061d1"), status: "permanently_rejected", message: RETURN_REASON });
  await seedPosting(env, {
    id: WI.recon,
    saleId: PF_RECON,
    storeId: X,
    kind: "sale_post",
    sourceRefId: PF_RECON,
    status: "permanently_rejected",
    category: "reconciliation_required",
    message: REASON,
    evidence: JSON.stringify(EVIDENCE),
  });
  await env.admin.query(
    `INSERT INTO sale_voids
       (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, $4, '2026-10-20', 'rt1061-seed', 'rt1061-void', $5, $6)`,
    [VOID_ROW, PF_VOID, TENANT_A, X, ZERO_HASH, CASHIER],
  );
  await seedPosting(env, { id: WI.voidSale, saleId: PF_VOID, storeId: X, kind: "sale_post", sourceRefId: PF_VOID, status: "posted" });
  await seedPosting(env, {
    id: WI.voidReversal,
    saleId: PF_VOID,
    storeId: X,
    kind: "reversal",
    sourceRefId: VOID_ROW,
    status: "permanently_rejected",
    category: "closed_period",
    message: VOID_REASON,
  });
  await seedPosting(env, { id: WI.returnOnlySale, saleId: PF_RETURN_ONLY, storeId: X, kind: "sale_post", sourceRefId: PF_RETURN_ONLY, status: "posted" });
  await seedPosting(env, { id: WI.returnOnly, saleId: PF_RETURN_ONLY, storeId: X, kind: "reversal", sourceRefId: id("1061d2"), status: "permanently_rejected", message: RETURN_REASON });
  await seedPosting(env, { id: WI.noReason, saleId: PF_NO_REASON, storeId: X, kind: "sale_post", sourceRefId: PF_NO_REASON, status: "permanently_rejected", category: "retry_budget_exhausted", message: null });
  await seedPosting(env, { id: WI.stale, saleId: PF_STALE, storeId: X, kind: "sale_post", sourceRefId: PF_STALE, status: "permanently_rejected", message: REASON });
  await seedPosting(env, { id: WI.deleted, saleId: PF_DELETED, storeId: S_DELETED, kind: "sale_post", sourceRefId: PF_DELETED, status: "permanently_rejected", message: REASON });
  await seedPosting(env, { id: WI.y, saleId: PF_Y, storeId: STORE_A_Y, kind: "sale_post", sourceRefId: PF_Y, status: "permanently_rejected", message: REASON });
  await seedPosting(env, { id: WI.b, saleId: PF_B, storeId: STORE_B_X, kind: "sale_post", sourceRefId: PF_B, status: "permanently_rejected", message: REASON, tenantId: TENANT_B });
}

const http = useConsoleHttpHarness({ label: "RT-1061 console-sales posting failure", contractId: CONTRACT_ID, seed: seedPostingFailures });
let repairApp: INestApplication | null = null;
let detailSchema: ValidateFunction;

beforeAll(async () => {
  detailSchema = http.schema("ConsoleSaleDetail");
  if (http.skip()) return;
  repairApp = await bootScopedApp(http.env(), ErpnextReconciliationModule);
}, 120_000);

afterAll(async () => {
  if (repairApp) await repairApp.close();
}, 60_000);

const skip = (): boolean => http.skip();

interface FailureSide {
  rejectionCategory: string | null;
  deadLetteredAt: string;
  reason: string | null;
  reconciliationDocumentRef: { doctype: string; name: string } | null;
  repair: { workItemRef: string } | null;
}
interface Failure {
  disclosure: "full" | "category_only";
  sale: FailureSide | null;
  reversal: FailureSide | null;
}
interface Detail {
  summary: { saleRef: string; syncStatusVersion: number };
  erpPosting: { sale: string; reversal: string | null };
  erpPostingFailure: Failure | null;
}

async function detail(saleRef: string, session: string): Promise<Detail> {
  const res = await http.get(detailPath(saleRef), session);
  if (res.status !== 200) throw new Error(`detail ${res.status}: ${JSON.stringify(res.body)}`);
  expectValid(detailSchema, res.body);
  return res.body as Detail;
}

let keySeq = 0;
function repair(workItemRef: string, session: string): request.Test {
  keySeq += 1;
  return request(repairApp!.getHttpServer())
    .post(repairPath(workItemRef))
    .set("x-test-session", session)
    .set("Idempotency-Key", `rt1061k${String(keySeq).padStart(4, "0")}`.padEnd(32, "0"))
    .send({});
}

async function postingState(workItemRef: string): Promise<{ status: string; message: string | null }> {
  const r = await http
    .env()
    .admin.query<{ status: string; message: string | null }>(
      `SELECT status, rejection_message AS message FROM erpnext_posting_status WHERE id = $1`,
      [workItemRef],
    );
  return r.rows[0]!;
}

/** Put a work item back to the dead-letter it was seeded as (after a repair re-offered it). */
async function resetDeadLetter(workItemRef: string, message: string | null): Promise<void> {
  await http
    .env()
    .admin.query(
      `UPDATE erpnext_posting_status
          SET status = 'permanently_rejected', rejection_message = $2, document_ref = NULL, updated_at = now()
        WHERE id = $1`,
      [workItemRef, message],
    );
}

const FULL_SESSIONS: ReadonlyArray<readonly [string, string]> = [
  ["owner, all", SES_OWNER_ALL],
  ["owner, specific (X)", SES_OWNER_SPEC],
  ["tenant_admin, specific (X)", SES_ADMIN_SPEC],
  ["platform admin, no membership", SES_PLATFORM],
  ["platform admin, X active", SES_PLATFORM_ACTIVE],
  ["platform admin holding a store_manager membership", SES_PLATFORM_MANAGER],
];

// ===========================================================================
// Disclosure by role, and no dead buttons
// ===========================================================================

describe("RT-1061 erpPostingFailure — disclosure by role", () => {
  it.each(FULL_SESSIONS)("%s gets full: category, time, the stored reason and a repair handle", async (_label, session) => {
    if (skip()) return;
    const d = await detail(PF_SALE, session);
    expect(d.erpPosting.sale).toBe("failed");
    expect(d.erpPostingFailure).toEqual({
      disclosure: "full",
      sale: {
        rejectionCategory: "validation",
        deadLetteredAt: expect.any(String),
        reason: REASON,
        reconciliationDocumentRef: null,
        repair: { workItemRef: WI.sale },
      },
      reversal: null,
    });
  });

  it("store_manager gets category_only: the category and the time; reason, evidence and repair are null", async () => {
    if (skip()) return;
    for (const saleRef of [PF_SALE, PF_RECON]) {
      const d = await detail(saleRef, SES_MANAGER);
      expect(d.erpPostingFailure?.disclosure).toBe("category_only");
      expect(d.erpPostingFailure?.sale).toMatchObject({ reason: null, reconciliationDocumentRef: null, repair: null });
      expect(d.erpPostingFailure?.sale?.rejectionCategory).toBe(saleRef === PF_RECON ? "reconciliation_required" : "validation");
      expect(JSON.stringify(d)).not.toContain(REASON);
      expect(JSON.stringify(d)).not.toContain(EVIDENCE.name);
    }
  });

  it("store_staff stays the non-disclosing 404, as before", async () => {
    if (skip()) return;
    expect((await http.get(detailPath(PF_SALE), SES_STAFF)).status).toBe(404);
  });
});

describe("RT-1061 erpPostingFailure — no dead buttons, and no handle where repair would refuse", () => {
  it.each(FULL_SESSIONS)("%s: the handle the read returns is accepted by repairPosting (201 or 200, never 404)", async (_label, session) => {
    if (skip()) return;
    const handle = (await detail(PF_SALE, session)).erpPostingFailure!.sale!.repair!.workItemRef;
    const res = await repair(handle, session);
    expect([200, 201]).toContain(res.status);
    expect(["eligible_again", "still_failing", "no_op_echo"]).toContain(res.body.outcome);
    // Put the dead-letter back for the next session, whatever the outcome did to it.
    await resetDeadLetter(WI.sale, REASON);
  });

  it("store_manager gets no handle, and repairPosting refuses that session (404)", async () => {
    if (skip()) return;
    expect((await detail(PF_SALE, SES_MANAGER)).erpPostingFailure!.sale!.repair).toBeNull();
    expect((await repair(WI.sale, SES_MANAGER)).status).toBe(404);
    expect(await postingState(WI.sale)).toEqual({ status: "permanently_rejected", message: REASON });
  });

  it("reconciliation_required: no handle (never re-offered, RT-332); the evidence is shown under full", async () => {
    if (skip()) return;
    const d = await detail(PF_RECON, SES_OWNER_ALL);
    expect(d.erpPostingFailure!.sale).toMatchObject({
      rejectionCategory: "reconciliation_required",
      reason: REASON,
      reconciliationDocumentRef: EVIDENCE,
      repair: null,
    });
  });

  it("a deleted store: an `all` owner reads the reason but gets no handle; repairPosting answers 404 for it", async () => {
    if (skip()) return;
    const d = await detail(PF_DELETED, SES_OWNER_ALL);
    expect(d.erpPostingFailure).toMatchObject({ disclosure: "full", sale: { reason: REASON, repair: null } });
    expect((await repair(WI.deleted, SES_OWNER_ALL)).status).toBe(404);
  });

  it("a store outside a specific owner's scope stays the non-disclosing 404 on the read", async () => {
    if (skip()) return;
    expect((await http.get(detailPath(PF_Y), SES_OWNER_SPEC)).status).toBe(404);
    expect((await detail(PF_Y, SES_OWNER_ALL)).erpPostingFailure!.sale!.repair).toEqual({ workItemRef: WI.y });
  });

  it("another tenant's failed sale stays the non-disclosing 404", async () => {
    if (skip()) return;
    for (const session of [SES_OWNER_ALL, SES_PLATFORM]) {
      expect((await http.get(detailPath(PF_B), session)).status).toBe(404);
    }
  });
});

// ===========================================================================
// Probe keys, null cases and a stale handle
// ===========================================================================

describe("RT-1061 erpPostingFailure — what the probe reads", () => {
  it("a failed void reversal is on the reversal side, with its own reason and handle", async () => {
    if (skip()) return;
    const d = await detail(PF_VOID, SES_OWNER_ALL);
    expect(d.erpPosting).toMatchObject({ sale: "posted", reversal: "failed" });
    expect(d.erpPostingFailure).toEqual({
      disclosure: "full",
      sale: null,
      reversal: {
        rejectionCategory: "closed_period",
        deadLetteredAt: expect.any(String),
        reason: VOID_REASON,
        reconciliationDocumentRef: null,
        repair: { workItemRef: WI.voidReversal },
      },
    });
  });

  it("a failed RETURN reversal (same sale_id) is never shown: not beside a failed sale, and not alone", async () => {
    if (skip()) return;
    const withSale = await detail(PF_SALE, SES_OWNER_ALL);
    expect(withSale.erpPostingFailure!.reversal).toBeNull();
    expect(JSON.stringify(withSale)).not.toContain(RETURN_REASON);
    const alone = await detail(PF_RETURN_ONLY, SES_OWNER_ALL);
    expect(alone.erpPosting).toMatchObject({ sale: "posted", reversal: null });
    expect(alone.erpPostingFailure).toBeNull();
  });

  it("a sale with no failed posting reads null (posted, pending, no row)", async () => {
    if (skip()) return;
    expect((await detail(X_OCT01, SES_OWNER_ALL)).erpPostingFailure).toBeNull();
  });

  it("a dead-letter without a stored message (pre-0071, Backend-Core-raised) has reason null and still a handle", async () => {
    if (skip()) return;
    expect((await detail(PF_NO_REASON, SES_OWNER_ALL)).erpPostingFailure!.sale).toMatchObject({
      rejectionCategory: "retry_budget_exhausted",
      reason: null,
      repair: { workItemRef: WI.noReason },
    });
    // The fixture's permanently_rejected sale has no category and no message.
    expect((await detail(X_FULL, SES_OWNER_ALL)).erpPostingFailure!.sale).toMatchObject({ rejectionCategory: null, reason: null });
  });

  it("a stale handle (the row moved to failed_transient) is answered by its current state, never 404", async () => {
    if (skip()) return;
    const handle = (await detail(PF_STALE, SES_OWNER_ALL)).erpPostingFailure!.sale!.repair!.workItemRef;
    await http
      .env()
      .admin.query(`UPDATE erpnext_posting_status SET status = 'failed_transient', rejection_message = NULL WHERE id = $1`, [handle]);
    // The read now shows it pending, and no failure.
    const now = await detail(PF_STALE, SES_OWNER_ALL);
    expect(now.erpPosting.sale).toBe("pending");
    expect(now.erpPostingFailure).toBeNull();
    const res = await repair(handle, SES_OWNER_ALL);
    expect(res.status).toBe(201);
    expect(["eligible_again", "still_failing"]).toContain(res.body.outcome);
  });
});

// ===========================================================================
// syncStatusVersion on the console reads, and audit
// ===========================================================================

describe("RT-1061 console reads — syncStatusVersion and audit", () => {
  it("the detail summary and every list item carry syncStatusVersion, the stored value", async () => {
    if (skip()) return;
    await http.env().admin.query(`UPDATE sales SET sync_status_version = 7 WHERE id = $1`, [PF_SALE]);
    expect((await detail(PF_SALE, SES_OWNER_ALL)).summary.syncStatusVersion).toBe(7);
    const res = await http.get("/api/v1/sales", SES_OWNER_ALL, { store_id: STORE_A_X, from: "2026-10-20", to: "2026-10-20", page_size: 100 });
    expect(res.status).toBe(200);
    expectValid(http.schema("ConsoleSalePage"), res.body);
    const items = res.body.items as Array<{ saleRef: string; syncStatusVersion: number }>;
    expect(items.length).toBeGreaterThan(1);
    expect(Object.fromEntries(items.map((i) => [i.saleRef, i.syncStatusVersion]))).toMatchObject({ [PF_SALE]: 7, [PF_RECON]: 0 });
  });

  it("console_sales.detail_read metadata stays sale_ref + store_id; the reason never enters an audit payload", async () => {
    if (skip()) return;
    const before = http.audit.payloads.length;
    await detail(PF_SALE, SES_OWNER_ALL);
    const events = http.audit.payloads.slice(before) as AuditJobPayload[];
    expect(events.map((e) => e.action)).toEqual(["console_sales.detail_read"]);
    expect(Object.keys(events[0]!.metadata ?? {}).sort()).toEqual(["sale_ref", "store_id"]);
    expect(JSON.stringify(http.audit.payloads)).not.toContain(REASON);
    expect(JSON.stringify(http.audit.payloads)).not.toContain(VOID_REASON);
  });
});
