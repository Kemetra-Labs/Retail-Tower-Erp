/**
 * RT-1353 — no ERP posting row is enqueued for a restricted tenant.
 *
 * `PostingRequestedConsumer.handle()` is where an `erpnext.posting.requested`
 * outbox event becomes a posting row (the job the Connector feed later offers).
 * While the tenant's access state is `restricted` (`tenant_access_entitlements`,
 * 0105) it creates nothing and throws the typed, retryable
 * `TenantAccessRestrictedError`: the outbox row is neither marked delivered nor
 * dropped, so the event is re-delivered and creates the row once the tenant is
 * `unrestricted`. A tenant with no stored state (every existing tenant) is
 * unaffected, and another tenant's restriction never blocks this tenant.
 *
 * Docker policy mirrors the other worker DB specs: HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import {
  PostingRequestedConsumer,
  TenantAccessRestrictedError,
} from "../../src/erpnext-posting/posting-requested.consumer";
import type { OutboxEventEnvelope } from "@data-pulse-2/shared";

const TENANT = "01900000-0000-7000-8000-0000001353a1";
const OTHER_TENANT = "01900000-0000-7000-8000-0000001353a2";
const STORE = "01900000-0000-7000-8000-0000001353c1";
const ACTOR = "01900000-0000-7000-8000-0000001353d1";
const TPRODUCT = "01900000-0000-7000-8000-0000001353e1";
const saleId = (n: number): string => `01900000-0000-7000-8000-0000001353f${n}`;
const PAYLOAD_HASH = "b".repeat(64);

let env: PgTestEnv | null = null;
let skip = false;

async function seedBase(e: PgTestEnv): Promise<void> {
  const a = e.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
       ($1, 'rt1353-a', 'RT1353 A', 'USD'), ($2, 'rt1353-b', 'RT1353 B', 'USD')`,
    [TENANT, OTHER_TENANT],
  );
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'R13', 'Mapped')`, [STORE, TENANT]);
  await a.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'rt1353@fixture.invalid', NULL)`, [ACTOR]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, 'Widget', 'standard', $3, $3)`,
    [TPRODUCT, TENANT, ACTOR],
  );
  await a.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-1353', 'confirmed', 'manual', $3, now())`,
    [TENANT, TPRODUCT, ACTOR],
  );
  await a.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH-1353', $3, 1)`,
    [TENANT, STORE, ACTOR],
  );
  // One sale per test (n = 1..4): posting rows are never deleted (frozen resolutions reference them).
  for (const n of [1, 2, 3, 4]) {
    await a.query(
      `INSERT INTO sales
         (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date, source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, 'USD', 5.00, now(), '2026-06-01', 'pos-1353', $4, $5, $6)`,
      [saleId(n), TENANT, STORE, `s-1353-${n}`, PAYLOAD_HASH, ACTOR],
    );
    await a.query(
      `INSERT INTO sale_lines
         (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity, line_amount, tax_amount, unit, tenant_product_ref)
       VALUES (gen_random_uuid(), $1, $2, $3, 'Widget', 5.0000, 'USD', 1.000000, 5.0000, 0.0000, 'ea', $4)`,
      [saleId(n), TENANT, STORE, TPRODUCT],
    );
  }
}

function salePostEvent(n: number): Parameters<PostingRequestedConsumer["handle"]>[0] {
  const eventId = `01900000-0000-7000-8000-0000001353b${n}`;
  const sale = saleId(n);
  const event: OutboxEventEnvelope = {
    event_id: eventId,
    event_type: "erpnext.posting.requested",
    tenant_id: TENANT,
    store_id: null,
    payload: { sale_id: sale, store_id: STORE, kind: "sale_post", source_ref_id: sale },
    correlation_id: null,
    attempts: 1,
    occurred_at: new Date("2026-06-01T00:00:00.000Z"),
  };
  return event as Parameters<PostingRequestedConsumer["handle"]>[0];
}

function guard(): PgTestEnv {
  if (!env) throw new Error("Docker unavailable");
  return env;
}

const postingRows = async (n: number): Promise<number> =>
  (await guard().admin.query(`SELECT 1 FROM erpnext_posting_status WHERE tenant_id = $1 AND sale_id = $2`, [TENANT, saleId(n)]))
    .rowCount ?? 0;

const restrict = (tenantId: string): Promise<unknown> =>
  guard().admin.query(`INSERT INTO tenant_access_entitlements (tenant_id, state) VALUES ($1, 'restricted')`, [tenantId]);

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedBase(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-requested-restricted.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (skip || !env) return;
  await env.admin.query(`DELETE FROM tenant_access_entitlements`);
});

describe("PostingRequestedConsumer.handle — RT-1353 restricted tenant", () => {
  it("creates the posting row for a tenant with no stored state (every existing tenant, unchanged)", async () => {
    if (skip) return;
    await new PostingRequestedConsumer(guard().app).handle(salePostEvent(1));
    expect(await postingRows(1)).toBe(1);
  });

  it("creates nothing and throws the typed retryable error while the tenant is restricted", async () => {
    if (skip) return;
    await restrict(TENANT);
    const consumer = new PostingRequestedConsumer(guard().app);
    await expect(consumer.handle(salePostEvent(2))).rejects.toBeInstanceOf(
      TenantAccessRestrictedError,
    );
    expect(await postingRows(2)).toBe(0);
  });

  it("the same event creates its row once the tenant is unrestricted (held, never dropped)", async () => {
    if (skip) return;
    await restrict(TENANT);
    const consumer = new PostingRequestedConsumer(guard().app);
    const event = salePostEvent(3);
    await expect(consumer.handle(event)).rejects.toBeInstanceOf(TenantAccessRestrictedError);
    await guard().admin.query(`DELETE FROM tenant_access_entitlements WHERE tenant_id = $1`, [TENANT]);
    await consumer.handle(event);
    expect(await postingRows(3)).toBe(1);
  });

  it("another tenant's restriction never blocks this tenant", async () => {
    if (skip) return;
    await restrict(OTHER_TENANT);
    await new PostingRequestedConsumer(guard().app).handle(salePostEvent(4));
    expect(await postingRows(4)).toBe(1);
  });
});
