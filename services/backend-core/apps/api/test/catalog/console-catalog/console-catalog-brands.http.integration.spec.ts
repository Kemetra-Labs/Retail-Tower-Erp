/**
 * RT-1334 (RT-286 spec 048 slice S1) — catalog brands over HTTP against real
 * Postgres (Testcontainers, every migration including 0097, the NOBYPASSRLS
 * `app_test` pool holding only the production grants of
 * `tenant-product-brands.grants.ts`: SELECT, INSERT and UPDATE (name)) and the
 * real module graph (`SessionOnlyAdminGuard`, `TenantContextGuard`,
 * `RolesGuard`, the shared `IdempotencyInterceptor` over a fake Redis). Only
 * cookie authentication is faked: a header names the session.
 *
 * What this proves (RT-1334 acceptance):
 *   - AC1: a tenant creates, renames and lists brands and sets or clears a
 *     product's brand through the Console API; another tenant's brand is never
 *     listed, renamed or assignable (404 / 422), under RLS;
 *   - AC2 (through the API): deleting a brand row leaves its products with no
 *     brand, and the product reads show `brandId: null`;
 *   - roles: the list is owner / tenant_admin / store_manager; the writes are
 *     owner / tenant_admin; store_staff is the non-disclosing 404; a bearer is
 *     401; a cookie write without a trusted Origin is 403;
 *   - the create replays on its `Idempotency-Key` and refuses key reuse; an
 *     active name is unique per tenant (`brand_name_conflict`, naming no
 *     brand); a rename is guarded by `expectedUpdatedAt` (`stale_write`);
 *   - each accepted brand write has exactly one audit row; a refused one none;
 *   - the `brand_id` filter and its cursor binding; a brand-only product change
 *     writes no `catalog_change_log` row (OD-6: not in the POS read-down);
 *   - every body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication, Provider } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";

import { ConsoleCatalogModule } from "../../../src/catalog/console-catalog/console-catalog.module";
import { IDEMPOTENCY_KEY_STORE, IdempotencyInterceptor } from "../../../src/idempotency/idempotency.interceptor";
import { INFLIGHT_REDIS, InProgressMarker } from "../../../src/idempotency/in-progress-marker";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";
import { allContracts, contractDocument } from "../../_helpers/openapi-contract";
import { DASHBOARD_TOKEN, SES_MANAGER, SES_STAFF } from "../../console-sales/__support__/console-sales-fixture";
import { TENANT_A, TENANT_B } from "../__support__/isolation-harness";
import { bootScopedApp, SES_ADMIN_SPEC, SES_OWNER_ALL } from "../erpnext-reconciliation/__support__/read-store-scope";
import { seedConsoleCatalogFixture } from "./__support__/console-catalog-fixture";

type RequestPath = string;
type SessionHeader = string;
type HttpStatus = number;
type ErrorCode = string;
type RedisKey = string;

const BRANDS = "/api/v1/catalog/brands";
const brandPath = (id: string): RequestPath => `${BRANDS}/${id}`;
const PRODUCTS = "/api/v1/catalog/products";
const productPath = (id: string): RequestPath => `${PRODUCTS}/${id}`;
const ORIGIN = "http://127.0.0.1";
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const CONTRACT_ID = "console-catalog";

// `1334` mnemonic, hex only.
const a = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const b = (tag: string): string => `0b000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const ACTOR = a("1334e01");
const BRAND_B = b("1334b01");
const BRAND_RETIRED = a("1334b0f");
const ABSENT = a("1334b99");

class FakeRedis {
  private readonly s = new Map<string, { value: string; expiresAt: number }>();
  async get(k: RedisKey): Promise<string | null> {
    const e = this.s.get(k);
    if (!e || Date.now() > e.expiresAt) return null;
    return e.value;
  }
  async set(k: RedisKey, v: string, o: { px: number }): Promise<unknown> {
    this.s.set(k, { value: v, expiresAt: Date.now() + o.px });
    return "OK";
  }
}
class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
}

interface Brand {
  brandId: string;
  name: string;
  updatedAt: string;
}
interface Summary {
  productId: string;
  brandId: string | null;
  brandName: string | null;
  updatedAt: string;
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
let seq = 0;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
let schemas: Record<"brand" | "brandList" | "detail" | "page" | "error", ValidateFunction>;

beforeAll(async () => {
  ajv.addSchema(contractDocument(allContracts(), CONTRACT_ID) as object, CONTRACT_ID);
  const compiled = (name: string): ValidateFunction => {
    const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
    if (!v) throw new Error(`ajv cannot resolve ${name}`);
    return v;
  };
  schemas = {
    brand: compiled("ConsoleCatalogBrand"),
    brandList: compiled("ConsoleCatalogBrandList"),
    detail: compiled("ConsoleCatalogProductDetail"),
    page: compiled("ConsoleCatalogProductPage"),
    error: compiled("Error"),
  };

  // Only the container start may be skipped (Docker unavailable); every setup
  // step after it is a real failure, even with MIGRATION_TEST_ALLOW_SKIP=1.
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-1334 console-catalog brands] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedConsoleCatalogFixture(env);
  await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt1334-actor@example.test')`, [ACTOR]);
  await env.admin.query(
    `INSERT INTO tenant_product_brands (id, tenant_id, name, retired_at, created_by) VALUES
       ($1, $3, 'RT1334 B brand', NULL, $4),
       ($2, $5, 'RT1334 Retired brand', now(), $4)`,
    [BRAND_B, BRAND_RETIRED, TENANT_B, ACTOR, TENANT_A],
  );
  const redis = new FakeRedis();
  const marker = new FakeMarker();
  const store = new IdempotencyKeyStore({
    redis,
    pgWriter: { async insert(): Promise<void> {} },
    pgReader: { async find(): Promise<null> { return null; } },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  const providers: Provider[] = [
    { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
    { provide: INFLIGHT_REDIS, useValue: redis },
    { provide: InProgressMarker, useValue: marker },
    {
      provide: APP_INTERCEPTOR,
      useValue: new IdempotencyInterceptor(new Reflector(), store, marker as unknown as InProgressMarker),
    },
  ];
  app = await bootScopedApp(env, ConsoleCatalogModule, undefined, { authLookupPool: env.admin, providers });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-1334 console-catalog brands] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function expectValid(validate: ValidateFunction, body: unknown): void {
  if (!validate(body)) throw new Error(`contract violation: ${JSON.stringify(validate.errors)}`);
}

function get(path: RequestPath, session: SessionHeader | null): request.Test {
  const req = request(app!.getHttpServer()).get(path);
  return session === null ? req : req.set("x-test-session", session);
}

function send(method: "post" | "patch", path: RequestPath, session: SessionHeader | null, body: unknown): request.Test {
  const req = request(app!.getHttpServer())[method](path).set("Origin", ORIGIN).send(body as object);
  return session === null ? req : req.set("x-test-session", session);
}

function key(): string {
  seq += 1;
  return `rt1334-key-${String(seq).padStart(8, "0")}-${Date.now()}`;
}

function unique(label: string): string {
  seq += 1;
  return `RT1334 ${label} ${seq}`;
}

function expectStatus(res: request.Response, status: HttpStatus): void {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
}

function refused(res: request.Response, status: HttpStatus, code: ErrorCode): string {
  expectStatus(res, status);
  expectValid(schemas.error, res.body);
  const err = (res.body as { error: { code: string; message: string } }).error;
  expect(err.code).toBe(code);
  return err.message;
}

/** Creates a tenant-A brand through the API as the owner. */
async function createBrand(name: string, session: SessionHeader = SES_OWNER_ALL): Promise<Brand> {
  const res = await send("post", BRANDS, session, { name }).set("Idempotency-Key", key());
  expectStatus(res, 201);
  expect(res.headers["cache-control"]).toBe("no-store");
  expectValid(schemas.brand, res.body);
  return res.body as Brand;
}

