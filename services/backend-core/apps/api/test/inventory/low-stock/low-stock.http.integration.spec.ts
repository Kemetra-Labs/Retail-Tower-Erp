/**
 * RT-1069 — the console low-stock read (`inventory/low-stock.yaml`,
 * `consoleListLowStock`; RT-1055 LS-1 to LS-5, thresholds per RT-1064 TH-3)
 * over HTTP against real Postgres (Testcontainers, every migration including
 * 0078, the NOBYPASSRLS `app_test` pool) and the real module graph
 * (`SessionOnlyAdminGuard`, `TenantContextGuard`, `RolesGuard`,
 * `MembershipRepository`). Only cookie authentication is faked: a header
 * names the session; without it the real guard decides, so a bearer is 401.
 *
 * Dataset (tenant A; live stores X, Y and the inactive store Z; S_DELETED is
 * soft-deleted). Levels are seeded directly in `product_stock_levels`:
 *
 *   P1  tenant 10 / 2      X 0 (+5 −5) → critical 0.0000; Y 5 → low 0.5000; Z no movement → unknown
 *   P2  tenant 3 / –, store X 100 / 50
 *                          X 40 → critical 0.4000 (store); Y 3 → not low (strict); Z 1 → low 0.3333 (inactive store)
 *   P3  store Y 7 / –      Y 2 sellable + 10 quality_hold → low 0.2857 (store); X has stock but no level → never evaluated
 *   P4  no level           X has stock → never evaluated
 *   P5  tenant 5 / –       X −2 → negative; Y 4 quality_hold only → known 0 → low 0.0000; Z → unknown
 *   P6  inactive product   tenant 10 → never evaluated
 *   P7  retired product    tenant 10 → never evaluated
 *   P8  tenant 10 / –, store X override is_active false
 *                          X not available → never evaluated; Y 9 → low 0.9000; Z → unknown
 *   P9  store S_DELETED 10 → never evaluated
 *   P10 tenant 4 / 4, store X 20 RETIRED
 *                          X 3 → critical 0.7500 (falls back to tenant); Y 10 → not low; Z → unknown
 *   P12 store X 3 / –      X 1 → low, exact 1/3
 *   P13 store Y 30000 / –  Y 9999 kg → low, exact 0.3333 (< 1/3: before P12 although both read "0.3333")
 *   PB  tenant B           STORE_B_X low → never visible to tenant A
 *
 * Owner (`all`): 17 evaluated, 10 below reorder (3 critical), 4 unknown, 1
 * negative, in the contract order: critical P1@X, P2@X, P10@X; then low
 * P5@Y, P3@Y, P13@Y, P12@X, P2@Z (ties with P12@X on the exact ratio:
 * store id), P1@Y, P8@Y.
 *
 * What this proves (RT-1069 acceptance):
 *   - ordering by band, then the exact ratio, then store, then product; the
 *     bounded top-N (`limit`, `truncated`) with scope-wide counts;
 *   - per-pair threshold resolution (TH-3), the evaluated-pair rules, and that
 *     a pair with no threshold is never evaluated or counted;
 *   - unknown on-hand is counted and never listed (never a zero); a negative
 *     on-hand is counted and never listed;
 *   - isolation: tenant B never leaks; store_manager scope (and active-store
 *     narrowing); a role outside the list, and a `store_id` outside the
 *     scope, of another tenant, soft-deleted or absent, are one
 *     non-disclosing 404; a bearer is 401;
 *   - 400 on a malformed, repeated or unknown query key, after the guards;
 *   - every body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";

import { ConsoleLowStockModule } from "../../../src/inventory/low-stock/low-stock.module";
import { allContracts, contractDocument } from "../../_helpers/openapi-contract";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../../catalog/__support__/isolation-harness";
import { seedConsoleCatalogFixture } from "../../catalog/console-catalog/__support__/console-catalog-fixture";
import {
  bootScopedApp,
  NON_EXISTENT,
  S_DELETED,
  SES_ADMIN_SPEC,
  SES_OWNER_ALL,
  SES_OWNER_SPEC,
} from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  DASHBOARD_TOKEN,
  SES_ADMIN_EMPTY,
  SES_MANAGER,
  SES_MANAGER_ACTIVE,
  SES_STAFF,
} from "../../console-sales/__support__/console-sales-fixture";

type StoreId = string;
type ProductId = string;
type SessionHeader = string;
type QueryString = string;
type Quantity = string;

const PATH = "/api/v1/inventory/low-stock";
const CONTRACT_ID = "low-stock";
const NOT_FOUND = { code: "not_found", message: "Not Found" };

const a = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const b = (tag: string): string => `0b000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const ACTOR = a("1069e01");
/** Inactive store of tenant A; sorts after STORE_A_X and STORE_A_Y. */
const S_Z = a("1069a5a9");

