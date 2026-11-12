/**
 * RT-1353 — the ERP posting feed sends nothing for a restricted tenant.
 *
 * `ErpnextPostingService.pullPostings` offers a tenant's pending rows to the
 * Connector. While the tenant's access state is `restricted`
 * (`tenant_access_entitlements`, 0105) its pending rows are HELD: the page is
 * empty and the cursor does not move. The rows stay pending and are offered
 * again, unchanged, once the tenant is `unrestricted`. A tenant with no row
 * (every existing tenant) is unaffected, and another tenant's restriction
 * never holds this tenant's rows.
 *
 * Docker policy mirrors the feed specs: HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1.
 */
import { ErpnextPostingService } from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ACTOR_A, STORE_A_X, TENANT_B } from "../../__support__/isolation-harness";
import { SALE_A_X } from "../../sales/__support__/seed-sales";
import {
  POSTING_STATUS_FIXTURE_IDS,
  POST_A_PENDING,
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

let env: PgTestEnv | null = null;
let skip = false;

const TENANT_A = POSTING_STATUS_FIXTURE_IDS.tenantA;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
    // Make SALE_A_X's line resolvable, as the posting-feed spec does.
    const a = env.admin;
    const TPROD = "01900000-0000-7000-8000-0000000a7e53";
    await a.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, 'RT1353 Widget', 'standard', $3, $3) ON CONFLICT (id) DO NOTHING`,
      [TPROD, TENANT_A, ACTOR_A],
    );
    await a.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE sale_id = $2`, [TPROD, SALE_A_X]);
    await a.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-1353', 'confirmed', 'manual', $3, now()) ON CONFLICT DO NOTHING`,
      [TENANT_A, TPROD, ACTOR_A],
    );
    await a.query(
      `INSERT INTO erpnext_warehouse_map
         (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH-1353', $3, 1) ON CONFLICT DO NOTHING`,
      [TENANT_A, STORE_A_X, ACTOR_A],
    );
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-feed-restricted.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (env) await env.admin.query(`DELETE FROM tenant_access_entitlements`);
});

function svc(): ErpnextPostingService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextPostingService(env.app);
}

async function restrict(tenantId: string): Promise<void> {
  await env!.admin.query(`INSERT INTO tenant_access_entitlements (tenant_id, state) VALUES ($1, 'restricted')`, [tenantId]);
}

const offeredRefs = async (tenantId: string): Promise<string[]> =>
  (await svc().pullPostings({ tenantId, since: null, limit: 100 })).items.map((i) => i.workItemRef);

describe("ErpnextPostingService.pullPostings — RT-1353 restricted tenant", () => {
  it("offers a tenant with no stored state its pending row (every existing tenant, unchanged)", async () => {
    if (skip) return;
    expect(await offeredRefs(TENANT_A)).toContain(POST_A_PENDING);
  });

  it("offers nothing while the tenant is restricted, and the cursor does not move", async () => {
    if (skip) return;
    await restrict(TENANT_A);
    const page = await svc().pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
    expect(page.items).toEqual([]);
    expect(page.cursor).toBeNull();
    expect(page.nextPageToken).toBeNull();
    // Held, not dropped: the row is still pending.
    const row = await env!.admin.query<{ status: string }>(`SELECT status FROM erpnext_posting_status WHERE id = $1`, [POST_A_PENDING]);
    expect(row.rows[0]!.status).toBe("pending");
  });

  it("offers the same row again once the tenant is unrestricted", async () => {
    if (skip) return;
    await restrict(TENANT_A);
    expect(await offeredRefs(TENANT_A)).toEqual([]);
    await env!.admin.query(`DELETE FROM tenant_access_entitlements WHERE tenant_id = $1`, [TENANT_A]);
    expect(await offeredRefs(TENANT_A)).toContain(POST_A_PENDING);
  });

  it("another tenant's restriction never holds this tenant's rows", async () => {
    if (skip) return;
    await restrict(TENANT_B);
    expect(await offeredRefs(TENANT_A)).toContain(POST_A_PENDING);
  });
});
