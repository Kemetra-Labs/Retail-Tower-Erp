/**
 * RT-1507 (spec 049 slice S5) — the atomic publish over HTTP against real Postgres (Testcontainers, every migration
 * including 0124, the NOBYPASSRLS `app_test` pool) and the real module graph, with the real shared idempotency interceptor
 * over an in-memory Redis. Only cookie authentication is faked: a header names the session.
 *
 * What this proves:
 *   - the published effect equals the preview: brands, products, identifiers, field changes, deactivations, the unpriced
 *     products, every audit row at batch, product, identifier and brand level with `import_batch_id` and the row number,
 *     the rows' `product_id`, the batch's `published` transition and stored summary, the POS change log;
 *   - the order of checks (`version_conflict`, `import_batch_not_validated`, `preview_changed`, `import_not_publishable`,
 *     `import_batch_closed`), the idempotent replay (same key and body; a new key on a published batch; another hash 409);
 *   - `409 stale_validation`, never a 500, for a single-product edit, an identifier claim, a retired category or product and
 *     a brand that appeared between validate and publish, found by the re-check AND (with the re-check bypassed) by the
 *     conditional writes inside the transaction; the batch returns to `draft`, nothing is published;
 *   - atomicity: a failure injected after the brands, products and updates were written leaves nothing;
 *   - two rows that change one product (merged when they agree, refused when they differ);
 *   - 5,000 rows published in one transaction, timed.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import * as domain from "../../../src/catalog/console-catalog/console-catalog.domain";
import * as publishRepository from "../../../src/catalog/catalog-import/catalog-import.publish-repository";
import { CatalogImportModule } from "../../../src/catalog/catalog-import/catalog-import.module";
import { importUploadPassthrough } from "../../../src/catalog/catalog-import/import-upload-intake.guard";
import { scopedHttpHarness } from "../../_helpers/scoped-http-harness";
import { SES_MANAGER } from "../../console-sales/__support__/console-sales-fixture";
import { TENANT_A } from "../__support__/isolation-harness";
import { SES_OWNER_ALL } from "../erpnext-reconciliation/__support__/read-store-scope";
import { idempotencyProviders } from "./__support__/idempotency-fakes";
import { seedMapValidateFixture } from "./__support__/map-validate-fixture";
import { auditsOf, batchRow, DRINKS, importClient, resetImports, seedProductA, type Batch, type Summary } from "./__support__/review-publish-client";

const h = scopedHttpHarness({
  label: "RT-1507 catalog-import publish",
  contractId: "catalog-import",
  module: CatalogImportModule,
  seed: seedMapValidateFixture,
  providers: idempotencyProviders(),
  beforeInit: (app) => app.use(importUploadPassthrough),
});
const skip = (): boolean => h.skipped();
const c = importClient(h);

let since = new Date(0);
let n = 0;
beforeEach(async () => {
  if (h.skipped()) return;
  await resetImports(h.env().admin);
  since = (await h.env().admin.query<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows[0]!.t;
});
afterEach(() => jest.restoreAllMocks());

/** A suffix that makes every name, SKU, barcode and brand of a test its own (the catalogue is shared by the file). */
const uniq = (): string => {
  n += 1;
  return String(n).padStart(3, "0");
};

interface Scenario {
  readonly u: string;
  readonly batch: Batch;
  readonly up1: string;
  readonly up2: string;
  readonly up3: string;
  readonly up4: string;
  readonly brand: string;
}

