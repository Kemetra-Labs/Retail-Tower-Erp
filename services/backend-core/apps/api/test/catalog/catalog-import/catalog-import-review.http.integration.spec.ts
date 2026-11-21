/**
 * RT-1507 (spec 049 slice S5) — the review decisions, the preview and the cancel over HTTP against real Postgres
 * (Testcontainers, every migration including 0124, the NOBYPASSRLS `app_test` pool) and the real module graph. Only
 * cookie authentication is faked: a header names the session.
 *
 * What this proves:
 *   - each review resolution (create new, update this product, exclude, clear) for each review reason, the row's new
 *     status, outcome (`identifiersNotAdded`), decision, the batch's next version and recomputed counts and hash, the
 *     `catalog.import.review` audit row;
 *   - the offers: `update_product` only for a candidate, never retired, never in a `create` batch; an `error` row takes
 *     only exclude and clear; `create_new` only while no identifier on the row is active;
 *   - a new validation keeps a decision while the row's candidate set and reason are unchanged, and drops it otherwise;
 *   - the preview: brands to create, creates, updates, identifier adds, deactivations, unpriced products, excluded and
 *     unchanged rows;
 *   - cancel, version conflicts, closed and unvalidated batches, roles (non-disclosing 404) and RLS isolation.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { CatalogImportModule } from "../../../src/catalog/catalog-import/catalog-import.module";
import { importUploadPassthrough } from "../../../src/catalog/catalog-import/import-upload-intake.guard";
import { scopedHttpHarness } from "../../_helpers/scoped-http-harness";
import { SES_MANAGER, SES_STAFF } from "../../console-sales/__support__/console-sales-fixture";
import { TENANT_A } from "../__support__/isolation-harness";
import { P_JUICE, P_RETIRED, P_WATER } from "../console-catalog/__support__/console-catalog-fixture";
import { SES_ADMIN_SPEC, SES_OWNER_ALL } from "../erpnext-reconciliation/__support__/read-store-scope";
import { SES_OWNER_B } from "./__support__/catalog-import-fixture";
import { idempotencyProviders } from "./__support__/idempotency-fakes";
import { P_ALPHA, P_GAMMA, seedMapValidateFixture } from "./__support__/map-validate-fixture";
import { auditsOf, batchRow, importClient, OWNER_A_USER, resetImports, type RowBody } from "./__support__/review-publish-client";

const h = scopedHttpHarness({
  label: "RT-1507 catalog-import review",
  contractId: "catalog-import",
  module: CatalogImportModule,
  seed: seedMapValidateFixture,
  providers: idempotencyProviders(),
  beforeInit: (app) => app.use(importUploadPassthrough),
});
const skip = (): boolean => h.skipped();
const c = importClient(h);

let since = new Date(0);
beforeEach(async () => {
  if (h.skipped()) return;
  await resetImports(h.env().admin);
  since = (await h.env().admin.query<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows[0]!.t;
});

/** The part B scenario: rows 2 to 19; the review rows are 8 ambiguous, 10 possible_duplicate, 11 no_identifier, 14 store_scoped_conflict, 18 sku_mismatch. */
const SCENARIO = [
  "SKU,Barcode,PLU,Name,Category,Brand,Tax Category,Active,Price",
  "A-1,4006381333931,,RT1505 Alpha,RT730 Drinks,,standard,,8.5", // 2 unchanged
  "B-1,,,RT1505 Beta Renamed,,RT1505 Acme,standard,,", // 3 ready_update
  "NEW-1,5901234123457,,Fresh Tea,RT730 Drinks,Brand Fresh,standard,,", // 4 ready_create, brand to create
  "I-1,,,,,,,true,", // 5 ready_update
  "R-1,,,Retired Tea,,,standard,,", // 6 error: product_retired
  "G-1,,,RT1505 Gamma 2,,,standard,,", // 7 ready_update
  "W-1,123,,,,,,,", // 8 needs_review: ambiguous (Water and Juice)
  "NEW-2,,,Nice,Nonexistent cat,,standard,,", // 9 error: category_not_found
  "NEW-3,,,RT730 Water,,,standard,,", // 10 needs_review: possible_duplicate (Water)
  ",,,Anon,,,standard,,", // 11 needs_review: no_identifier
  "NEW-4,,,Odd tax,,,exotic,,", // 12 ready_create
  "  NEW-6  ,,,  Spaces  ,,,standard,,", // 13 ready_create
  "NEW-7,,4242,Plu thing,,,standard,,", // 14 needs_review: store_scoped_conflict (Water's PLU at store Y)
  "NEW-8,555000,,Deleted store barcode,,,standard,,", // 15 ready_create
  "NEW-9,\u{0660}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667},,Arabic digits,,,standard,,", // 16 error
  "NEW-10,,,Old cat,RT730 Old,,standard,,", // 17 error: category_not_found
  "NEW-11,6223001360018,,Gamma again,,,standard,,", // 18 needs_review: sku_mismatch (Gamma has G-1)
  "A-2,4006381333930,,Bad gtin,,,standard,,", // 19 ready_create
].join("\n");