/** A fresh tenant-A product (admin pool), so every test owns its rows. */
async function seedProduct(): Promise<string> {
  seq += 1;
  const id = a(`1334${seq.toString(16).padStart(3, "0")}`);
  await env!.admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, default_price, default_currency_code, tax_category, created_by, updated_by)
     VALUES ($1, $2, $3, 1.0000, 'EGP', 'standard', $4, $4)`,
    [id, TENANT_A, `RT1334 product ${seq}`, ACTOR],
  );
  return id;
}

async function detail(productId: string): Promise<{ summary: Summary }> {
  const res = await get(productPath(productId), SES_OWNER_ALL);
  expectStatus(res, 200);
  expectValid(schemas.detail, res.body);
  return res.body as { summary: Summary };
}

async function brandAudits(brandId: string): Promise<{ action: string; actor_user_id: string; metadata: Record<string, unknown> }[]> {
  const r = await env!.admin.query(
    `SELECT action, actor_user_id::text, metadata FROM audit_events
      WHERE action LIKE 'catalog.brand.%' AND target_id = $1::uuid ORDER BY occurred_at, id`,
    [brandId],
  );
  return r.rows as { action: string; actor_user_id: string; metadata: Record<string, unknown> }[];
}

async function changeLogCount(productId: string): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM catalog_change_log WHERE product_id = $1`, [productId]);
  return Number(r.rows[0]!.n);
}