/** Tenant A products the batch updates, and the batch (validated, its review row excluded, so publishable). */
async function scenario(): Promise<Scenario> {
  const { admin } = h.env();
  const u = uniq();
  const up1 = await seedProductA(admin, { name: `RT1507 Up1 ${u}`, sku: `UP1-${u}` });
  const up2 = await seedProductA(admin, { name: `RT1507 Up2 ${u}`, sku: `UP2-${u}` });
  const up3 = await seedProductA(admin, { name: `RT1507 Up3 ${u}`, sku: `UP3-${u}` });
  const up4 = await seedProductA(admin, { name: `RT1507 Up4 ${u}`, sku: `UP4-${u}` });
  const brand = `Brand B${u}`;
  const text = [
    "SKU,Barcode,Name,Category,Brand,Tax Category,Active,Price",
    `UP1-${u},,,,,,false,9.5`, // 2 deactivate
    `UP2-${u},,RT1507 Up2 Renamed ${u},RT730 Drinks,${brand},standard,,`, // 3 name, category, brand to create
    `UP3-${u},99${u}01,,,,,,`, // 4 identifier-only update
    `NEW-A-${u},,RT1507 New A ${u},RT730 Drinks,${brand},standard,,`, // 5 create (the same brand)
    `NEW-B-${u},99${u}02,RT1507 New B ${u},,,standard,true,12`, // 6 create with a barcode
    `UP4-${u},,RT1507 Up4 ${u},,,,,`, // 7 unchanged
    `,,Anon ${u},,,standard,,`, // 8 no_identifier
  ].join("\n");
  const validated = await c.validated(text);
  const excluded = await c.resolve(SES_OWNER_ALL, validated.batchId, 8, { expectedVersion: validated.version, action: "exclude" }).expect(200);
  return { u, batch: { ...validated, version: excluded.body.version, previewHash: excluded.body.previewHash }, up1, up2, up3, up4, brand };
}

const bodyOf = (b: Batch): { expectedVersion: number; previewHash: string | null } => ({ expectedVersion: b.version, previewHash: b.previewHash });

/** What a publish of the scenario must not have changed or created. */
async function nothingWritten(s: Scenario): Promise<void> {
  const { admin } = h.env();
  const created = await admin.query(`SELECT 1 FROM tenant_products WHERE tenant_id = $1 AND name LIKE $2`, [TENANT_A, `RT1507 New % ${s.u}`]);
  expect(created.rowCount).toBe(0);
  expect((await admin.query(`SELECT 1 FROM tenant_product_brands WHERE tenant_id = $1 AND name = $2`, [TENANT_A, s.brand])).rowCount).toBe(0);
  const up = await admin.query<{ name: string; is_active: boolean; brand_id: string | null }>(`SELECT name, is_active, brand_id FROM tenant_products WHERE id = ANY($1::uuid[]) ORDER BY name`, [[s.up1, s.up2]]);
  expect(up.rows).toEqual([
    { name: `RT1507 Up1 ${s.u}`, is_active: true, brand_id: null },
    { name: `RT1507 Up2 ${s.u}`, is_active: true, brand_id: null },
  ]);
  expect((await admin.query(`SELECT 1 FROM product_aliases WHERE tenant_id = $1 AND value IN ($2, $3, $4, $5)`, [TENANT_A, `99${s.u}01`, `99${s.u}02`, `NEW-A-${s.u}`, `NEW-B-${s.u}`])).rowCount).toBe(0);
  for (const action of ["catalog.product.create", "catalog.product.update", "catalog.product_identifier.add", "catalog.brand.create", "catalog.import.publish"]) {
    expect(await auditsOf(admin, action, since)).toHaveLength(0);
  }
  expect((await admin.query(`SELECT 1 FROM catalog_import_rows WHERE batch_id = $1 AND product_id IS NOT NULL`, [s.batch.batchId])).rowCount).toBe(0);
}

