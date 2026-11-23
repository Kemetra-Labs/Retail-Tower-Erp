/**
 * RT-1485 PR-16a-2a — the initial legacy price import against real Postgres (Testcontainers, every
 * migration including 0121, 0123 and 0132). It runs as the NOBYPASSRLS `app_test` role through the
 * CLI wiring (`runFromEnv`: the tenant pin and `app.system_privilege = 'pricing_legacy_import'`),
 * with that role's grants on the authority and run tables cut to the production fragment
 * (`pricing-authority.grants.ts`).
 *
 * What this proves (spec 044 §4.1–§4.4, MC-1, MC-2, MC-10): the Book and default Zone from the
 * declared inputs; one `legacy_import` set published as revision 1 with one event per accepted
 * legacy row (book and store scope, `store_local`, open-ended, the MC-1 starts); exceptions
 * reported and not imported; retired and price-less rows ignored; the fan-out; the watermark row
 * and the audit rows; a re-run with no legacy change writes no revision; a changed legacy price
 * is refused as a pending delta; refusals for a multi-currency tenant, a non-legacy authority, a
 * non-empty price_history, a Book mismatch and a missing reference zone; a tenant with no price
 * gets its Book and no revision; a dry run writes nothing; without the system privilege 0123
 * refuses the `legacy_import` set.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { GRANTS as AUTHORITY_GRANTS } from "../../src/auth/grants/pricing-authority.grants";
import { runFromEnv } from "../../src/cli/pricing-legacy-import";
import type { ParsedArgs } from "../../src/cli/pricing-legacy-import/cli";
import { runLegacyImport, type LegacyImportResult } from "../../src/pricing";
import {
  APP_ROLE_NAME,
  APP_ROLE_PASSWORD,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const id = (tag: string): string => `0e000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const ACTOR = id("1485ac");
const T1 = id("1485a1");
const T2 = id("1485a2");
const T3 = id("1485a3");
const T4 = id("1485a4");
const T5 = id("1485a5");
const T6 = id("1485a6");
const S_CAIRO = id("1485c1");
const S_LONDON_INACTIVE = id("1485c2");
const S_T2 = id("1485c3");
const P = { priced: id("1485d1"), zero: id("1485d2"), subMinor: id("1485d3"), unpriced: id("1485d4"), retired: id("1485d5") } as const;
const P_T2 = id("1485d6");
const P_T5 = id("1485d7");
const AT = new Date("2026-11-23T10:00:00.000Z");

let env: PgTestEnv | null = null;
let dockerSkipped = false;

const admin = (): Pool => env!.admin;

async function cutGrantsToFragment(): Promise<void> {
  const statements = ["tenant_pricing_authority", "pricing_import_runs", "pricing_cutover_runs"].map((t) => `REVOKE ALL ON ${t} FROM ${APP_ROLE_NAME}`);
  for (const [table, privilege] of AUTHORITY_GRANTS.domainRequired) statements.push(`GRANT ${privilege} ON ${table} TO ${APP_ROLE_NAME}`);
  await admin().query(statements.join(";\n"));
}

async function seedTenant(tenant: string, slug: string): Promise<void> {
  await admin().query(`INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, $2, $2, 'EGP')`, [tenant, slug]);
}

async function seedStore(tenant: string, store: string, code: string, timezone: string, active = true): Promise<void> {
  await admin().query(`INSERT INTO stores (id, tenant_id, code, name, timezone, is_active) VALUES ($1, $2, $3, $3, $4, $5)`, [store, tenant, code, timezone, active]);
}

async function seedProduct(tenant: string, product: string, price: string | null, currency = "EGP", retired = false): Promise<void> {
  await admin().query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, default_price, default_currency_code, retired_at, created_by, updated_by)
     VALUES ($1::uuid, $2::uuid, $7::text, 'standard', $3::numeric, CASE WHEN $3::numeric IS NULL THEN NULL ELSE $4::char(3) END,
             CASE WHEN $5::boolean THEN now() END, $6::uuid, $6::uuid)`,
    [product, tenant, price, currency, retired, ACTOR, `rt1485 ${product}`],
  );
}

async function seedOverride(tenant: string, store: string, product: string, price: string | null, currency = "EGP"): Promise<void> {
  await admin().query(
    `INSERT INTO store_product_overrides (id, tenant_id, store_id, product_id, price, currency_code, is_active, created_by, updated_by)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::numeric, CASE WHEN $4::numeric IS NULL THEN NULL ELSE $5::char(3) END,
             CASE WHEN $4::numeric IS NULL THEN false END, $6::uuid, $6::uuid)`,
    [tenant, store, product, price, currency, ACTOR],
  );
}

async function seed(): Promise<void> {
  await admin().query(`INSERT INTO users (id, email) VALUES ($1, 'rt1485-import@test.invalid')`, [ACTOR]);
  // T1: the main tenant. Cairo (UTC+2) is active; London (UTC+0 in November) is inactive but still
  // the westernmost zone, so the Book bound is T in London.
  await seedTenant(T1, "rt1485-t1");
  await seedStore(T1, S_CAIRO, "CAI", "Africa/Cairo");
  await seedStore(T1, S_LONDON_INACTIVE, "LON", "Europe/London", false);
  await seedProduct(T1, P.priced, "10.50");
  await seedProduct(T1, P.zero, "0");
  await seedProduct(T1, P.subMinor, "12.345");
  await seedProduct(T1, P.unpriced, null);
  await seedProduct(T1, P.retired, "7.00", "EGP", true);
  await seedOverride(T1, S_CAIRO, P.priced, "9.75");
  await seedOverride(T1, S_CAIRO, P.unpriced, null);
  await seedOverride(T1, S_LONDON_INACTIVE, P.priced, "8.00");
  // A product retire keeps its overrides live; the import skips them (zero here: no false blocker).
  await seedOverride(T1, S_CAIRO, P.retired, "0");
  // T2: two legacy currencies.
  await seedTenant(T2, "rt1485-t2");
  await seedStore(T2, S_T2, "T2S", "Africa/Cairo");
  await seedProduct(T2, P_T2, "5.00", "EGP");
  await seedOverride(T2, S_T2, P_T2, "4.00", "USD");
  // T3: no Store, no price. T4: on `pricing` authority. T5: a price_history row. T6: dry run.
  await seedTenant(T3, "rt1485-t3");
  await seedTenant(T4, "rt1485-t4");
  await seedTenant(T5, "rt1485-t5");
  await seedProduct(T5, P_T5, "3.00");
  await admin().query(
    `INSERT INTO price_history (id, tenant_id, product_id, store_id, price, currency_code, effective_from, changed_by, correlation_id)
     VALUES (gen_random_uuid(), $1, $2, NULL, 3.00, 'EGP', now(), $3, gen_random_uuid())`,
    [T5, P_T5, ACTOR],
  );
  await seedTenant(T6, "rt1485-t6");
  await seedProduct(T6, id("1485d8"), "2.00");
  const c = await admin().connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(`UPDATE tenant_pricing_authority SET authority = 'pricing' WHERE tenant_id = $1`, [T4]);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

function args(tenant: string, over: Partial<ParsedArgs["inputs"]> = {}, dryRun = false): ParsedArgs {
  return { tenantId: tenant, actorUserId: ACTOR, inputs: { currencyCode: "EGP", taxPriceBasis: "inclusive", referenceZone: null, ...over }, dryRun, json: false };
}

async function runImport(a: ParsedArgs): Promise<LegacyImportResult> {
  const run = runFromEnv({ DATABASE_URL: env!.uriFor(APP_ROLE_NAME, APP_ROLE_PASSWORD) }, () => AT);
  return await run(a);
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const r = await admin().query<Record<string, string>>(sql, params);
  return Number(Object.values(r.rows[0]!)[0]);
}

const pricingRows = async (tenant: string) => ({
  books: await count(`SELECT count(*) FROM price_books WHERE tenant_id = $1`, [tenant]),
  revisions: await count(`SELECT count(*) FROM pricing_revisions WHERE tenant_id = $1`, [tenant]),
  events: await count(`SELECT count(*) FROM price_events WHERE tenant_id = $1`, [tenant]),
  runs: await count(`SELECT count(*) FROM pricing_import_runs WHERE tenant_id = $1`, [tenant]),
});

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  await cutGrantsToFragment();
  await seed();
}, 300_000);

afterAll(async () => {
  if (env !== null) await stopPgEnv(env);
});

const maybe = (name: string, fn: () => Promise<void>) => it(name, async () => (dockerSkipped ? undefined : fn()), 120_000);

describe("legacy price import (RT-1485 PR-16a-2a)", () => {
  maybe("without the system privilege, 0123 refuses the legacy_import set", async () => {
    await expect(
      runWithTenantContext(env!.app, { tenantId: T1, isPlatformAdmin: false }, (client) =>
        runLegacyImport(client, { tenantId: T1, inputs: args(T1).inputs, actorUserId: ACTOR, correlationId: id("1485e0"), at: AT, dryRun: false }),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await pricingRows(T1)).toEqual({ books: 0, revisions: 0, events: 0, runs: 0 });
  });

  maybe("imports the tenant's legacy prices as revision 1", async () => {
    const r = await runImport(args(T1));
    expect(r).toMatchObject({
      outcome: "imported",
      revisionNo: 1,
      bookCreated: true,
      counts: { bookEvents: 1, storeEvents: 2, zeroPrice: 1, notRepresentable: 1 },
    });
    if (r.outcome === "refused") return;
    expect([...r.exceptions].sort((a, b) => a.productId.localeCompare(b.productId))).toEqual([
      { cls: "zero_price", scope: "book", storeId: null, productId: P.zero },
      { cls: "not_representable", scope: "book", storeId: null, productId: P.subMinor },
    ]);

    const book = await admin().query(
      `SELECT b.id::text, b.currency_code, b.tax_price_basis, b.code, (SELECT count(*) FROM price_zones z WHERE z.price_book_id = b.id AND z.is_default)::int AS defaults
         FROM price_books b WHERE b.tenant_id = $1`,
      [T1],
    );
    expect(book.rows).toEqual([{ id: r.priceBookId, currency_code: "EGP", tax_price_basis: "inclusive", code: "RETAIL", defaults: 1 }]);

    const set = await admin().query(`SELECT kind, state, revision_no::int FROM change_sets WHERE tenant_id = $1`, [T1]);
    expect(set.rows).toEqual([{ kind: "legacy_import", state: "published", revision_no: 1 }]);
    const rev = await admin().query(`SELECT revision_no::int, kind FROM pricing_revisions WHERE tenant_id = $1`, [T1]);
    expect(rev.rows).toEqual([{ revision_no: 1, kind: "legacy_import" }]);

    const events = await admin().query(
      `SELECT scope, store_id::text AS store, product_id::text AS product, price::text, currency_code, time_basis, source, state,
              effective_from_local::text AS from_local, effective_to_local, effective_from, effective_to
         FROM price_events WHERE tenant_id = $1 ORDER BY scope, store_id NULLS FIRST`,
      [T1],
    );
    const common = { product: P.priced, currency_code: "EGP", time_basis: "store_local", source: "legacy_import", state: "active", effective_to_local: null, effective_from: null, effective_to: null };
    expect(events.rows).toEqual(
      [
        { ...common, scope: "book", store: null, price: "10.5000", from_local: "2026-11-23 10:00:00" },
        { ...common, scope: "store", store: S_CAIRO, price: "9.7500", from_local: "2026-11-23 12:00:00" },
        { ...common, scope: "store", store: S_LONDON_INACTIVE, price: "8.0000", from_local: "2026-11-23 10:00:00" },
      ].sort((a, b) => (a.scope + (a.store ?? "")).localeCompare(b.scope + (b.store ?? ""))),
    );

    const fanOut = await admin().query(`SELECT store_id::text AS s FROM pricing_revision_stores WHERE tenant_id = $1 ORDER BY 1`, [T1]);
    expect(fanOut.rows.map((x) => x.s)).toEqual([S_CAIRO, S_LONDON_INACTIVE].sort());

    const run = await admin().query(`SELECT revision_no::int, import_instant, counts FROM pricing_import_runs WHERE tenant_id = $1`, [T1]);
    expect(run.rows).toEqual([
      {
        revision_no: 1,
        import_instant: AT,
        counts: { bookEvents: 1, storeEvents: 2, zeroPrice: 1, notRepresentable: 1, outcome: "imported", bookZone: "Europe/London", referenceZone: "" },
      },
    ]);
    expect(r.bookZone).toBe("Europe/London");
    expect(r.changeLogSequence).toBeGreaterThan(0);

    const audits = await admin().query(`SELECT action, actor_user_id::text AS actor FROM audit_events WHERE tenant_id = $1 ORDER BY action`, [T1]);
    expect(audits.rows).toEqual([
      { action: "pricing.change_set.published", actor: ACTOR },
      { action: "pricing.price_book.created", actor: ACTOR },
    ]);
  });

  maybe("a re-run with no legacy change writes no revision, only its run row", async () => {
    const r = await runImport(args(T1));
    expect(r).toMatchObject({ outcome: "no_change", revisionNo: null, bookCreated: false });
    expect(await pricingRows(T1)).toEqual({ books: 1, revisions: 1, events: 3, runs: 2 });
  });

  maybe("a changed legacy price is a delta, refused until the owner decides how deltas publish", async () => {
    await admin().query(`UPDATE tenant_products SET default_price = 11.00 WHERE id = $1`, [P.priced]);
    const r = await runImport(args(T1));
    expect(r).toEqual({ outcome: "refused", reason: "delta_import_pending_decision", detail: { head: 1 } });
    expect(await pricingRows(T1)).toEqual({ books: 1, revisions: 1, events: 3, runs: 2 });
  });

  maybe("refuses a tenant with two legacy currencies and writes nothing", async () => {
    const r = await runImport(args(T2));
    expect(r).toEqual({ outcome: "refused", reason: "multi_currency_tenant", detail: { currencies: ["EGP", "USD"] } });
    expect(await pricingRows(T2)).toEqual({ books: 0, revisions: 0, events: 0, runs: 0 });
  });

  maybe("a tenant with no Store needs a reference zone; with no price it gets its Book and no revision", async () => {
    expect(await runImport(args(T3))).toMatchObject({ outcome: "refused", reason: "reference_zone_required" });
    const r = await runImport(args(T3, { referenceZone: "Africa/Cairo" }));
    expect(r).toMatchObject({ outcome: "no_change", revisionNo: null, bookCreated: true });
    expect(await pricingRows(T3)).toEqual({ books: 1, revisions: 0, events: 0, runs: 1 });
    // The Book's declared basis is fixed: a different one is refused.
    expect(await runImport(args(T3, { referenceZone: "Africa/Cairo", taxPriceBasis: "exclusive" }))).toEqual({
      outcome: "refused",
      reason: "price_book_mismatch",
      detail: { currencyCode: "EGP", taxPriceBasis: "inclusive" },
    });
  });

  maybe("refuses a tenant whose authority is not legacy", async () => {
    expect(await runImport(args(T4, { referenceZone: "Africa/Cairo" }))).toEqual({ outcome: "refused", reason: "authority_not_legacy", detail: { authority: "pricing" } });
  });

  maybe("refuses a tenant with price_history rows (MC-3 is not in this slice)", async () => {
    expect(await runImport(args(T5, { referenceZone: "Africa/Cairo" }))).toEqual({ outcome: "refused", reason: "price_history_present", detail: { rows: 1 } });
    expect(await pricingRows(T5)).toEqual({ books: 0, revisions: 0, events: 0, runs: 0 });
  });

  maybe("a dry run plans and writes nothing", async () => {
    const r = await runImport(args(T6, { referenceZone: "Africa/Cairo" }, true));
    expect(r).toMatchObject({ outcome: "dry_run", revisionNo: null, runId: null, counts: { bookEvents: 1, storeEvents: 0 } });
    expect(await pricingRows(T6)).toEqual({ books: 0, revisions: 0, events: 0, runs: 0 });
  });
});