// ===========================================================================
// Auth and roles
// ===========================================================================
describe("console catalog brands — auth, origin and roles", () => {
  it("lists brands for owner, tenant_admin and store_manager; store_staff is the 404 and a bearer is 401", async () => {
    if (skip()) return;
    for (const session of [SES_OWNER_ALL, SES_ADMIN_SPEC, SES_MANAGER]) {
      const res = await get(BRANDS, session);
      expectStatus(res, 200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expectValid(schemas.brandList, res.body);
    }
    const staff = await get(BRANDS, SES_STAFF);
    expect({ status: staff.status, error: staff.body.error }).toEqual({ status: 404, error: expect.objectContaining(NOT_FOUND) });
    const bearer = await request(app!.getHttpServer()).get(BRANDS).set("Authorization", `Bearer ${DASHBOARD_TOKEN}`);
    expect(bearer.status).toBe(401);
  });

  it("limits the brand writes to owner / tenant_admin: store_manager and store_staff get the identical 404 and nothing is written", async () => {
    if (skip()) return;
    const brand = await createBrand(unique("Roles"));
    for (const session of [SES_MANAGER, SES_STAFF]) {
      const create = await send("post", BRANDS, session, { name: unique("Denied") }).set("Idempotency-Key", key());
      expect({ status: create.status, error: create.body.error }).toEqual({ status: 404, error: expect.objectContaining(NOT_FOUND) });
      const rename = await send("patch", brandPath(brand.brandId), session, { expectedUpdatedAt: brand.updatedAt, name: "x" });
      expect({ status: rename.status, error: rename.body.error }).toEqual({ status: 404, error: expect.objectContaining(NOT_FOUND) });
    }
    expect((await env!.admin.query(`SELECT 1 FROM tenant_product_brands WHERE name LIKE 'RT1334 Denied%'`)).rowCount).toBe(0);
    expect(await brandAudits(brand.brandId)).toHaveLength(1);
    // tenant_admin may write.
    await createBrand(unique("By admin"), SES_ADMIN_SPEC);
  });

  it("refuses a cookie write without a trusted Origin with 403 origin_rejected", async () => {
    if (skip()) return;
    const noOrigin = await request(app!.getHttpServer())
      .post(BRANDS)
      .set("Cookie", "dp2_session=rt1334-not-a-session")
      .set("Idempotency-Key", key())
      .send({ name: "x" });
    refused(noOrigin, 403, "origin_rejected");
  });
});

// ===========================================================================
// List, create, rename (AC1)
// ===========================================================================
describe("console catalog brands — list, create and rename", () => {
  it("lists the tenant's active brands by name: never another tenant's, never a retired one, no query keys", async () => {
    if (skip()) return;
    const zed = await createBrand(unique("Zed"));
    const alpha = await createBrand(unique("Alpha"));
    const res = await get(BRANDS, SES_MANAGER);
    expectStatus(res, 200);
    const items = (res.body as { items: Brand[] }).items;
    const ids = items.map((i) => i.brandId);
    expect(ids).toContain(zed.brandId);
    expect(ids).toContain(alpha.brandId);
    expect(ids.indexOf(alpha.brandId)).toBeLessThan(ids.indexOf(zed.brandId));
    expect(ids).not.toContain(BRAND_B);
    expect(ids).not.toContain(BRAND_RETIRED);
    const names = items.map((i) => i.name);
    expect([...names].sort()).toEqual(names);
    refused(await get(`${BRANDS}?tenant_id=${TENANT_B}`, SES_OWNER_ALL), 400, "validation_error");
  });

  it("creates a brand with one audit row, replays the same key and refuses key reuse with another body", async () => {
    if (skip()) return;
    const k = key();
    const name = unique("Nile");
    const first = await send("post", BRANDS, SES_OWNER_ALL, { name }).set("Idempotency-Key", k);
    expectStatus(first, 201);
    expectValid(schemas.brand, first.body);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    const brand = first.body as Brand;
    expect(brand.name).toBe(name);

    const replay = await send("post", BRANDS, SES_OWNER_ALL, { name }).set("Idempotency-Key", k);
    expectStatus(replay, 201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    const rows = await env!.admin.query(`SELECT tenant_id::text, created_by::text FROM tenant_product_brands WHERE name = $1`, [name]);
    expect(rows.rows).toEqual([{ tenant_id: TENANT_A, created_by: expect.any(String) }]);

    refused(await send("post", BRANDS, SES_OWNER_ALL, { name: unique("Other") }).set("Idempotency-Key", k), 409, "idempotency_key_conflict");

    const audits = await brandAudits(brand.brandId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("catalog.brand.create");
    expect(audits[0]!.metadata).toEqual({ brand_id: brand.brandId, new: { name } });
  });

  it("refuses a duplicate active name with a non-disclosing 409 brand_name_conflict; another tenant's name and a retired name are free", async () => {
    if (skip()) return;
    const name = unique("Dup");
    const existing = await createBrand(name);
    const message = refused(await send("post", BRANDS, SES_OWNER_ALL, { name }).set("Idempotency-Key", key()), 409, "brand_name_conflict");
    expect(message).not.toContain(existing.brandId);
    expect(message).not.toContain(name);
    // Exact comparison: another case is another name.
    await createBrand(name.toUpperCase());
    // Tenant B's name and a retired tenant-A name are free.
    await createBrand("RT1334 B brand");
    await createBrand("RT1334 Retired brand");
    expect((await env!.admin.query(`SELECT 1 FROM tenant_product_brands WHERE name = $1`, [name])).rowCount).toBe(1);
  });

  it.each([
    ["a blank name", { name: "   " }],
    ["an empty name", { name: "" }],
    ["a name over 200 code points", { name: "x".repeat(201) }],
    ["a NUL", { name: "a\u0000b" }],
    ["a smuggled tenant id", { name: "RT1334 Smuggled", tenantId: TENANT_B }],
    ["no name", {}],
  ])("refuses a create with %s as 400 validation_error", async (_label, body) => {
    if (skip()) return;
    refused(await send("post", BRANDS, SES_OWNER_ALL, body).set("Idempotency-Key", key()), 400, "validation_error");
  });

  it("refuses a create without an Idempotency-Key", async () => {
    if (skip()) return;
    refused(await send("post", BRANDS, SES_OWNER_ALL, { name: unique("No key") }), 400, "idempotency_key_required");
  });

  it("renames a brand under expectedUpdatedAt with a strictly later updatedAt and one audit row; its products keep it", async () => {
    if (skip()) return;
    const brand = await createBrand(unique("Old"));
    const productId = await seedProduct();
    await env!.admin.query(`UPDATE tenant_products SET brand_id = $2 WHERE id = $1`, [productId, brand.brandId]);
    const name = unique("New");
    const res = await send("patch", brandPath(brand.brandId), SES_ADMIN_SPEC, { expectedUpdatedAt: brand.updatedAt, name });
    expectStatus(res, 200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expectValid(schemas.brand, res.body);
    const renamed = res.body as Brand;
    expect(renamed).toMatchObject({ brandId: brand.brandId, name });
    expect(Date.parse(renamed.updatedAt)).toBeGreaterThan(Date.parse(brand.updatedAt));

    // The retried rename is stale, never a second write.
    refused(await send("patch", brandPath(brand.brandId), SES_ADMIN_SPEC, { expectedUpdatedAt: brand.updatedAt, name }), 409, "stale_write");
    // A rename to the same name is accepted and still advances updatedAt.
    const same = await send("patch", brandPath(brand.brandId), SES_ADMIN_SPEC, { expectedUpdatedAt: renamed.updatedAt, name });
    expectStatus(same, 200);
    expect(Date.parse((same.body as Brand).updatedAt)).toBeGreaterThan(Date.parse(renamed.updatedAt));

    expect((await detail(productId)).summary).toMatchObject({ brandId: brand.brandId, brandName: name });
    const audits = await brandAudits(brand.brandId);
    expect(audits.map((x) => x.action)).toEqual(["catalog.brand.create", "catalog.brand.rename", "catalog.brand.rename"]);
    expect(audits[1]!.metadata).toEqual({ brand_id: brand.brandId, old: { name: brand.name }, new: { name } });
  });

  it("refuses a rename to another active brand's name with 409 brand_name_conflict and writes nothing", async () => {
    if (skip()) return;
    const taken = await createBrand(unique("Taken"));
    const brand = await createBrand(unique("Mine"));
    refused(
      await send("patch", brandPath(brand.brandId), SES_OWNER_ALL, { expectedUpdatedAt: brand.updatedAt, name: taken.name }),
      409,
      "brand_name_conflict",
    );
    const row = await env!.admin.query<{ name: string }>(`SELECT name FROM tenant_product_brands WHERE id = $1`, [brand.brandId]);
    expect(row.rows).toEqual([{ name: brand.name }]);
    expect(await brandAudits(brand.brandId)).toHaveLength(1);
  });

  it("answers another tenant's, a retired and an absent brand with the identical 404, and a malformed id with 400", async () => {
    if (skip()) return;
    const at = new Date().toISOString();
    for (const id of [BRAND_B, BRAND_RETIRED, ABSENT]) {
      const res = await send("patch", brandPath(id), SES_OWNER_ALL, { expectedUpdatedAt: at, name: unique("Hijack") });
      expect({ id, status: res.status, error: res.body.error }).toEqual({ id, status: 404, error: expect.objectContaining(NOT_FOUND) });
    }
    const b2 = await env!.admin.query<{ name: string }>(`SELECT name FROM tenant_product_brands WHERE id = $1`, [BRAND_B]);
    expect(b2.rows).toEqual([{ name: "RT1334 B brand" }]);
    refused(await send("patch", brandPath("not-a-uuid"), SES_OWNER_ALL, { expectedUpdatedAt: at, name: "x" }), 400, "validation_error");
    refused(await send("patch", brandPath(ABSENT), SES_OWNER_ALL, { name: "x" }), 400, "validation_error");
  });
});

// ===========================================================================
// A product's brand (AC1, AC2, OD-6)
// ===========================================================================
describe("console catalog brands — a product's brand", () => {
  it("creates a product with a brand, sets, changes and clears it, audited on the product, with no POS change-log row", async () => {
    if (skip()) return;
    const nile = await createBrand(unique("Nile"));
    const delta = await createBrand(unique("Delta"));
    const created = await send("post", PRODUCTS, SES_OWNER_ALL, {
      name: unique("Branded water"),
      taxCategory: "standard",
      brandId: nile.brandId.toUpperCase(),
    }).set("Idempotency-Key", key());
    expectStatus(created, 201);
    expectValid(schemas.detail, created.body);
    const product = created.body as { summary: Summary };
    expect(product.summary).toMatchObject({ brandId: nile.brandId, brandName: nile.name });
    const id = product.summary.productId;
    const logAtCreate = await changeLogCount(id);

    const changed = await send("patch", productPath(id), SES_OWNER_ALL, {
      expectedUpdatedAt: product.summary.updatedAt,
      brandId: delta.brandId,
    });
    expectStatus(changed, 200);
    const after = changed.body as { summary: Summary };
    expect(after.summary).toMatchObject({ brandId: delta.brandId, brandName: delta.name });

    const cleared = await send("patch", productPath(id), SES_OWNER_ALL, {
      expectedUpdatedAt: after.summary.updatedAt,
      brandId: null,
    });
    expectStatus(cleared, 200);
    expect((cleared.body as { summary: Summary }).summary).toMatchObject({ brandId: null, brandName: null });

    // OD-6: the brand is not in the POS read-down, so a brand-only change logs nothing.
    expect(await changeLogCount(id)).toBe(logAtCreate);
    const audits = await env!.admin.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_events WHERE target_id = $1::uuid ORDER BY occurred_at, id`,
      [id],
    );
    expect(audits.rows.map((r) => r.action)).toEqual(["catalog.product.create", "catalog.product.update", "catalog.product.update"]);
    expect(audits.rows[0]!.metadata).toMatchObject({ new: { brandId: nile.brandId } });
    expect(audits.rows[1]!.metadata).toMatchObject({ old: { brandId: nile.brandId }, new: { brandId: delta.brandId } });
    expect(audits.rows[2]!.metadata).toMatchObject({ old: { brandId: delta.brandId }, new: { brandId: null } });
  });

  it("refuses another tenant's, a retired and an absent brand with 422 brand_unavailable, on create and update, writing nothing", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const before = (await detail(id)).summary;
    for (const brandId of [BRAND_B, BRAND_RETIRED, ABSENT]) {
      const name = unique("Refused");
      refused(
        await send("post", PRODUCTS, SES_OWNER_ALL, { name, taxCategory: "standard", brandId }).set("Idempotency-Key", key()),
        422,
        "brand_unavailable",
      );
      expect((await env!.admin.query(`SELECT 1 FROM tenant_products WHERE name = $1`, [name])).rowCount).toBe(0);
      refused(
        await send("patch", productPath(id), SES_OWNER_ALL, { expectedUpdatedAt: before.updatedAt, brandId }),
        422,
        "brand_unavailable",
      );
    }
    expect((await detail(id)).summary).toEqual(before);
    expect((await env!.admin.query(`SELECT 1 FROM audit_events WHERE target_id = $1::uuid`, [id])).rowCount).toBe(0);
  });

  it("shows a retired brand's name on its products, and filters the list by brand with a brand-bound cursor", async () => {
    if (skip()) return;
    const brand = await createBrand(unique("Filter"));
    const p1 = await seedProduct();
    const p2 = await seedProduct();
    await seedProduct(); // no brand: never in the filtered list
    await env!.admin.query(`UPDATE tenant_products SET brand_id = $2 WHERE id = ANY($1::uuid[])`, [[p1, p2], brand.brandId]);

    const first = await get(`${PRODUCTS}?brand_id=${brand.brandId.toUpperCase()}&limit=1`, SES_MANAGER);
    expectStatus(first, 200);
    expectValid(schemas.page, first.body);
    const page1 = first.body as { items: Summary[]; nextCursor: string | null };
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const cursor = encodeURIComponent(page1.nextCursor!);
    const second = await get(`${PRODUCTS}?brand_id=${brand.brandId}&limit=1&cursor=${cursor}`, SES_MANAGER);
    expectStatus(second, 200);
    const page2 = second.body as { items: Summary[]; nextCursor: string | null };
    expect([...page1.items, ...page2.items].map((i) => i.productId).sort()).toEqual([p1, p2].sort());
    for (const item of [...page1.items, ...page2.items]) expect(item).toMatchObject({ brandId: brand.brandId, brandName: brand.name });
    // The cursor is bound to the brand filter.
    refused(await get(`${PRODUCTS}?limit=1&cursor=${cursor}`, SES_MANAGER), 400, "validation_error");

    // Another tenant's brand matches nothing (an empty 200, never a 404).
    const other = await get(`${PRODUCTS}?brand_id=${BRAND_B}&status=any`, SES_OWNER_ALL);
    expectStatus(other, 200);
    expect(other.body).toEqual({ items: [], nextCursor: null });
    refused(await get(`${PRODUCTS}?brand_id=nike`, SES_OWNER_ALL), 400, "validation_error");

    // A retired brand still names its products.
    await env!.admin.query(`UPDATE tenant_product_brands SET retired_at = now() WHERE id = $1`, [brand.brandId]);
    expect((await detail(p1)).summary).toMatchObject({ brandId: brand.brandId, brandName: brand.name });
  });

  it("AC2: deleting a brand leaves its products with no brand, and the reads show it", async () => {
    if (skip()) return;
    const brand = await createBrand(unique("Deleted"));
    const p1 = await seedProduct();
    await env!.admin.query(`UPDATE tenant_products SET brand_id = $2 WHERE id = $1`, [p1, brand.brandId]);
    expect((await detail(p1)).summary.brandId).toBe(brand.brandId);
    // No runtime deletes a brand (no DELETE policy); a superuser maintenance delete does.
    await env!.admin.query(`DELETE FROM tenant_product_brands WHERE id = $1`, [brand.brandId]);
    expect((await detail(p1)).summary).toMatchObject({ productId: p1, brandId: null, brandName: null });
    const list = await get(`${PRODUCTS}?brand_id=${brand.brandId}`, SES_OWNER_ALL);
    expect(list.body).toEqual({ items: [], nextCursor: null });
  });
});