describe("a publish", () => {
  it("writes exactly what the preview showed, with audit rows at every level, provenance and the stored summary", async () => {
    if (skip()) return;
    const { admin } = h.env();
    const s = await scenario();
    const preview = (await c.preview(SES_OWNER_ALL, s.batch.batchId).expect(200)).body;
    expect(preview).toMatchObject({ brandsToCreate: [s.brand], productsToCreate: 2, productsToUpdate: 3, identifiersToAdd: 4, newProductsWithoutPrice: 2, rowsWithPriceNotImported: 2 });
    expect(preview.deactivations.map((d: { rowNumber: number }) => d.rowNumber)).toEqual([2]);

    const res = await c.publish(SES_OWNER_ALL, s.batch.batchId, bodyOf(s.batch)).expect(200);
    h.conforms("CatalogImportPublishResult", res.body);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    const summary: Summary = { brandsCreated: 1, productsCreated: 2, productsUpdated: 3, identifiersAdded: 4, productsDeactivated: 1, rowsUnchanged: 1, rowsExcluded: 1 };
    expect(res.body.summary).toEqual(summary);
    expect(res.body.batch).toMatchObject({ state: "published", version: s.batch.version + 1, publishable: false, expiresAt: null, previewHash: s.batch.previewHash });
    expect(res.body.batch.publishedAt).toMatch(/^\d{4}-/);
    // The summary is the preview's: productsToCreate / Update, identifiers, deactivations.
    expect([summary.productsCreated, summary.productsUpdated, summary.identifiersAdded, summary.productsDeactivated]).toEqual([preview.productsToCreate, preview.productsToUpdate, preview.identifiersToAdd, preview.deactivations.length]);

    const state = await batchRow(admin, s.batch.batchId);
    expect(state).toMatchObject({ state: "published", version: s.batch.version + 1, publish_summary: summary, expires_at: null });
    expect(state.closed_at).not.toBeNull();
    expect(state.published_at).not.toBeNull();

    // The catalogue: the brand once, the products unpriced, the updates applied.
    const brands = await admin.query<{ id: string }>(`SELECT id::text AS id FROM tenant_product_brands WHERE tenant_id = $1 AND name = $2 AND retired_at IS NULL`, [TENANT_A, s.brand]);
    expect(brands.rows).toHaveLength(1);
    const created = await admin.query<{ id: string; name: string; default_price: string | null; is_active: boolean; brand_id: string | null; category_id: string | null; created_by: string }>(
      `SELECT id::text AS id, name, default_price::text AS default_price, is_active, brand_id::text AS brand_id, category_id::text AS category_id, created_by::text AS created_by
         FROM tenant_products WHERE tenant_id = $1 AND name LIKE $2 ORDER BY name`,
      [TENANT_A, `RT1507 New % ${s.u}`],
    );
    expect(created.rows.map((r) => [r.name, r.default_price, r.is_active, r.brand_id, r.category_id])).toEqual([
      [`RT1507 New A ${s.u}`, null, true, brands.rows[0]!.id, DRINKS],
      [`RT1507 New B ${s.u}`, null, true, null, null],
    ]);
    const updated = await admin.query<{ id: string; name: string; is_active: boolean; brand_id: string | null; category_id: string | null }>(
      `SELECT id::text AS id, name, is_active, brand_id::text AS brand_id, category_id::text AS category_id FROM tenant_products WHERE id = ANY($1::uuid[]) ORDER BY name`,
      [[s.up1, s.up2, s.up3, s.up4]],
    );
    expect(updated.rows.map((r) => [r.name, r.is_active, r.brand_id, r.category_id])).toEqual([
      [`RT1507 Up1 ${s.u}`, false, null, null],
      [`RT1507 Up2 Renamed ${s.u}`, true, brands.rows[0]!.id, DRINKS],
      [`RT1507 Up3 ${s.u}`, true, null, null],
      [`RT1507 Up4 ${s.u}`, true, null, null],
    ]);
    const aliases = await admin.query<{ value: string; identifier_type: string }>(
      `SELECT value, identifier_type FROM product_aliases WHERE tenant_id = $1 AND retired_at IS NULL AND value IN ($2, $3, $4, $5) ORDER BY value`,
      [TENANT_A, `99${s.u}01`, `99${s.u}02`, `NEW-A-${s.u}`, `NEW-B-${s.u}`],
    );
    expect(aliases.rows).toHaveLength(4);

    // Audit rows: batch level, product level, identifier level and brand level, with the batch id and the row number.
    const meta = async (action: string): Promise<Array<Record<string, unknown>>> => (await auditsOf(admin, action, since)).map((a) => a.metadata);
    const published = await auditsOf(admin, "catalog.import.publish", since);
    expect(published).toHaveLength(1);
    expect(published[0]!.metadata).toMatchObject({ batch_id: s.batch.batchId, summary });
    expect((await meta("catalog.brand.create")).map((m) => [m["import_batch_id"], m["row_number"]])).toEqual([[s.batch.batchId, 3]]);
    const createAudits = await meta("catalog.product.create");
    expect(createAudits.map((m) => [m["import_batch_id"], m["row_number"]]).sort()).toEqual([[s.batch.batchId, 5], [s.batch.batchId, 6]]);
    expect(createAudits[0]).toMatchObject({ new: { taxCategory: "standard", isActive: true } });
    const updateAudits = await meta("catalog.product.update");
    expect(updateAudits.map((m) => m["row_number"]).sort()).toEqual([2, 3]);
    expect(updateAudits.find((m) => m["row_number"] === 2)).toMatchObject({ old: { isActive: true }, new: { isActive: false }, import_batch_id: s.batch.batchId });
    const identifierAudits = await meta("catalog.product_identifier.add");
    expect(identifierAudits.map((m) => [m["value"], m["row_number"]]).sort()).toEqual(
      [[`99${s.u}01`, 4], [`99${s.u}02`, 6], [`NEW-A-${s.u}`, 5], [`NEW-B-${s.u}`, 6]].sort(),
    );

    // Provenance: each created or changed row keeps its product.
    const rows = await c.allRows(s.batch.batchId);
    const byRow = new Map(rows.map((r) => [r.rowNumber, r.productId]));
    expect(byRow.get(2)).toBe(s.up1);
    expect(byRow.get(3)).toBe(s.up2);
    expect(byRow.get(4)).toBe(s.up3);
    expect(byRow.get(7)).toBeNull();
    expect(byRow.get(8)).toBeNull();
    expect(created.rows.map((r) => r.id).sort()).toEqual([byRow.get(5), byRow.get(6)].sort());

    // The POS delta: the existing change-log triggers carried every product and identifier write.
    const log = await admin.query<{ n: string }>(`SELECT count(DISTINCT product_id)::text AS n FROM catalog_change_log WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) AND occurred_at >= $3`, [TENANT_A, [...created.rows.map((r) => r.id), s.up1, s.up2, s.up3], since]);
    expect(Number(log.rows[0]!.n)).toBe(5);
    // Created products have no price anywhere, so none is sellable at a till until priced (spec 049 section 6, F-4).
    const priced = await admin.query(`SELECT 1 FROM store_product_overrides WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) AND price IS NOT NULL`, [TENANT_A, created.rows.map((r) => r.id)]);
    expect(priced.rowCount).toBe(0);

    // The preview of the published batch is the same effect.
    const after = (await c.preview(SES_OWNER_ALL, s.batch.batchId).expect(200)).body;
    expect(after).toMatchObject({ productsToCreate: 2, productsToUpdate: 3, identifiersToAdd: 4, brandsToCreate: [s.brand] });
  });

  it("replays: the same key and body, a new key on the published batch, and refuses another hash", async () => {
    if (skip()) return;
    const { admin } = h.env();
    const s = await scenario();
    const key = "rt1507-replay-key-0000000000000001";
    const first = await c.publish(SES_OWNER_ALL, s.batch.batchId, bodyOf(s.batch), key).expect(200);
    const same = await c.publish(SES_OWNER_ALL, s.batch.batchId, bodyOf(s.batch), key).expect(200);
    expect(same.headers["idempotent-replayed"]).toBe("true");
    expect(same.body).toEqual(first.body);
    // The same key with another body is the shared interceptor's conflict.
    c.expectError(await c.publish(SES_OWNER_ALL, s.batch.batchId, { expectedVersion: s.batch.version, previewHash: `sha256:${"b".repeat(64)}` }, key), 409, "idempotency_key_conflict");
    // A new key for the published batch with its hash replays the stored result; with another hash it is closed.
    const fresh = await c.publish(SES_OWNER_ALL, s.batch.batchId, bodyOf(s.batch)).expect(200);
    expect(fresh.headers["idempotent-replayed"]).toBe("true");
    expect(fresh.body.summary).toEqual(first.body.summary);
    expect(fresh.body.batch.state).toBe("published");
    c.expectError(await c.publish(SES_OWNER_ALL, s.batch.batchId, { expectedVersion: s.batch.version, previewHash: `sha256:${"c".repeat(64)}` }), 409, "import_batch_closed");
    // One publish was ever written.
    expect(await auditsOf(admin, "catalog.import.publish", since)).toHaveLength(1);
    expect(await auditsOf(admin, "catalog.product.create", since)).toHaveLength(2);
  });

  it("keeps the contract's order of checks and writes nothing when one refuses", async () => {
    if (skip()) return;
    const s = await scenario();
    const body = bodyOf(s.batch);
    c.expectError(await c.publish(SES_OWNER_ALL, s.batch.batchId, { ...body, expectedVersion: s.batch.version - 1 }), 409, "version_conflict");
    c.expectError(await c.publish(SES_OWNER_ALL, s.batch.batchId, { ...body, previewHash: `sha256:${"d".repeat(64)}` }), 409, "preview_changed");
    c.expectError(await c.publish(SES_OWNER_ALL, "nope", body), 400, "validation_error");
    c.expectError(await c.publish(SES_OWNER_ALL, s.batch.batchId, { ...body, previewHash: "sha256:xyz" }), 400, "validation_error");
    c.expectError(await c.publish(SES_OWNER_ALL, s.batch.batchId, { ...body, tenantId: TENANT_A }), 400, "validation_error");
    const noKey = await h.post(`/api/v1/catalog/imports/${s.batch.batchId}/publish`, SES_OWNER_ALL, body);
    c.expectError(noKey, 400, "idempotency_key_required");
    c.expectError(await c.publish(SES_MANAGER, s.batch.batchId, body), 404, "not_found");
    await nothingWritten(s);
    expect(await batchRow(h.env().admin, s.batch.batchId)).toMatchObject({ state: "validated", version: s.batch.version });
  });

  it("is import_not_publishable while a row needs review, import_batch_not_validated for a draft and import_batch_closed once cancelled or lapsed", async () => {
    if (skip()) return;
    const { admin } = h.env();
    const u = uniq();
    const open = await c.validated(`SKU,Name,Tax Category\nNEW-R-${u},Fresh ${u},standard\n,Anon ${u},standard\n`);
    expect(open.publishable).toBe(false);
    c.expectError(await c.publish(SES_OWNER_ALL, open.batchId, bodyOf(open)), 409, "import_not_publishable");
    await h.put(`/api/v1/catalog/imports/${open.batchId}/mapping`, SES_OWNER_ALL, { expectedVersion: open.version, columns: open.mapping }).expect(200);
    c.expectError(await c.publish(SES_OWNER_ALL, open.batchId, { expectedVersion: open.version + 1, previewHash: open.previewHash }), 409, "import_batch_not_validated");
    const revalidated = (await c.validate(SES_OWNER_ALL, open.batchId, open.version + 1).expect(200)).body as Batch;
    await admin.query(`UPDATE catalog_import_batches SET expires_at = now() - interval '1 minute' WHERE id = $1`, [open.batchId]);
    c.expectError(await c.publish(SES_OWNER_ALL, open.batchId, bodyOf(revalidated)), 409, "import_batch_closed");
    await c.cancel(SES_OWNER_ALL, open.batchId, revalidated.version).expect(200);
    c.expectError(await c.publish(SES_OWNER_ALL, open.batchId, bodyOf(revalidated)), 409, "import_batch_closed");
    expect(await auditsOf(admin, "catalog.product.create", since)).toHaveLength(0);
  });
});