const P1 = a("10690001");
const P2 = a("10690002");
const P3 = a("10690003");
const P4 = a("10690004");
const P5 = a("10690005");
const P6 = a("10690006");
const P7 = a("10690007");
const P8 = a("10690008");
const P9 = a("10690009");
const P10 = a("1069000a");
const P12 = a("1069000c");
const P13 = a("1069000d");
const PB = b("10690b01");

interface Item {
  storeId: string;
  storeName: string;
  storeStatus: "active" | "inactive";
  productId: string;
  productName: string;
  stockingUnit: string | null;
  sellableOnHand: string;
  reorderLevel: string;
  criticalLevel: string | null;
  thresholdSource: "tenant" | "store";
  band: "critical" | "low";
  levelRatio: string;
}
interface LowStockList {
  asOf: string;
  completeness: string;
  storeId: string | null;
  limit: number;
  evaluatedCount: number;
  belowReorderCount: number;
  criticalCount: number;
  unknownOnHandCount: number;
  negativeOnHandCount: number;
  truncated: boolean;
  items: Item[];
}

/** The owner's full list, in contract order: [product, store, band, ratio, source, sellable]. */
const OWNER_ORDER: ReadonlyArray<readonly [ProductId, StoreId, Item["band"], string, Item["thresholdSource"], Quantity]> = [
  [P1, STORE_A_X, "critical", "0.0000", "tenant", "0.0000"],
  [P2, STORE_A_X, "critical", "0.4000", "store", "40.0000"],
  [P10, STORE_A_X, "critical", "0.7500", "tenant", "3.0000"],
  [P5, STORE_A_Y, "low", "0.0000", "tenant", "0.0000"],
  [P3, STORE_A_Y, "low", "0.2857", "store", "2.0000"],
  [P13, STORE_A_Y, "low", "0.3333", "store", "9999.0000"],
  [P12, STORE_A_X, "low", "0.3333", "store", "1.0000"],
  [P2, S_Z, "low", "0.3333", "tenant", "1.0000"],
  [P1, STORE_A_Y, "low", "0.5000", "tenant", "5.0000"],
  [P8, STORE_A_Y, "low", "0.9000", "tenant", "9.0000"],
];
const NEVER_LISTED = new Set([P4, P6, P7, P9, PB]);

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
let moveSeq = 0;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
let listSchema: ValidateFunction;
let errorSchema: ValidateFunction;

async function product(id: ProductId, opts: { tenantId?: string; active?: boolean; retired?: boolean } = {}): Promise<void> {
  await env!.admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, is_active, retired_at, created_by, updated_by)
     VALUES ($1, $2, $3, 'standard', $4, CASE WHEN $5::boolean THEN now() END, $6, $6)`,
    [id, opts.tenantId ?? TENANT_A, `RT1069 ${id.slice(-4)}`, opts.active ?? true, opts.retired ?? false, ACTOR],
  );
}

async function level(
  productId: ProductId,
  storeId: StoreId | null,
  reorder: Quantity,
  critical: Quantity | null,
  opts: { tenantId?: string; retired?: boolean } = {},
): Promise<void> {
  moveSeq += 1;
  await env!.admin.query(
    `INSERT INTO product_stock_levels
       (id, tenant_id, product_id, store_id, reorder_level, critical_level, retired_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, CASE WHEN $7::boolean THEN now() END, $8, $8)`,
    [a(`1069c${moveSeq.toString(16).padStart(3, "0")}`), opts.tenantId ?? TENANT_A, productId, storeId, reorder, critical,
      opts.retired ?? false, ACTOR],
  );
}

async function move(
  storeId: StoreId,
  productId: ProductId,
  quantity: Quantity,
  opts: { tenantId?: string; status?: string; unit?: string } = {},
): Promise<void> {
  moveSeq += 1;
  await env!.admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, reason,
        occurred_at, created_by, stock_location_id, inventory_status)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, 'rt1069 seed', now(), $8,
             (SELECT id FROM stock_locations WHERE store_id = $3::uuid AND kind = 'primary'), $9)`,
    [
      (opts.tenantId ?? TENANT_A) === TENANT_A ? a(`1069d${moveSeq.toString(16).padStart(3, "0")}`) : b(`1069d${moveSeq.toString(16).padStart(3, "0")}`),
      opts.tenantId ?? TENANT_A,
      storeId,
      quantity.startsWith("-") ? "adjustment" : "inbound",
      quantity,
      opts.unit ?? "ea",
      productId,
      ACTOR,
      opts.status ?? "sellable",
    ],
  );
}

