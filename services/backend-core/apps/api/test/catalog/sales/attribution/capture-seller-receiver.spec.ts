/**
 * RT-1565 (RT-285 F-1) — seller per sale line and payment receiver per tender, end to end against a real
 * RLS-forced Postgres (the capture harness: real SalesController/Service, real IdempotencyInterceptor,
 * `env.app` under RLS).
 *
 * Acceptance (RT-1565, plan in comment 18562):
 *   - a sale without the new fields behaves exactly as before (no seller, no receiver, same projection);
 *   - two sellers on two lines and a split tender with another receiver are stored as frozen facts
 *     (user, the sale's store, the role held) and read back; responses validate against `Sale`;
 *   - a seller or receiver from another tenant, revoked before the sale, soft-deleted, a deleted user, a
 *     member without access to the store, or an unknown id is 422 `sale_seller_refused`, nothing recorded;
 *   - a member revoked AFTER the sale is still accepted (an offline sale syncs late);
 *   - the attribution is not hashed: a retry of the same provenance under a NEW Idempotency-Key naming
 *     another seller or receiver replays (200) and keeps the first capture's facts; a sale first sent
 *     without a seller replays the same way; the SAME Idempotency-Key with another seller is still the
 *     idempotency layer's 409 (it fingerprints the raw body), as for every other field;
 *   - RLS: another tenant cannot read the stored seller facts.
 */
import { resolve } from "node:path";

import { runWithTenantContext } from "@data-pulse-2/db";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Pool } from "pg";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import {
  captureBody,
  idempKey,
  resetHarness,
  startCaptureHarness,
  stopCaptureHarness,
  STORE_A_X,
  STORE_A_Y,
  TENANT_A,
  TENANT_B,
  type HarnessHandle,
} from "../capture/__capture-harness";

const FLAG = "POS_SALE_TENDERS_ENABLED";
const h: HarnessHandle = { harness: null, dockerSkipped: false };
const skip = (): boolean => h.dockerSkipped || !h.harness;

// captureBody() posts occurredAt 2026-05-01T10:00:00Z and posTotal 12.5000 (USD).
const BEFORE_SALE = "2026-04-01T00:00:00Z";
const AFTER_SALE = "2026-06-01T00:00:00Z";
const LONG_AGO = "2026-01-01T00:00:00Z";

const id = (n: number): string => `0a000000-0000-7000-8000-00000156${String(n).padStart(4, "0")}`;
const SELLER_ALL = id(1); // all stores, tenant_admin
const SELLER_X = id(2); // store X only, store_manager
const RECEIVER = id(3); // all stores
const NO_ACCESS = id(4); // store Y only
const REVOKED_BEFORE = id(5);
const REVOKED_AFTER = id(6);
const SOFT_DELETED = id(7);
const USER_DELETED = id(8);
const OTHER_TENANT = id(9);
const UNKNOWN = id(10);

interface Member {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: string;
  readonly stores: readonly string[] | "all";
  readonly revokedAt?: string;
  readonly deletedAt?: string;
  readonly userDeletedAt?: string;
}

const MEMBERS: readonly Member[] = [
  { userId: SELLER_ALL, tenantId: TENANT_A, role: "tenant_admin", stores: "all" },
  { userId: SELLER_X, tenantId: TENANT_A, role: "store_manager", stores: [STORE_A_X] },
  { userId: RECEIVER, tenantId: TENANT_A, role: "store_staff", stores: "all" },
  { userId: NO_ACCESS, tenantId: TENANT_A, role: "store_staff", stores: [STORE_A_Y] },
  { userId: REVOKED_BEFORE, tenantId: TENANT_A, role: "store_staff", stores: "all", revokedAt: BEFORE_SALE },
  { userId: REVOKED_AFTER, tenantId: TENANT_A, role: "store_staff", stores: "all", revokedAt: AFTER_SALE },
  { userId: SOFT_DELETED, tenantId: TENANT_A, role: "store_staff", stores: "all", deletedAt: BEFORE_SALE },
  { userId: USER_DELETED, tenantId: TENANT_A, role: "store_staff", stores: "all", userDeletedAt: BEFORE_SALE },
  { userId: OTHER_TENANT, tenantId: TENANT_B, role: "store_staff", stores: "all" },
];