describe("a stale validation is 409 stale_validation, never a 500, and nothing is published", () => {
  type Perturb = (s: Scenario) => Promise<void>;

  /** A perturbation of the catalogue between validate and publish, and what the re-check says. */
  const perturbations: Array<[string, Perturb]> = [
    ["a single-product edit", async (s) => void (await h.env().admin.query(`UPDATE tenant_products SET name = $2 WHERE id = $1`, [s.up2, `Edited ${s.u}`]))],
    ["an identifier claim", async (s) => void (await seedProductA(h.env().admin, { name: `Claimer ${s.u}`, sku: `CL-${s.u}`, barcode: `99${s.u}01` }))],
    ["a product retired", async (s) => void (await h.env().admin.query(`UPDATE tenant_products SET retired_at = now() WHERE id = $1`, [s.up3]))],
    ["the brand to create appearing", async (s) => void (await h.env().admin.query(`INSERT INTO tenant_product_brands (id, tenant_id, name, created_by) VALUES (gen_random_uuid(), $1, $2, $3)`, [TENANT_A, s.brand, "0a000000-0000-7000-8000-0000001507e1"]))],
    ["the category retired", async () => void (await h.env().admin.query(`UPDATE tenant_product_categories SET retired_at = now() WHERE tenant_id = $1 AND name = 'RT730 Drinks'`, [TENANT_A]))],
  ];

  async function restoreCategory(): Promise<void> {
    await h.env().admin.query(`UPDATE tenant_product_categories SET retired_at = NULL WHERE tenant_id = $1 AND name = 'RT730 Drinks'`, [TENANT_A]);
  }

  /** Whatever the perturbation did to the fixtures the scenario checks, put it back so `nothingWritten` reads the scenario's own writes only. */
  async function expectStale(s: Scenario, label: string): Promise<void> {
    const res = await c.publish(SES_OWNER_ALL, s.batch.batchId, bodyOf(s.batch));
    c.expectError(res, 409, "stale_validation");
    const state = await batchRow(h.env().admin, s.batch.batchId);
    expect({ label, state: state.state, version: state.version, hash: state.preview_hash, counts: state.counts }).toEqual({ label, state: "draft", version: s.batch.version + 1, hash: null, counts: null });
    for (const action of ["catalog.product.create", "catalog.product.update", "catalog.product_identifier.add", "catalog.brand.create", "catalog.import.publish"]) {
      expect(await auditsOf(h.env().admin, action, since)).toHaveLength(0);
    }
    expect((await h.env().admin.query(`SELECT 1 FROM tenant_products WHERE tenant_id = $1 AND name LIKE $2`, [TENANT_A, `RT1507 New % ${s.u}`])).rowCount).toBe(0);
    expect((await h.env().admin.query(`SELECT 1 FROM catalog_import_rows WHERE batch_id = $1 AND product_id IS NOT NULL`, [s.batch.batchId])).rowCount).toBe(0);
  }

  it.each(perturbations)("found by the re-check: %s", async (label, perturb) => {
    if (skip()) return;
    const s = await scenario();
    try {
      await perturb(s);
      await expectStale(s, label);
    } finally {
      await restoreCategory();
    }
  });

  it.each(perturbations)("found by the conditional writes inside the transaction when the re-check is bypassed: %s", async (label, perturb) => {
    if (skip()) return;
    const s = await scenario();
    jest.spyOn(publishRepository, "catalogueChanged").mockResolvedValue(false);
    try {
      await perturb(s);
      await expectStale(s, label);
    } finally {
      await restoreCategory();
    }
  });

  it("returns the batch to draft so the merchant validates again and sees the new preview", async () => {
    if (skip()) return;
    const s = await scenario();
    await h.env().admin.query(`UPDATE tenant_products SET name = $2 WHERE id = $1`, [s.up2, `Edited ${s.u}`]);
    c.expectError(await c.publish(SES_OWNER_ALL, s.batch.batchId, bodyOf(s.batch)), 409, "stale_validation");
    c.expectError(await c.preview(SES_OWNER_ALL, s.batch.batchId), 409, "import_batch_not_validated");
    const again = (await c.validate(SES_OWNER_ALL, s.batch.batchId, s.batch.version + 1).expect(200)).body as Batch;
    // The excluded row's decision stands (same reason, same candidates), so the batch is publishable again, with a new hash.
    expect(again).toMatchObject({ state: "validated", publishable: true });
    expect(again.previewHash).not.toBe(s.batch.previewHash);
    const res = await c.publish(SES_OWNER_ALL, s.batch.batchId, bodyOf(again)).expect(200);
    expect(res.body.batch.state).toBe("published");
    const name = await h.env().admin.query<{ name: string }>(`SELECT name FROM tenant_products WHERE id = $1`, [s.up2]);
    expect(name.rows[0]!.name).toBe(`RT1507 Up2 Renamed ${s.u}`);
  });
});