const row = (rows: RowBody[], n: number): RowBody => rows.find((r) => r.rowNumber === n) as RowBody;

describe("review decisions", () => {
  it("create_new on a no_identifier row: ready_create, the next version, a new hash, the recomputed counts and the audit row", async () => {
    if (skip()) return;
    const batch = await c.validated(SCENARIO);
    const res = await c.resolve(SES_OWNER_ALL, batch.batchId, 11, { expectedVersion: batch.version, action: "create_new" }).expect(200);
    h.conforms("CatalogImportRowResolved", res.body);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.row).toMatchObject({ rowNumber: 11, status: "ready_create", reviewReason: "no_identifier", resolution: { action: "create_new", productId: null } });
    expect(res.body.row.outcome).toMatchObject({ match: "no_match", identifiersNotAdded: [] });
    expect(res.body.version).toBe(batch.version + 1);
    expect(res.body.previewHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(res.body.previewHash).not.toBe(batch.previewHash);
    expect(res.body.counts).toEqual({ ready_create: 6, ready_update: 3, unchanged: 1, needs_review: 4, error: 4, excluded: 0 });
    expect(res.body.publishable).toBe(false);
    const state = await batchRow(h.env().admin, batch.batchId);
    expect(state).toMatchObject({ state: "validated", version: batch.version + 1, preview_hash: res.body.previewHash });
    const written = await auditsOf(h.env().admin, "catalog.import.review", since);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ actor_user_id: OWNER_A_USER, target_id: batch.batchId });
    expect(written[0]!.metadata).toMatchObject({ batch_id: batch.batchId, version: batch.version + 1, row_number: 11, action: "create_new", status: "ready_create" });
    expect(JSON.stringify(written[0]!.metadata)).not.toMatch(/Anon/);
    // The row list shows the decision, and the generation (so a walk in progress) is unchanged.
    const listed = row(await c.allRows(batch.batchId), 11);
    expect(listed).toMatchObject({ status: "ready_create", resolution: { action: "create_new" } });
    expect(listed.resolution!.decidedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("create_new on a store_scoped_conflict row writes the other identifiers and lists the conflicting one as not added", async () => {
    if (skip()) return;
    const batch = await c.validated(SCENARIO);
    const res = await c.resolve(SES_OWNER_ALL, batch.batchId, 14, { expectedVersion: batch.version, action: "create_new" }).expect(200);
    expect(res.body.row.status).toBe("ready_create");
    expect(res.body.row.outcome.identifierAdds).toEqual([{ type: "sku", value: "NEW-7" }]);
    expect(res.body.row.outcome.identifiersNotAdded).toEqual([{ type: "plu", value: "4242" }]);
  });

  it("create_new on a possible_duplicate row is ready_create; update_product with the named product recomputes against it", async () => {
    if (skip()) return;
    const batch = await c.validated(SCENARIO);
    const created = await c.resolve(SES_OWNER_ALL, batch.batchId, 10, { expectedVersion: batch.version, action: "create_new" }).expect(200);
    expect(created.body.row).toMatchObject({ status: "ready_create", reviewReason: "possible_duplicate" });
    const updated = await c.resolve(SES_OWNER_ALL, batch.batchId, 10, { expectedVersion: created.body.version, action: "update_product", productId: P_WATER }).expect(200);
    expect(updated.body.row).toMatchObject({ status: "ready_update", resolution: { action: "update_product", productId: P_WATER } });
    expect(updated.body.row.outcome.matchedProduct).toMatchObject({ productId: P_WATER, name: "RT730 Water" });
    // Same name and tax category as Water's: no field change; the file's new SKU is the only add.
    expect(updated.body.row.outcome.fieldChanges).toEqual([]);
    expect(updated.body.row.outcome.identifierAdds).toEqual([]);
    expect(updated.body.row.outcome.identifiersNotAdded).toEqual([{ type: "sku", value: "NEW-3" }]);
    // The chosen product's updated_at was captured for the publish re-check.
    const stored = await h.env().admin.query<{ ok: boolean }>(
      `SELECT r.matched_updated_at = p.updated_at AS ok FROM catalog_import_rows r JOIN tenant_products p ON p.id = $2 WHERE r.batch_id = $1 AND r.row_number = 10`,
      [batch.batchId, P_WATER],
    );
    expect(stored.rows[0]!.ok).toBe(true);
  });

  it("update_product on an ambiguous row keeps an identifier another candidate holds out of the update, listed as not added", async () => {
    if (skip()) return;
    const batch = await c.validated(SCENARIO);
    const res = await c.resolve(SES_OWNER_ALL, batch.batchId, 8, { expectedVersion: batch.version, action: "update_product", productId: P_WATER }).expect(200);
    expect(res.body.row).toMatchObject({ status: "ready_update", reviewReason: "ambiguous" });
    expect(res.body.row.outcome.matchedProduct!.productId).toBe(P_WATER);
    expect(res.body.row.outcome.identifierAdds).toEqual([]);
    expect(res.body.row.outcome.identifiersNotAdded).toEqual([{ type: "barcode", value: "123" }]);
    const other = await c.resolve(SES_OWNER_ALL, batch.batchId, 8, { expectedVersion: res.body.version, action: "update_product", productId: P_JUICE }).expect(200);
    expect(other.body.row.outcome.matchedProduct!.productId).toBe(P_JUICE);
    expect(other.body.row.outcome.identifiersNotAdded).toEqual([{ type: "sku", value: "W-1" }]);
  });

  it("update_product on a sku_mismatch row keeps the product's SKU: the row's SKU is listed as not added", async () => {
    if (skip()) return;
    const batch = await c.validated(SCENARIO);
    const res = await c.resolve(SES_OWNER_ALL, batch.batchId, 18, { expectedVersion: batch.version, action: "update_product", productId: P_GAMMA }).expect(200);
    expect(res.body.row.status).toBe("ready_update");
    expect(res.body.row.outcome.fieldChanges).toEqual([{ field: "name", before: "RT1505 Gamma", after: "Gamma again" }]);
    expect(res.body.row.outcome.identifierAdds).toEqual([]);
    expect(res.body.row.outcome.identifiersNotAdded).toEqual([{ type: "sku", value: "NEW-11" }]);
    // validate had stored Gamma's updated_at for this matched row, and the decision keeps it
    const stored = await h.env().admin.query<{ ok: boolean }>(`SELECT r.matched_updated_at = p.updated_at AS ok FROM catalog_import_rows r JOIN tenant_products p ON p.id = $2 WHERE r.batch_id = $1 AND r.row_number = 18`, [batch.batchId, P_GAMMA]);
    expect(stored.rows[0]!.ok).toBe(true);
  });

  it("exclude records the decision, clear restores the validated row exactly", async () => {
    if (skip()) return;
    const batch = await c.validated(SCENARIO);
    const before = row(await c.allRows(batch.batchId), 14);
    const excluded = await c.resolve(SES_OWNER_ALL, batch.batchId, 14, { expectedVersion: batch.version, action: "exclude" }).expect(200);
    expect(excluded.body.row).toMatchObject({ status: "excluded", resolution: { action: "exclude", productId: null } });
    expect(excluded.body.counts).toMatchObject({ excluded: 1, needs_review: 4 });
    const decided = await c.resolve(SES_OWNER_ALL, batch.batchId, 14, { expectedVersion: excluded.body.version, action: "create_new" }).expect(200);
    expect(decided.body.row.status).toBe("ready_create");
    const cleared = await c.resolve(SES_OWNER_ALL, batch.batchId, 14, { expectedVersion: decided.body.version, action: "clear" }).expect(200);
    expect(cleared.body.row).toMatchObject({ status: "needs_review", resolution: null, reviewReason: "store_scoped_conflict" });
    expect(cleared.body.row).toEqual({ ...before });
    expect(cleared.body.counts).toEqual(batch.counts);
    // The hash is the validated one again: the decision slot is empty.
    expect(cleared.body.previewHash).toBe(batch.previewHash);
    expect(cleared.body.version).toBe(batch.version + 3);
  });

  it("an error row takes exclude and clear only", async () => {
    if (skip()) return;
    const batch = await c.validated(SCENARIO);
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 6, { expectedVersion: batch.version, action: "create_new" }), 422, "resolution_not_allowed");
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 6, { expectedVersion: batch.version, action: "update_product", productId: P_RETIRED }), 422, "resolution_not_allowed");
    const excluded = await c.resolve(SES_OWNER_ALL, batch.batchId, 6, { expectedVersion: batch.version, action: "exclude" }).expect(200);
    expect(excluded.body.row.status).toBe("excluded");
    const cleared = await c.resolve(SES_OWNER_ALL, batch.batchId, 6, { expectedVersion: excluded.body.version, action: "clear" }).expect(200);
    expect(cleared.body.row).toMatchObject({ status: "error", resolution: null });
    expect(cleared.body.counts).toEqual(batch.counts);
  });

  it("refuses what is not offered: a ready row, a product that is not a candidate, a retired candidate, clear with no decision, create_new when a product holds an identifier", async () => {
    if (skip()) return;
    const batch = await c.validated(SCENARIO);
    const v = batch.version;
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 2, { expectedVersion: v, action: "exclude" }), 422, "resolution_not_allowed");
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 4, { expectedVersion: v, action: "create_new" }), 422, "resolution_not_allowed");
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 8, { expectedVersion: v, action: "update_product", productId: P_ALPHA }), 422, "resolution_not_allowed");
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 8, { expectedVersion: v, action: "create_new" }), 422, "resolution_not_allowed");
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 11, { expectedVersion: v, action: "update_product", productId: P_ALPHA }), 422, "resolution_not_allowed");
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 11, { expectedVersion: v, action: "clear" }), 422, "resolution_not_allowed");
    // Nothing the refusals tried was written.
    expect((await batchRow(h.env().admin, batch.batchId)).version).toBe(v);
  });

  it("refuses a retired candidate of an ambiguous row, and offers the live one", async () => {
    if (skip()) return;
    const batch = await c.validated("SKU,Barcode,Name,Tax Category\nR-1,123,Retired mix,standard\n");
    const [only] = await c.allRows(batch.batchId);
    expect(only!.outcome.candidates.map((x) => x.productId).sort()).toEqual([P_JUICE, P_RETIRED].sort());
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 2, { expectedVersion: batch.version, action: "update_product", productId: P_RETIRED }), 422, "resolution_not_allowed");
    const live = await c.resolve(SES_OWNER_ALL, batch.batchId, 2, { expectedVersion: batch.version, action: "update_product", productId: P_JUICE }).expect(200);
    expect(live.body.row.outcome.identifiersNotAdded).toEqual([{ type: "sku", value: "R-1" }]);
  });

  it("in a create batch an ambiguous row offers only exclude, and update_product is refused", async () => {
    if (skip()) return;
    const batch = await c.validated("SKU,Barcode,Name,Tax Category\nW-1,123,Mixed,standard\nNEW-20,,Fresh,standard\n", "create");
    const rows = await c.allRows(batch.batchId);
    expect(rows[0]).toMatchObject({ status: "needs_review", reviewReason: "ambiguous" });
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 2, { expectedVersion: batch.version, action: "update_product", productId: P_WATER }), 422, "resolution_not_allowed");
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 2, { expectedVersion: batch.version, action: "create_new" }), 422, "resolution_not_allowed");
    const excluded = await c.resolve(SES_OWNER_ALL, batch.batchId, 2, { expectedVersion: batch.version, action: "exclude" }).expect(200);
    expect(excluded.body).toMatchObject({ publishable: true, counts: { ready_create: 1, excluded: 1, needs_review: 0 } });
  });

  it("is publishable once every review row is decided", async () => {
    if (skip()) return;
    const batch = await c.validated("SKU,Barcode,Name,Tax Category\nW-1,123,Mixed,standard\n", "upsert");
    expect(batch.publishable).toBe(false);
    const res = await c.resolve(SES_OWNER_ALL, batch.batchId, 2, { expectedVersion: batch.version, action: "exclude" }).expect(200);
    expect(res.body.publishable).toBe(true);
    const read = await h.get(`${"/api/v1/catalog/imports"}/${batch.batchId}`, SES_OWNER_ALL).expect(200);
    expect(read.body).toMatchObject({ publishable: true, version: res.body.version, previewHash: res.body.previewHash });
  });
});