async function roleIdOf(admin: Pool, tenantId: string, code: string): Promise<string> {
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES (gen_random_uuid(), $1, $2, $2) ON CONFLICT DO NOTHING`,
    [tenantId, code],
  );
  const r = await admin.query<{ id: string }>(`SELECT id::text AS id FROM roles WHERE tenant_id = $1 AND code = $2`, [
    tenantId,
    code,
  ]);
  return r.rows[0]!.id;
}

const roles = new Map<string, string>();

async function seedMembers(admin: Pool): Promise<void> {
  for (const m of MEMBERS) {
    const roleId = await roleIdOf(admin, m.tenantId, m.role);
    roles.set(m.userId, roleId);
    await admin.query(`INSERT INTO users (id, email, deleted_at) VALUES ($1, $2, $3)`, [
      m.userId,
      `rt1565-${m.userId.slice(-4)}@example.test`,
      m.userDeletedAt ?? null,
    ]);
    const membership = await admin.query<{ id: string }>(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind, revoked_at, deleted_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
      [
        m.tenantId,
        m.userId,
        roleId,
        m.stores === "all" ? "all" : "specific",
        m.revokedAt ?? null,
        m.deletedAt ?? null,
        LONG_AGO,
      ],
    );
    if (m.stores === "all") continue;
    for (const storeId of m.stores) {
      await admin.query(`INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`, [
        membership.rows[0]!.id,
        storeId,
        m.tenantId,
      ]);
    }
  }
}

const SALES_DIR = resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "pos-sales");

function saleValidator(): ValidateFunction {
  const contract = loadOpenApiContracts({ dir: SALES_DIR }).find((c) => c.id === "sales");
  if (!contract) throw new Error("pos-sales/sales.yaml not found");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(contract.document as object), $id: "sales" });
  return ajv.compile({ $ref: "sales#/components/schemas/Sale" });
}
const validateSale = saleValidator();

function expectValidSale(responseBody: unknown): void {
  const ok = validateSale(responseBody);
  expect(validateSale.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
  if (!h.harness) return;
  await seedMembers(h.harness.env.admin);
}, 180_000);
afterAll(async () => {
  delete process.env[FLAG];
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  process.env[FLAG] = "true";
});
afterEach(async () => {
  delete process.env[FLAG];
  if (!h.harness) return;
  const q = (sql: string) => h.harness!.env.admin.query(sql);
  const sales = "SELECT id FROM sales WHERE external_id LIKE 'rt1565-%'";
  await q(`DELETE FROM sale_tenders WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_lines WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sales WHERE external_id LIKE 'rt1565-%'`);
});

function post(body: Record<string, unknown>, key: string) {
  return h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(key)).send(body);
}

/** captureBody()'s two lines, with a seller on each (null = none). */
function linesWithSellers(first: string | null, second: string | null): Array<Record<string, unknown>> {
  const lines = captureBody().lines as Array<Record<string, unknown>>;
  return lines.map((l, i) => {
    const seller = i === 0 ? first : second;
    return seller === null ? { ...l } : { ...l, sellerUserId: seller };
  });
}

async function storedLines(externalId: string) {
  const r = await h.harness!.env.admin.query<{ u: string | null; s: string | null; r: string | null }>(
    `SELECT sl.seller_user_id::text AS u, sl.seller_store_id::text AS s, sl.seller_role_id::text AS r
       FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
      WHERE s.external_id = $1 ORDER BY sl.line_seq`,
    [externalId],
  );
  return r.rows;
}

async function storedReceivers(externalId: string): Promise<Array<string | null>> {
  const r = await h.harness!.env.admin.query<{ v: string | null }>(
    `SELECT t.received_by_user_id::text AS v
       FROM sale_tenders t JOIN sales s ON s.id = t.sale_id
      WHERE s.external_id = $1 ORDER BY t.sequence NULLS LAST, t.method`,
    [externalId],
  );
  return r.rows.map((row) => row.v);
}

async function saleCount(externalId: string): Promise<number> {
  const r = await h.harness!.env.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sales WHERE external_id = $1`,
    [externalId],
  );
  return Number(r.rows[0]!.n);
}