describe("atomicity", () => {
  it("rolls back every write when a failure is injected after the brands, products and updates were written", async () => {
    if (skip()) return;
    const s = await scenario();
    const real = domain.insertIdentifiersIn;
    jest.spyOn(domain, "insertIdentifiersIn").mockRejectedValueOnce(new Error("injected failure mid-batch"));
    const res = await c.publish(SES_OWNER_ALL, s.batch.batchId, bodyOf(s.batch));
    expect(res.status).toBe(500);
    await nothingWritten(s);
    expect(await batchRow(h.env().admin, s.batch.batchId)).toMatchObject({ state: "validated", version: s.batch.version, preview_hash: s.batch.previewHash });
    // The failure left the batch as it was: the same publish (a retry under a new key) succeeds.
    jest.spyOn(domain, "insertIdentifiersIn").mockImplementation(real);
    await c.publish(SES_OWNER_ALL, s.batch.batchId, bodyOf(s.batch)).expect(200);
    expect(await auditsOf(h.env().admin, "catalog.import.publish", since)).toHaveLength(1);
  });

  it("rolls back when the batch's own published transition fails", async () => {
    if (skip()) return;
    const s = await scenario();
    jest.spyOn(publishRepository, "markBatchPublished").mockRejectedValueOnce(new Error("injected failure at the transition"));
    expect((await c.publish(SES_OWNER_ALL, s.batch.batchId, bodyOf(s.batch))).status).toBe(500);
    await nothingWritten(s);
  });
});