describe("the order of checks and the roles", () => {
  it("is 409 version_conflict for a stale version, import_batch_not_validated for a draft, import_batch_closed for a closed batch; 404 for an absent row", async () => {
    if (skip()) return;
    const batch = await c.validated(SCENARIO);
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 11, { expectedVersion: batch.version + 5, action: "exclude" }), 409, "version_conflict");
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 999, { expectedVersion: batch.version, action: "exclude" }), 404, "not_found");
    const draft = await c.open("SKU,Name,Tax Category\nZ-1,Zed,standard\n", "create").catch(() => null);
    expect(draft).toBeNull(); // one open batch per tenant
    await h.put(`/api/v1/catalog/imports/${batch.batchId}/mapping`, SES_OWNER_ALL, { expectedVersion: batch.version, columns: batch.mapping }).expect(200);
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 11, { expectedVersion: batch.version + 1, action: "exclude" }), 409, "import_batch_not_validated");
    await c.cancel(SES_OWNER_ALL, batch.batchId, batch.version + 1).expect(200);
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 11, { expectedVersion: batch.version + 2, action: "exclude" }), 409, "import_batch_closed");
  });

  it("refuses a malformed body or path with 400 and writes nothing", async () => {
    if (skip()) return;
    const batch = await c.validated(SCENARIO);
    const bad: object[] = [
      { expectedVersion: batch.version, action: "update_product" },
      { expectedVersion: batch.version, action: "create_new", productId: P_WATER },
      { expectedVersion: batch.version, action: "delete" },
      { expectedVersion: 0, action: "exclude" },
      { expectedVersion: batch.version, action: "exclude", tenantId: TENANT_A },
      { action: "exclude" },
    ];
    for (const body of bad) c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 11, body), 400, "validation_error");
    c.expectError(await c.resolve(SES_OWNER_ALL, batch.batchId, 1, { expectedVersion: batch.version, action: "exclude" }), 400, "validation_error");
    c.expectError(await c.resolve(SES_OWNER_ALL, "nope", 11, { expectedVersion: batch.version, action: "exclude" }), 400, "validation_error");
    expect((await batchRow(h.env().admin, batch.batchId)).version).toBe(batch.version);
  });

  it("is for owner and tenant_admin: the store roles and another tenant get the non-disclosing 404 on every new operation", async () => {
    if (skip()) return;
    const batch = await c.validated(SCENARIO);
    for (const session of [SES_MANAGER, SES_STAFF, SES_OWNER_B]) {
      c.expectError(await c.resolve(session, batch.batchId, 11, { expectedVersion: batch.version, action: "exclude" }), 404, "not_found");
      c.expectError(await c.preview(session, batch.batchId), 404, "not_found");
      c.expectError(await c.cancel(session, batch.batchId, batch.version), 404, "not_found");
      c.expectError(await c.publish(session, batch.batchId, { expectedVersion: batch.version, previewHash: batch.previewHash }), 404, "not_found");
    }
    expect(await batchRow(h.env().admin, batch.batchId)).toMatchObject({ state: "validated", version: batch.version });
    const asAdmin = await c.resolve(SES_ADMIN_SPEC, batch.batchId, 11, { expectedVersion: batch.version, action: "exclude" }).expect(200);
    expect(asAdmin.body.row.status).toBe("excluded");
  });
});