describe("RT-1565 — a sale without seller or receiver", () => {
  it("captures exactly as before: no seller, no receiver, nothing new in the projection", async () => {
    if (skip()) return;
    const res = await post(
      captureBody({ externalId: "rt1565-plain", tenders: [{ method: "cash", amount: "12.5" }] }),
      "rt1565plain",
    );
    expect(res.status).toBe(201);
    expectValidSale(res.body);
    for (const l of res.body.lines) expect(l).not.toHaveProperty("seller");
    expect(res.body.tenders).toEqual([{ method: "cash", amount: "12.5000" }]);
    expect(await storedLines("rt1565-plain")).toEqual([
      { u: null, s: null, r: null },
      { u: null, s: null, r: null },
    ]);
    expect(await storedReceivers("rt1565-plain")).toEqual([null]);
  });
});

describe("RT-1565 — sellers per line and a receiver per tender", () => {
  it("stores two sellers and a split tender's receiver as frozen facts and reads them back", async () => {
    if (skip()) return;
    const tenders = [
      { method: "cash", amount: "2.5", sequence: 1, receivedByUserId: RECEIVER },
      { method: "card_external", amount: "10.0000", reference: "A1B2C3", sequence: 2 },
    ];
    const res = await post(
      captureBody({ externalId: "rt1565-two", lines: linesWithSellers(SELLER_ALL, SELLER_X), tenders }),
      "rt1565two",
    );
    expect(res.status).toBe(201);
    expectValidSale(res.body);
    expect(res.body.lines.map((l: { seller?: unknown }) => l.seller)).toEqual([
      { userId: SELLER_ALL, storeId: STORE_A_X, roleId: roles.get(SELLER_ALL) },
      { userId: SELLER_X, storeId: STORE_A_X, roleId: roles.get(SELLER_X) },
    ]);
    expect(res.body.tenders).toEqual([
      { method: "cash", amount: "2.5000", sequence: 1, receivedByUserId: RECEIVER },
      { method: "card_external", amount: "10.0000", reference: "A1B2C3", sequence: 2 },
    ]);
    expect(await storedLines("rt1565-two")).toEqual([
      { u: SELLER_ALL, s: STORE_A_X, r: roles.get(SELLER_ALL) },
      { u: SELLER_X, s: STORE_A_X, r: roles.get(SELLER_X) },
    ]);
    expect(await storedReceivers("rt1565-two")).toEqual([RECEIVER, null]);

    const read = await h.harness!.http().get(`/api/pos/v1/sales/${res.body.saleRef}`);
    expect(read.status).toBe(200);
    expectValidSale(read.body);
    expect(read.body.lines).toEqual(res.body.lines);
    expect(read.body.tenders).toEqual(res.body.tenders);
  });

  it("accepts a member revoked after the sale (an offline sale that syncs late)", async () => {
    if (skip()) return;
    const res = await post(
      captureBody({ externalId: "rt1565-late", lines: linesWithSellers(REVOKED_AFTER, null) }),
      "rt1565late",
    );
    expect(res.status).toBe(201);
    expect(res.body.lines[0].seller.userId).toBe(REVOKED_AFTER);
  });
});

describe("RT-1565 — refusals (422 sale_seller_refused, nothing recorded)", () => {
  it.each([
    ["a member of another tenant", OTHER_TENANT],
    ["a member revoked before the sale", REVOKED_BEFORE],
    ["a membership soft-deleted before the sale", SOFT_DELETED],
    ["a user deleted before the sale", USER_DELETED],
    ["a member without access to the sale's store", NO_ACCESS],
    ["an unknown user", UNKNOWN],
  ])("refuses %s as a line's seller", async (_label, seller) => {
    if (skip()) return;
    const externalId = `rt1565-refuse-s-${seller.slice(-2)}`;
    const res = await post(captureBody({ externalId, lines: linesWithSellers(SELLER_ALL, seller) }), externalId);
    expect(res.status).toBe(422);
    expect(res.body.error?.code ?? res.body.code).toBe("sale_seller_refused");
    expect(await saleCount(externalId)).toBe(0);
  });

  it.each([
    ["a member of another tenant", OTHER_TENANT],
    ["a member without access to the sale's store", NO_ACCESS],
  ])("refuses %s as a tender's receiver", async (_label, receiver) => {
    if (skip()) return;
    const externalId = `rt1565-refuse-r-${receiver.slice(-2)}`;
    const res = await post(
      captureBody({ externalId, tenders: [{ method: "cash", amount: "12.5", receivedByUserId: receiver }] }),
      externalId,
    );
    expect(res.status).toBe(422);
    expect(res.body.error?.code ?? res.body.code).toBe("sale_seller_refused");
    expect(await saleCount(externalId)).toBe(0);
  });
});