describe("two rows that change one product", () => {
  async function twoRows(second: string): Promise<{ batch: Batch; product: string; u: string }> {
    const u = uniq();
    const product = await seedProductA(h.env().admin, { name: `RT1507 Twice ${u}`, sku: `TW-${u}`, barcode: `99${u}77` });
    const batch = await c.validated(`SKU,Barcode,Name,Tax Category\nTW-${u},,Same ${u},\n,99${u}77,${second.replace("$u", u)},\n`);
    return { batch, product, u };
  }

  it("merges them into one update when they agree", async () => {
    if (skip()) return;
    const { batch, product, u } = await twoRows("Same $u");
    expect(batch.counts).toMatchObject({ ready_update: 2 });
    const preview = (await c.preview(SES_OWNER_ALL, batch.batchId).expect(200)).body;
    expect(preview.productsToUpdate).toBe(1);
    const res = await c.publish(SES_OWNER_ALL, batch.batchId, bodyOf(batch)).expect(200);
    expect(res.body.summary).toMatchObject({ productsUpdated: 1 });
    const name = await h.env().admin.query<{ name: string }>(`SELECT name FROM tenant_products WHERE id = $1`, [product]);
    expect(name.rows[0]!.name).toBe(`Same ${u}`);
    const rows = await c.allRows(batch.batchId);
    expect(rows.map((r) => r.productId)).toEqual([product, product]);
  });

  it("refuses them with import_not_publishable when they disagree", async () => {
    if (skip()) return;
    const { batch, product, u } = await twoRows("Other $u");
    c.expectError(await c.publish(SES_OWNER_ALL, batch.batchId, bodyOf(batch)), 409, "import_not_publishable");
    const name = await h.env().admin.query<{ name: string }>(`SELECT name FROM tenant_products WHERE id = $1`, [product]);
    expect(name.rows[0]!.name).toBe(`RT1507 Twice ${u}`);
    expect(await batchRow(h.env().admin, batch.batchId)).toMatchObject({ state: "validated", version: batch.version });
  });
});