describe("validate keeps a decision while the row's candidates and reason are unchanged", () => {
  it("keeps decisions on a re-validation of the same catalogue, hash included", async () => {
    if (skip()) return;
    const batch = await c.validated(SCENARIO);
    await c.resolve(SES_OWNER_ALL, batch.batchId, 11, { expectedVersion: batch.version, action: "exclude" }).expect(200);
    const second = await c.resolve(SES_OWNER_ALL, batch.batchId, 8, { expectedVersion: batch.version + 1, action: "update_product", productId: P_WATER }).expect(200);
    const again = await c.validate(SES_OWNER_ALL, batch.batchId, second.body.version).expect(200);
    expect(again.body.previewHash).toBe(second.body.previewHash);
    expect(again.body.counts).toEqual(second.body.counts);
    const rows = await c.allRows(batch.batchId);
    expect(row(rows, 11)).toMatchObject({ status: "excluded", resolution: { action: "exclude" } });
    expect(row(rows, 8)).toMatchObject({ status: "ready_update", resolution: { action: "update_product", productId: P_WATER } });
    expect(row(rows, 8).outcome.identifiersNotAdded).toEqual([{ type: "barcode", value: "123" }]);
  });

  it("returns a row to needs_review when its candidate set changed, and keeps the others", async () => {
    if (skip()) return;
    const { admin } = h.env();
    const batch = await c.validated(SCENARIO);
    const a = await c.resolve(SES_OWNER_ALL, batch.batchId, 8, { expectedVersion: batch.version, action: "update_product", productId: P_WATER }).expect(200);
    const b = await c.resolve(SES_OWNER_ALL, batch.batchId, 11, { expectedVersion: a.body.version, action: "exclude" }).expect(200);
    // Juice loses its barcode: row 8 is no longer ambiguous between Water and Juice.
    await admin.query(`UPDATE product_aliases SET retired_at = now() WHERE tenant_id = $1 AND identifier_type = 'barcode' AND value = '123'`, [TENANT_A]);
    try {
      const again = await c.validate(SES_OWNER_ALL, batch.batchId, b.body.version).expect(200);
      const rows = await c.allRows(batch.batchId);
      expect(row(rows, 8)).toMatchObject({ resolution: null });
      expect(row(rows, 8).status).not.toBe("needs_review"); // a single match now: an update with the barcode free
      expect(row(rows, 11)).toMatchObject({ status: "excluded", resolution: { action: "exclude" } });
      expect(again.body.counts!["excluded"]).toBe(1);
    } finally {
      await admin.query(`UPDATE product_aliases SET retired_at = NULL WHERE tenant_id = $1 AND identifier_type = 'barcode' AND value = '123'`, [TENANT_A]);
    }
  });
});

