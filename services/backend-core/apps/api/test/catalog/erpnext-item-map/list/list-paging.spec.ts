/**
 * RT-1458 (audit A-17) — keyset paging of `GET /api/v1/catalog/erpnext-item-mappings`
 * (`tenantAdminListErpnextItemMappings`). Real Postgres (RLS as the runtime role), real controller
 * and service; guards are stubbed like the other 013 HTTP specs.
 *
 * Order is `suggested_at DESC, id` (id ascending). The seed makes three rows share one
 * `suggested_at` to the microsecond and a fourth differ by ONE microsecond, so a page boundary
 * inside the tie and a cursor that lost sub-millisecond precision both fail here.
 *
 *   - first page / next page / last page, and a walk that equals the full list exactly once
 *   - limit equal to the row count (no phantom next page)
 *   - `state` combined with the cursor
 *   - no `limit` (PR 3c): the default page of 100 and a `nextCursor` to the rest; the tenant has more than
 *     100 active rows here (a bulk seed), so the default is what bounds the response
 *   - invalid cursor / limit are 400
 *   - a cursor never crosses tenants (RLS scopes the continuation)
 */
import "reflect-metadata";

import { type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { AUDIT_JOB_ENQUEUER } from "../../../../src/audit/audit-job.enqueuer";
import { PG_POOL } from "../../../../src/database";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { ErpnextItemMapController } from "../../../../src/catalog/erpnext-item-map/erpnext-item-map.controller";
import { ErpnextItemMapService } from "../../../../src/catalog/erpnext-item-map/erpnext-item-map.service";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { encodeOpaque } from "../../../../src/common/cursor/opaque-cursor";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../../src/context/types";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ITEM_MAP_FIXTURE_IDS, MAP_B_CONFIRMED, seedItemMapFixture } from "../__support__/seed-item-map";

const TENANT_A = ITEM_MAP_FIXTURE_IDS.tenantA;
const TENANT_B = ITEM_MAP_FIXTURE_IDS.tenantB;
const ACTOR_A = ITEM_MAP_FIXTURE_IDS.actorA;
const BASE_URL = "/api/v1/catalog/erpnext-item-mappings";

const mapId = (n: number): string => `0c000000-0000-7000-8000-00000d145${String(n).padStart(3, "0")}`;
const productId = (n: number): string => `0a000000-0000-7000-8000-00000d145${String(n).padStart(3, "0")}`;
/** The default page size when `limit` is absent (the contract's `default`). */
const DEFAULT_LIMIT = 100;
/** Rows added in bulk so the tenant has more active mappings than one default page. */
const BULK_FIRST = 101;
const BULK_COUNT = 105;

/** [n, suggested_at, state] — n 1..3 tie to the microsecond, 4 is one microsecond newer. */
const SEEDED: ReadonlyArray<readonly [number, string, "suggested" | "confirmed"]> = [
  [1, "2026-03-01T00:00:00.000001Z", "suggested"],
  [2, "2026-03-01T00:00:00.000001Z", "confirmed"],
  [3, "2026-03-01T00:00:00.000001Z", "suggested"],
  [4, "2026-03-01T00:00:00.000002Z", "suggested"],
  [5, "2026-02-01T00:00:00.000000Z", "confirmed"],
  [6, "2026-02-01T00:00:00.000000Z", "suggested"],
  [7, "2026-01-01T00:00:00.000000Z", "confirmed"],
];
/** The seeded rows in wire order: newest first, ties by ascending id. */
const SEEDED_ORDER = [4, 1, 2, 3, 5, 6, 7].map(mapId);
const RETIRED_ID = mapId(8);

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext; principal?: { userId?: string } }>();
    req.context = {
      userId: ACTOR_A,
      tenantId: this.tenantId,
      storeId: null,
      isPlatformAdmin: false,
      source: "session",
    };
    req.principal = { userId: ACTOR_A };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[list-paging.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedItemMapFixture(env);

  for (let n = 1; n <= 8; n++) {
    await env.admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, $3, 'standard', $4, $4)`,
      [productId(n), TENANT_A, `RT-1458 paging widget ${n}`, ACTOR_A],
    );
  }
  for (const [n, at, state] of SEEDED) {
    await env.admin.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source,
          suggested_by, suggested_at, confirmed_by, confirmed_at, version)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7::timestamptz, $8, $9, 1)`,
      [
        mapId(n),
        TENANT_A,
        productId(n),
        `ERP-PAGING-${n}`,
        state,
        ACTOR_A,
        at,
        state === "confirmed" ? ACTOR_A : null,
        state === "confirmed" ? at : null,
      ],
    );
  }
  // A retired row, newer than every seeded one: it must never appear on any page.
  await env.admin.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source,
        suggested_by, suggested_at, version, retired_at)
     VALUES ($1, $2, $3, 'ERP-PAGING-RETIRED', 'suggested', 'manual', $4, '2026-04-01T00:00:00Z', 1, now())`,
    [RETIRED_ID, TENANT_A, productId(8), ACTOR_A],
  );

  // BULK_COUNT more suggested rows, all older than the seeded ones (one second apart, ids ascending).
  await env.admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     SELECT ('0a000000-0000-7000-8000-00000d145' || lpad(n::text, 3, '0'))::uuid, $1, 'RT-1458 bulk widget ' || n,
            'standard', $2, $2
       FROM generate_series($3::int, $3::int + $4::int - 1) AS n`,
    [TENANT_A, ACTOR_A, BULK_FIRST, BULK_COUNT],
  );
  await env.admin.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, suggested_by, suggested_at, version)
     SELECT ('0c000000-0000-7000-8000-00000d145' || lpad(n::text, 3, '0'))::uuid, $1,
            ('0a000000-0000-7000-8000-00000d145' || lpad(n::text, 3, '0'))::uuid, 'ERP-BULK-' || n,
            'suggested', 'manual', $2, '2025-01-01T00:00:00Z'::timestamptz + (n || ' seconds')::interval, 1
       FROM generate_series($3::int, $3::int + $4::int - 1) AS n`,
    [TENANT_A, ACTOR_A, BULK_FIRST, BULK_COUNT],
  );

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  const moduleRef = await Test.createTestingModule({
    controllers: [ErpnextItemMapController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ErpnextItemMapService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: { enqueue: async () => undefined } },
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(contextGuard);
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  if (!dockerSkipped) contextGuard.tenantId = TENANT_A;
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

interface Page {
  items: Array<{ id: string; state: string }>;
  nextCursor: string | null;
}

async function getPage(query: Record<string, string | number>): Promise<Page> {
  const res = await http().get(BASE_URL).query(query);
  expect(res.status).toBe(200);
  return res.body as Page;
}

/** Follow `nextCursor` until null; returns every page. */
async function walk(query: Record<string, string | number>): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const page: Page = await getPage(cursor === null ? query : { ...query, cursor });
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null && pages.length < 400);
  return pages;
}

/** The oracle: what the table says the tenant's active list is, in wire order. */
async function activeOrder(tenantId: string, state?: string): Promise<string[]> {
  if (!env) throw new Error("env not initialised");
  const { rows } = await env.admin.query<{ id: string }>(
    `SELECT id FROM erpnext_item_map
      WHERE tenant_id = $1 AND retired_at IS NULL AND ($2::text IS NULL OR state = $2)
      ORDER BY suggested_at DESC, id`,
    [tenantId, state ?? null],
  );
  return rows.map((r) => r.id);
}

const SEEDED_IDS = new Set(SEEDED_ORDER);
const seeded = (ids: string[]): string[] => ids.filter((id) => SEEDED_IDS.has(id));

describe("RT-1458 A-17 — GET erpnext-item-mappings keyset paging", () => {
  it("first page, next page and last page of limit=3", async () => {
    if (dockerSkipped) return;
    const total = (await activeOrder(TENANT_A)).length;
    const pages = await walk({ limit: 3 });
    expect(pages).toHaveLength(Math.ceil(total / 3));
    pages.slice(0, -1).forEach((p) => {
      expect(p.items).toHaveLength(3);
      expect(typeof p.nextCursor).toBe("string");
    });
    expect(pages[pages.length - 1]?.nextCursor).toBeNull();
    expect(pages[pages.length - 1]?.items.length).toBeGreaterThan(0);
  });

  it("a walk returns every active mapping exactly once, in (suggested_at DESC, id) order", async () => {
    if (dockerSkipped) return;
    for (const limit of [1, 2, 3, 5]) {
      const ids = (await walk({ limit })).flatMap((p) => p.items.map((i) => i.id));
      expect(ids).toEqual(await activeOrder(TENANT_A));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(RETIRED_ID);
      // The microsecond-newer row leads the tie, and the tie breaks by ascending id.
      expect(seeded(ids)).toEqual(SEEDED_ORDER);
    }
  });

  it("a limit equal to the row count returns everything and no next page", async () => {
    if (dockerSkipped) return;
    const order = await activeOrder(TENANT_A);
    const page = await getPage({ limit: order.length });
    expect(page.items.map((i) => i.id)).toEqual(order);
    expect(page.nextCursor).toBeNull();
    const over = await getPage({ limit: 500 });
    expect(over.items).toHaveLength(order.length);
    expect(over.nextCursor).toBeNull();
  });

  it("state=suggested combined with the cursor pages only the review queue", async () => {
    if (dockerSkipped) return;
    for (const state of ["suggested", "confirmed"]) {
      const pages = await walk({ state, limit: 2 });
      const items = pages.flatMap((p) => p.items);
      expect(items.every((i) => i.state === state)).toBe(true);
      expect(items.map((i) => i.id)).toEqual(await activeOrder(TENANT_A, state));
    }
  });

  it("without `limit` it returns the default page of 100 and a nextCursor, and the cursor reaches the rest", async () => {
    if (dockerSkipped) return;
    const order = await activeOrder(TENANT_A);
    expect(order.length).toBeGreaterThan(DEFAULT_LIMIT);
    const first = await getPage({});
    expect(first.items.map((i) => i.id)).toEqual(order.slice(0, DEFAULT_LIMIT));
    expect(typeof first.nextCursor).toBe("string");
    const rest = await getPage({ cursor: first.nextCursor as string });
    expect(rest.items.map((i) => i.id)).toEqual(order.slice(DEFAULT_LIMIT));
    expect(rest.nextCursor).toBeNull();
  });

  it("an explicit limit still wins over the default, up to 500", async () => {
    if (dockerSkipped) return;
    const order = await activeOrder(TENANT_A);
    const page = await getPage({ limit: 500 });
    expect(page.items.map((i) => i.id)).toEqual(order);
    expect(page.nextCursor).toBeNull();
    expect((await getPage({ limit: 7 })).items).toHaveLength(7);
  });

  it("a cursor without `limit` returns one default page after that row", async () => {
    if (dockerSkipped) return;
    const first = await getPage({ limit: 2 });
    const next = await getPage({ cursor: first.nextCursor as string });
    const order = await activeOrder(TENANT_A);
    expect(next.items.map((i) => i.id)).toEqual(order.slice(2, 2 + DEFAULT_LIMIT));
    expect(next.nextCursor).not.toBeNull();
  });

  it("rejects a cursor this operation did not issue with 400 validation_error", async () => {
    if (dockerSkipped) return;
    const bad = [
      "not-a-cursor",
      Buffer.from("hello").toString("base64url"),
      encodeOpaque({ s: "2026-03-01T00:00:00.000Z", i: mapId(1) }),
      encodeOpaque({ s: "2026-03-01T00:00:00.000001Z", i: "nope" }),
      encodeOpaque({ x: 1 }),
    ];
    for (const cursor of bad) {
      const res = await http().get(BASE_URL).query({ limit: 2, cursor });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    }
  });

  it("rejects an out-of-range or non-integer limit with 400", async () => {
    if (dockerSkipped) return;
    for (const limit of ["0", "-1", "501", "abc", "1.5"]) {
      const res = await http().get(BASE_URL).query({ limit });
      expect(res.status).toBe(400);
    }
  });

  it("a cursor never crosses tenants: tenant B continues only its own list", async () => {
    if (dockerSkipped) return;
    const first = await getPage({ limit: 2 });
    contextGuard.tenantId = TENANT_B;
    const page = await getPage({ limit: 2, cursor: first.nextCursor as string });
    const ids = page.items.map((i) => i.id);
    expect(ids.every((id) => !SEEDED_ORDER.includes(id))).toBe(true);
    expect(ids).not.toContain(RETIRED_ID);
    expect(ids.length).toBeLessThanOrEqual(1);
    expect(ids.every((id) => id === MAP_B_CONFIRMED)).toBe(true);
  });
});