describe("a decided row", () => {
  it("publishes the decisions: create_new writes the row, update_product with nothing to change writes nothing, the not-added identifier stays unwritten", async () => {
    if (skip()) return;
    const { admin } = h.env();
    const u = uniq();
    const alpha = await seedProductA(admin, { name: `RT1507 Dup ${u}`, sku: `DUP-${u}` });
    const batch = await c.validated(
      [
        "SKU,Name,Tax Category",
        `NEW-D-${u},RT1507 Dup ${u},standard`, // 2 possible_duplicate
        `NEW-E-${u},RT1507 Dup ${u},standard`, // 3 possible_duplicate
      ].join("\n"),
    );
    expect(batch.counts).toMatchObject({ needs_review: 2 });
    const created = await c.resolve(SES_OWNER_ALL, batch.batchId, 2, { expectedVersion: batch.version, action: "create_new" }).expect(200);
    const updated = await c.resolve(SES_OWNER_ALL, batch.batchId, 3, { expectedVersion: created.body.version, action: "update_product", productId: alpha }).expect(200);
    expect(updated.body.publishable).toBe(true);
    const res = await c.publish(SES_OWNER_ALL, batch.batchId, { expectedVersion: updated.body.version, previewHash: updated.body.previewHash }).expect(200);
    // Row 3 chose the existing product: its file SKU would be a second SKU, so it is not added (OD-1) and the row changes nothing.
    expect(res.body.summary).toMatchObject({ productsCreated: 1, productsUpdated: 0, identifiersAdded: 1 });
    const skus = await admin.query<{ value: string }>(`SELECT value FROM product_aliases WHERE product_id = $1 AND identifier_type = 'sku' AND retired_at IS NULL`, [alpha]);
    expect(skus.rows.map((r) => r.value)).toEqual([`DUP-${u}`]);
  });
});