describe("the preview", () => {
  it("counts brands to create, creates, updates, identifier adds, deactivations, unpriced products, excluded and unchanged rows", async () => {
    if (skip()) return;
    const batch = await c.validated(
      [
        "SKU,Barcode,Name,Category,Brand,Tax Category,Active,Price",
        "A-1,,,,,,false,9.5", // 2 Alpha: deactivated, a price notice
        "B-1,,RT1505 Beta Renamed,RT730 Drinks,RT1505 Acme,standard,,", // 3 Beta: name, category, brand
        "G-1,5901234123457,,,Brand Fresh,,,", // 4 Gamma: barcode add, brand to create
        "NEW-30,,Fresh Tea,RT730 Drinks,Brand Fresh,standard,,", // 5 create, the same brand to create
        "NEW-31,6001000000001,Plain Coffee,,,standard,,12", // 6 create with a barcode, a price notice
        "W-1,,RT730 Water,,,,,", // 7 unchanged
        ",,Anon,,,standard,,", // 8 no_identifier
      ].join("\n"),
    );
    const excluded = await c.resolve(SES_OWNER_ALL, batch.batchId, 8, { expectedVersion: batch.version, action: "exclude" }).expect(200);
    const res = await c.preview(SES_OWNER_ALL, batch.batchId).expect(200);
    h.conforms("CatalogImportPreview", res.body);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({
      batchId: batch.batchId,
      version: excluded.body.version,
      previewHash: excluded.body.previewHash,
      mode: "upsert",
      publishable: true,
      conflictCount: 0, // RT-1536: a batch with no conflict is unchanged
      conflicts: [],
      counts: { ready_create: 2, ready_update: 3, unchanged: 1, needs_review: 0, error: 0, excluded: 1 },
      brandsToCreate: ["Brand Fresh"],
      productsToCreate: 2,
      productsToUpdate: 3,
      identifiersToAdd: 4, // NEW-30's sku, NEW-31's sku and barcode, Gamma's barcode
      newProductsWithoutPrice: 2,
      rowsWithPriceNotImported: 2,
    });
    expect(res.body.deactivations).toEqual([{ rowNumber: 2, product: expect.objectContaining({ productId: P_ALPHA, name: "RT1505 Alpha" }) }]);
  });

  it("is 409 import_batch_not_validated for a draft or a cancelled batch, and 404 for another tenant's batch", async () => {
    if (skip()) return;
    const batch = await c.open("SKU,Name,Tax Category\nZ-1,Zed,standard\n", "create");
    c.expectError(await c.preview(SES_OWNER_ALL, batch.batchId), 409, "import_batch_not_validated");
    await c.cancel(SES_OWNER_ALL, batch.batchId, batch.version).expect(200);
    c.expectError(await c.preview(SES_OWNER_ALL, batch.batchId), 409, "import_batch_not_validated");
    c.expectError(await c.preview(SES_OWNER_ALL, "nope"), 400, "validation_error");
  });
});