describe("RT-1565 — not hashed: a retry replays the first capture", () => {
  it("a retry naming another seller is a replay (200), and the first seller stays", async () => {
    if (skip()) return;
    const first = await post(
      captureBody({ externalId: "rt1565-retry", lines: linesWithSellers(SELLER_ALL, null) }),
      "rt1565retry1",
    );
    expect(first.status).toBe(201);
    const retry = await post(
      captureBody({ externalId: "rt1565-retry", lines: linesWithSellers(SELLER_X, null) }),
      "rt1565retry2",
    );
    expect(retry.status).toBe(200);
    expect(retry.body.saleRef).toBe(first.body.saleRef);
    expect((await storedLines("rt1565-retry"))[0]!.u).toBe(SELLER_ALL);
  });

  it("a retry naming another payment receiver is a replay too (the tender compare ignores it)", async () => {
    if (skip()) return;
    const tender = (receiver: string) => [{ method: "cash", amount: "12.5", receivedByUserId: receiver }];
    const first = await post(captureBody({ externalId: "rt1565-rcv", tenders: tender(RECEIVER) }), "rt1565rcv1");
    expect(first.status).toBe(201);
    const retry = await post(captureBody({ externalId: "rt1565-rcv", tenders: tender(SELLER_ALL) }), "rt1565rcv2");
    expect(retry.status).toBe(200);
    expect(await storedReceivers("rt1565-rcv")).toEqual([RECEIVER]);
  });

  it("the SAME Idempotency-Key with another seller is a 409 from the idempotency layer, as for any field", async () => {
    if (skip()) return;
    const first = await post(
      captureBody({ externalId: "rt1565-samekey", lines: linesWithSellers(SELLER_ALL, null) }),
      "rt1565samekey",
    );
    expect(first.status).toBe(201);
    const changed = await post(
      captureBody({ externalId: "rt1565-samekey", lines: linesWithSellers(SELLER_X, null) }),
      "rt1565samekey",
    );
    expect(changed.status).toBe(409);
    expect(changed.body.error?.code ?? changed.body.code).toBe("idempotency_key_conflict");
    expect((await storedLines("rt1565-samekey"))[0]!.u).toBe(SELLER_ALL);
  });

  it("a sale first sent by an old till (no seller) replays when re-sent with one", async () => {
    if (skip()) return;
    const old = await post(captureBody({ externalId: "rt1565-old" }), "rt1565old1");
    expect(old.status).toBe(201);
    const resent = await post(
      captureBody({ externalId: "rt1565-old", lines: linesWithSellers(SELLER_ALL, SELLER_X) }),
      "rt1565old2",
    );
    expect(resent.status).toBe(200);
    expect(resent.body.saleRef).toBe(old.body.saleRef);
    expect((await storedLines("rt1565-old"))[0]!.u).toBeNull();
  });
});

describe("RT-1565 — tenant isolation", () => {
  it("another tenant cannot read the stored seller facts", async () => {
    if (skip()) return;
    const res = await post(
      captureBody({ externalId: "rt1565-rls", lines: linesWithSellers(SELLER_ALL, null) }),
      "rt1565rls",
    );
    expect(res.status).toBe(201);
    const seen = await runWithTenantContext(h.harness!.env.app, { tenantId: TENANT_B, isPlatformAdmin: false }, (c) =>
      c.query(`SELECT 1 FROM sale_lines WHERE seller_user_id = $1`, [SELLER_ALL]),
    );
    expect(seen.rowCount).toBe(0);
    const own = await runWithTenantContext(h.harness!.env.app, { tenantId: TENANT_A, isPlatformAdmin: false }, (c) =>
      c.query(`SELECT 1 FROM sale_lines WHERE seller_user_id = $1`, [SELLER_ALL]),
    );
    expect(own.rowCount).toBe(1);
  });
});