describe("performance: 5,000 rows in one transaction", () => {
  it("publishes 5,000 new products with an identifier pair, a category and a brand each within the budget", async () => {
    if (skip()) return;
    const { admin } = h.env();
    const u = uniq();
    const lines = ["SKU,Barcode,Name,Category,Brand,Tax Category"];
    for (let r = 0; r < 5000; r += 1) lines.push(`BULK-${u}-${r},98${u}${String(r).padStart(6, "0")},Bulk product ${u} ${r},RT730 Drinks,Bulk brand ${u} ${r % 50},standard`);
    const batch = await c.validated(lines.join("\n"), "create");
    expect(batch.counts).toMatchObject({ ready_create: 5000 });
    const previewStarted = Date.now();
    const preview = (await c.preview(SES_OWNER_ALL, batch.batchId).expect(200)).body;
    const previewMs = Date.now() - previewStarted;
    expect(preview).toMatchObject({ productsToCreate: 5000, identifiersToAdd: 10_000, newProductsWithoutPrice: 5000 });
    expect(preview.brandsToCreate).toHaveLength(50);
    expect(previewMs).toBeLessThan(30_000);
    const started = Date.now();
    const res = await c.publish(SES_OWNER_ALL, batch.batchId, bodyOf(batch)).expect(200);
    const elapsed = Date.now() - started;
    // eslint-disable-next-line no-console
    console.info(`RT-1507 publish of 5,000 rows (10,000 identifiers, 50 brands, ${15_000 + 51} audit rows): ${elapsed} ms; preview ${previewMs} ms`);
    expect(res.body.summary).toMatchObject({ productsCreated: 5000, identifiersAdded: 10_000, brandsCreated: 50 });
    // The latency budget is p95 15 s (spec 049 section 8.5, measured in S8); this is a sanity bound for a slow CI box.
    expect(elapsed).toBeLessThan(60_000);
    const count = async (sql: string): Promise<number> => Number((await admin.query<{ n: string }>(sql, [TENANT_A, `Bulk product ${u} %`])).rows[0]!.n);
    expect(await count(`SELECT count(*)::text AS n FROM tenant_products WHERE tenant_id = $1 AND name LIKE $2`)).toBe(5000);
    expect(await count(`SELECT count(*)::text AS n FROM product_aliases a JOIN tenant_products p ON p.id = a.product_id WHERE a.tenant_id = $1 AND p.name LIKE $2`)).toBe(10_000);
    const audits = await admin.query<{ action: string; n: string }>(`SELECT action, count(*)::text AS n FROM audit_events WHERE tenant_id = $1 AND occurred_at >= $2 AND action LIKE 'catalog.%' GROUP BY action`, [TENANT_A, since]);
    const byAction = Object.fromEntries(audits.rows.map((a) => [a.action, Number(a.n)]));
    expect(byAction).toMatchObject({ "catalog.product.create": 5000, "catalog.product_identifier.add": 10_000, "catalog.brand.create": 50, "catalog.import.publish": 1 });
  }, 300_000);
});