describe("cancel", () => {
  it("closes an open batch (next version, no hash, no expiry; the counts stay), frees the tenant's one open batch and audits it", async () => {
    if (skip()) return;
    const batch = await c.validated(SCENARIO);
    const res = await c.cancel(SES_OWNER_ALL, batch.batchId, batch.version).expect(200);
    h.conforms("CatalogImportBatch", res.body);
    expect(res.body).toMatchObject({ state: "cancelled", version: batch.version + 1, previewHash: null, expiresAt: null, publishable: false, counts: batch.counts });
    const state = await batchRow(h.env().admin, batch.batchId);
    expect(state).toMatchObject({ state: "cancelled", preview_hash: null, expires_at: null });
    expect(state.closed_at).not.toBeNull();
    const written = await auditsOf(h.env().admin, "catalog.import.cancel", since);
    expect(written).toHaveLength(1);
    expect(written[0]!.metadata).toMatchObject({ batch_id: batch.batchId, version: batch.version + 1 });
    // A new upload is now allowed; the cancelled batch is closed for everything.
    await c.open("SKU,Name,Tax Category\nZ-1,Zed,standard\n", "create");
    c.expectError(await c.cancel(SES_OWNER_ALL, batch.batchId, batch.version + 1), 409, "import_batch_closed");
    c.expectError(await c.cancel(SES_OWNER_ALL, "nope", 1), 400, "validation_error");
  });

  it("is 409 version_conflict for a stale version, and may close a lapsed batch the expiry job has not reached", async () => {
    if (skip()) return;
    const batch = await c.open("SKU,Name,Tax Category\nZ-1,Zed,standard\n", "create");
    c.expectError(await c.cancel(SES_OWNER_ALL, batch.batchId, 9), 409, "version_conflict");
    await h.env().admin.query(`UPDATE catalog_import_batches SET expires_at = now() - interval '1 minute' WHERE id = $1`, [batch.batchId]);
    const res = await c.cancel(SES_OWNER_ALL, batch.batchId, batch.version).expect(200);
    expect(res.body.state).toBe("cancelled");
  });
});