async function seedLowStock(): Promise<void> {
  const admin = env!.admin;
  await admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt1069-actor@example.test')`, [ACTOR]);
  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name, is_active) VALUES ($1, $2, 'rt1069-z', 'RT-1069 Inactive Z', false)`,
    [S_Z, TENANT_A],
  );
  for (const id of [P1, P2, P3, P4, P5, P8, P9, P10, P12, P13]) await product(id);
  await product(P6, { active: false });
  await product(P7, { retired: true });
  await product(PB, { tenantId: TENANT_B });

  await level(P1, null, "10", "2");
  await move(STORE_A_X, P1, "5");
  await move(STORE_A_X, P1, "-5");
  await move(STORE_A_Y, P1, "5");

  await level(P2, null, "3", null);
  await level(P2, STORE_A_X, "100", "50");
  await move(STORE_A_X, P2, "40");
  await move(STORE_A_Y, P2, "3");
  await move(S_Z, P2, "1");

  await level(P3, STORE_A_Y, "7", null);
  await move(STORE_A_Y, P3, "2");
  await move(STORE_A_Y, P3, "10", { status: "quality_hold" });
  await move(STORE_A_X, P3, "1");

  await move(STORE_A_X, P4, "1");

  await level(P5, null, "5", null);
  await move(STORE_A_X, P5, "-2");
  await move(STORE_A_Y, P5, "4", { status: "quality_hold" });

  await level(P6, null, "10", null);
  await move(STORE_A_X, P6, "1");
  await level(P7, null, "10", null);
  await move(STORE_A_X, P7, "1");

  await level(P8, null, "10", null);
  await admin.query(
    `INSERT INTO store_product_overrides (id, tenant_id, store_id, product_id, is_active, created_by, updated_by)
     VALUES ($1, $2, $3, $4, false, $5, $5)`,
    [a("1069f001"), TENANT_A, STORE_A_X, P8, ACTOR],
  );
  await move(STORE_A_X, P8, "1");
  await move(STORE_A_Y, P8, "9");

  await level(P9, S_DELETED, "10", null);

  await level(P10, null, "4", "4");
  await level(P10, STORE_A_X, "20", null, { retired: true });
  await move(STORE_A_X, P10, "3");
  await move(STORE_A_Y, P10, "10");

  await level(P12, STORE_A_X, "3", null);
  await move(STORE_A_X, P12, "1");
  await level(P13, STORE_A_Y, "30000", null);
  await move(STORE_A_Y, P13, "9999", { unit: "kg" });

  await level(PB, null, "10", null, { tenantId: TENANT_B });
  await move(STORE_B_X, PB, "1", { tenantId: TENANT_B });

  // The expected figures assume exactly these live tenant-A stores.
  const live = await admin.query<{ id: string }>(
    `SELECT id::text FROM stores WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY id`,
    [TENANT_A],
  );
  expect(live.rows.map((r) => r.id)).toEqual([STORE_A_X, STORE_A_Y, S_Z]);
}

beforeAll(async () => {
  ajv.addSchema(contractDocument(allContracts(), CONTRACT_ID) as object, CONTRACT_ID);
  const compiled = (name: string): ValidateFunction => {
    const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
    if (!v) throw new Error(`ajv cannot resolve ${name}`);
    return v;
  };
  listSchema = compiled("ConsoleLowStockList");
  errorSchema = compiled("Error");

  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedConsoleCatalogFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-1069 low stock] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await seedLowStock();
  app = await bootScopedApp(env, ConsoleLowStockModule, undefined, { authLookupPool: env.admin });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-1069 low stock] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function get(session: SessionHeader | null, query: QueryString = ""): request.Test {
  const req = request(app!.getHttpServer()).get(`${PATH}${query}`);
  return session === null ? req : req.set("x-test-session", session);
}

function ok(res: request.Response): LowStockList {
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  expect(res.headers["cache-control"]).toBe("no-store");
  if (!listSchema(res.body)) throw new Error(`contract violation: ${JSON.stringify(listSchema.errors)}`);
  return res.body as LowStockList;
}

function refused(res: request.Response, status: number, code: string): void {
  if (res.status !== status) throw new Error(`expected ${status} ${code}, got ${res.status}: ${JSON.stringify(res.body)}`);
  if (!errorSchema(res.body)) throw new Error(`contract violation: ${JSON.stringify(errorSchema.errors)}`);
  expect((res.body as { error: { code: string } }).error.code).toBe(code);
}

function notFound(res: request.Response): void {
  refused(res, 404, "not_found");
  expect((res.body as { error: object }).error).toEqual(expect.objectContaining(NOT_FOUND));
}

const pairsOf = (body: LowStockList): string[] => body.items.map((i) => `${i.productId}@${i.storeId}`);
const expectedPairs = (keep: (store: StoreId) => boolean): string[] =>
  OWNER_ORDER.filter(([, store]) => keep(store)).map(([p, s]) => `${p}@${s}`);

describe("RT-1069 consoleListLowStock — severity, ordering, counts", () => {
  it("lists the owner's low pairs in contract order with the scope's counts", async () => {
    if (skip()) return;
    const body = ok(await get(SES_OWNER_ALL));
    expect(body).toEqual(
      expect.objectContaining({
        completeness: "received_only",
        storeId: null,
        limit: 10,
        evaluatedCount: 17,
        belowReorderCount: 10,
        criticalCount: 3,
        unknownOnHandCount: 4,
        negativeOnHandCount: 1,
        truncated: false,
      }),
    );
    expect(body.items.map((i) => [i.productId, i.storeId, i.band, i.levelRatio, i.thresholdSource, i.sellableOnHand])).toEqual(
      OWNER_ORDER.map((row) => [...row]),
    );
  });

  it("resolves the levels per pair and reports the store and the unit", async () => {
    if (skip()) return;
    const body = ok(await get(SES_OWNER_ALL));
    const find = (p: ProductId, s: StoreId): Item => {
      const item = body.items.find((i) => i.productId === p && i.storeId === s);
      if (!item) throw new Error(`${p}@${s} not listed`);
      return item;
    };
    expect(find(P2, STORE_A_X)).toEqual(expect.objectContaining({ reorderLevel: "100.0000", criticalLevel: "50.0000", thresholdSource: "store" }));
    expect(find(P2, S_Z)).toEqual(
      expect.objectContaining({ reorderLevel: "3.0000", criticalLevel: null, storeStatus: "inactive", storeName: "RT-1069 Inactive Z" }),
    );
    expect(find(P10, STORE_A_X)).toEqual(expect.objectContaining({ reorderLevel: "4.0000", criticalLevel: "4.0000", thresholdSource: "tenant" }));
    expect(find(P13, STORE_A_Y)).toEqual(expect.objectContaining({ stockingUnit: "kg", storeStatus: "active" }));
    expect(find(P1, STORE_A_X).stockingUnit).toBe("ea");
  });

  it("bounds the list to limit and says it is truncated; the counts stay scope-wide", async () => {
    if (skip()) return;
    const body = ok(await get(SES_OWNER_ALL, "?limit=3"));
    expect(body.limit).toBe(3);
    expect(body.truncated).toBe(true);
    expect(body.belowReorderCount).toBe(10);
    expect(body.criticalCount).toBe(3);
    expect(pairsOf(body)).toEqual(expectedPairs(() => true).slice(0, 3));
    const one = ok(await get(SES_OWNER_ALL, "?limit=1"));
    expect(pairsOf(one)).toEqual([`${P1}@${STORE_A_X}`]);
    expect(ok(await get(SES_OWNER_ALL, "?limit=50")).truncated).toBe(false);
  });

  it("never evaluates a pair without a threshold, an unavailable, inactive or retired product, or a deleted store", async () => {
    if (skip()) return;
    const body = ok(await get(SES_OWNER_ALL, "?limit=50"));
    for (const item of body.items) expect(NEVER_LISTED.has(item.productId)).toBe(false);
    expect(pairsOf(body)).not.toContain(`${P3}@${STORE_A_X}`);
    expect(pairsOf(body)).not.toContain(`${P8}@${STORE_A_X}`);
  });

  it("never lists an unknown or a negative on-hand; they are counted", async () => {
    if (skip()) return;
    const z = ok(await get(SES_OWNER_ALL, `?store_id=${S_Z}`));
    expect(z).toEqual(
      expect.objectContaining({ storeId: S_Z, evaluatedCount: 5, unknownOnHandCount: 4, belowReorderCount: 1, negativeOnHandCount: 0 }),
    );
    // P1, P5, P8 and P10 have no movement at Z: never shown, in particular never as "0.0000".
    expect(pairsOf(z)).toEqual([`${P2}@${S_Z}`]);
    const all = ok(await get(SES_OWNER_ALL, "?limit=50"));
    expect(pairsOf(all)).not.toContain(`${P5}@${STORE_A_X}`);
    for (const item of all.items) expect(item.sellableOnHand.startsWith("-")).toBe(false);
  });

  it("answers a fresh asOf from the read's snapshot", async () => {
    if (skip()) return;
    const before = Date.now();
    const body = ok(await get(SES_OWNER_ALL));
    expect(Date.parse(body.asOf)).toBeGreaterThanOrEqual(before - 5_000);
    expect(Date.parse(body.asOf)).toBeLessThanOrEqual(Date.now() + 5_000);
  });
});

describe("RT-1069 consoleListLowStock — scope and isolation", () => {
  it("store_manager reads only its stores (X + Y), and its active store when narrowed (Y)", async () => {
    if (skip()) return;
    const manager = ok(await get(SES_MANAGER));
    expect(manager).toEqual(
      expect.objectContaining({ evaluatedCount: 12, belowReorderCount: 9, criticalCount: 3, unknownOnHandCount: 0, negativeOnHandCount: 1 }),
    );
    expect(pairsOf(manager)).toEqual(expectedPairs((s) => s !== S_Z));
    const narrowed = ok(await get(SES_MANAGER_ACTIVE));
    expect(narrowed).toEqual(
      expect.objectContaining({ storeId: null, evaluatedCount: 7, belowReorderCount: 5, criticalCount: 0, unknownOnHandCount: 0, negativeOnHandCount: 0 }),
    );
    expect(pairsOf(narrowed)).toEqual(expectedPairs((s) => s === STORE_A_Y));
    notFound(await get(SES_MANAGER, `?store_id=${S_Z}`));
    notFound(await get(SES_MANAGER_ACTIVE, `?store_id=${STORE_A_X}`));
  });

  it("a specific tenant_admin reads only its granted store; store_id narrows the owner", async () => {
    if (skip()) return;
    const admin = ok(await get(SES_ADMIN_SPEC));
    expect(admin).toEqual(expect.objectContaining({ evaluatedCount: 5, belowReorderCount: 4, criticalCount: 3, negativeOnHandCount: 1 }));
    expect(pairsOf(admin)).toEqual(expectedPairs((s) => s === STORE_A_X));
    const x = ok(await get(SES_OWNER_ALL, `?store_id=${STORE_A_X.toUpperCase()}`));
    expect(x.storeId).toBe(STORE_A_X);
    expect(pairsOf(x)).toEqual(expectedPairs((s) => s === STORE_A_X));
    notFound(await get(SES_ADMIN_SPEC, `?store_id=${STORE_A_Y}`));
  });

  it("an empty scope evaluates nothing (no threshold configured in scope)", async () => {
    if (skip()) return;
    const body = ok(await get(SES_ADMIN_EMPTY));
    expect(body).toEqual(
      expect.objectContaining({ evaluatedCount: 0, belowReorderCount: 0, criticalCount: 0, unknownOnHandCount: 0, truncated: false, items: [] }),
    );
  });

  it("never discloses another tenant's stock; a foreign, deleted or absent store is the 404", async () => {
    if (skip()) return;
    const body = ok(await get(SES_OWNER_ALL, "?limit=50"));
    expect(body.items.some((i) => i.productId === PB || i.storeId === STORE_B_X)).toBe(false);
    notFound(await get(SES_OWNER_ALL, `?store_id=${STORE_B_X}`));
    notFound(await get(SES_OWNER_ALL, `?store_id=${S_DELETED}`));
    notFound(await get(SES_OWNER_SPEC, `?store_id=${S_DELETED}`));
    notFound(await get(SES_OWNER_ALL, `?store_id=${NON_EXISTENT}`));
  });

  it("a role outside the list is the same 404 for any input; a bearer is 401", async () => {
    if (skip()) return;
    notFound(await get(SES_STAFF));
    notFound(await get(SES_STAFF, "?limit=0&cursor=x"));
    const bearer = await request(app!.getHttpServer()).get(PATH).set("Authorization", `Bearer ${DASHBOARD_TOKEN}`);
    expect(bearer.status).toBe(401);
    expect((await request(app!.getHttpServer()).get(PATH)).status).toBe(401);
  });
});

describe("RT-1069 consoleListLowStock — query validation", () => {
  it.each([
    ["?limit=0"],
    ["?limit=51"],
    ["?limit=abc"],
    ["?limit=1.5"],
    ["?limit=5&limit=6"],
    ["?store_id=not-a-uuid"],
    [`?store_id=${STORE_A_X}&store_id=${STORE_A_Y}`],
    ["?cursor=abc"],
    ["?page_size=5"],
    ["?unknown=1"],
  ])("%s → 400 validation_error", async (query) => {
    if (skip()) return;
    refused(await get(SES_OWNER_ALL, query), 400, "validation_error");
  });
});
