import { expectNoAxeViolations } from "./axe";
import {
  BATCH_ID,
  COLUMNS,
  ERROR_ROW,
  batchBody,
  err,
  mockImportApi,
  row,
  validatedBatch,
} from "./catalog-import-mock";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1509 steps 2 and 3, «ربط الأعمدة» and «التحقق», against a mocked Backend-Core (C-5).
 *   M1 the server's suggestion pre-fills the selects, unplaced columns are «سيتم تجاهله» and named,
 *      the price column says it is not imported; «تحقق» saves the mapping (every column once) and
 *      validates, then the batch is at Validate.
 *   M2 a duplicate target is marked and blocks the primary, with the reason in text.
 *   M3 a refused mapping stays on Map. M4 «استبدال الملف» replaces the file and resets the mapping.
 *   V1 the status band's counts are the server's and filter the rows (the filter is in the URL);
 *      issues read in words by code, never the wire text; the error report downloads.
 *   V2 a failed continuation keeps the rows already shown. V3 a reload returns to the same step.
 *   V4 a draft batch with a mapping asks for a validation.
 * Runs in both locales; copy comes from the catalog (`t`). axe runs on every screen.
 */
async function ready(page: Page, heading: string) {
  await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
}

test("M1: suggestion pre-filled, ignored columns named; «validate» saves the mapping then validates", async ({
  page,
  t,
}) => {
  const fake = await mockImportApi(page);
  fake.batch = batchBody();
  fake.rows = { all: [ERROR_ROW], error: [ERROR_ROW] };
  await page.goto(`/catalog/import/${BATCH_ID}/map`);
  await ready(page, t("catalogImport.step.map"));

  const sku = page.getByRole("combobox", {
    name: t("catalogImport.map.select", { header: COLUMNS[0]?.header ?? "" }),
  });
  await expect(sku).toHaveValue("sku");
  await expect(
    page.getByRole("combobox", { name: t("catalogImport.map.select", { header: "ملاحظات" }) }),
  ).toHaveValue("ignore");
  await expect(page.getByText(t("catalogImport.map.ignored.title", { count: 2 }))).toBeVisible();
  await expect(page.getByText(t("catalogImport.map.priceNotice"))).toBeVisible();
  await expectNoAxeViolations(page, "map");

  await page.getByRole("button", { name: t("catalogImport.map.submit") }).click();
  await expect(page).toHaveURL(new RegExp(`/catalog/import/${BATCH_ID}/validate`));

  const [mapping] = fake.to("PUT", "/mapping");
  const body = JSON.parse(mapping?.body ?? "{}") as {
    expectedVersion: number;
    columns: { columnNumber: number; target: string }[];
    saveProfileName?: string;
  };
  expect(body.expectedVersion).toBe(1);
  expect(body.columns).toHaveLength(7);
  expect(body.columns.find((c) => c.columnNumber === 7)?.target).toBe("ignore");
  expect(body.saveProfileName).toBeUndefined();
  const [validate] = fake.to("POST", "/validate");
  expect(JSON.parse(validate?.body ?? "{}")).toEqual({ expectedVersion: 2 });
});

test("M2: a duplicate target is marked and blocks «validate» with the reason in text", async ({
  page,
  t,
}) => {
  await mockImportApi(page);
  await page.goto(`/catalog/import/${BATCH_ID}/map`);
  await ready(page, t("catalogImport.step.map"));
  const note = page.getByRole("combobox", {
    name: t("catalogImport.map.select", { header: "ملاحظات" }),
  });
  await note.selectOption("name");
  await expect(
    page
      .getByText(t("catalogImport.map.duplicate", { field: t("catalogImport.field.name") }))
      .first(),
  ).toBeVisible();
  const submit = page.getByRole("button", { name: t("catalogImport.map.submit") });
  await expect(submit).toBeDisabled();
  await expect(page.getByText(t("catalogImport.map.blocked"))).toBeVisible();
  await expectNoAxeViolations(page, "map duplicate");
});

test("M3: a refused mapping stays on Map with the server's reason by code", async ({ page, t }) => {
  const fake = await mockImportApi(page);
  fake.mappingAnswer = err(422, "mapping_invalid");
  await page.goto(`/catalog/import/${BATCH_ID}/map`);
  await ready(page, t("catalogImport.step.map"));
  await page.getByRole("button", { name: t("catalogImport.map.submit") }).click();
  await expect(page.getByText(t("catalogImport.error.mapping_invalid"))).toBeVisible();
  await expect(page).toHaveURL(/\/map$/);
  await expectNoAxeViolations(page, "map refused");
});

test("M4: «replace file» sends the new bytes with expected_version and resets the mapping", async ({
  page,
  t,
}) => {
  const fake = await mockImportApi(page);
  await page.goto(`/catalog/import/${BATCH_ID}/map`);
  await ready(page, t("catalogImport.step.map"));
  await page.locator('input[type="file"]').setInputFiles({
    name: "fixed.xlsx",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("fixed-bytes"),
  });
  await expect(page.getByText(t("catalogImport.map.replaced.title"))).toBeVisible();
  const [put] = fake.to("PUT", "/file");
  expect(put?.query.get("expected_version")).toBe("1");
  expect(put?.query.get("file_name")).toBe("fixed.xlsx");
  expect(put?.body).toBe("fixed-bytes");
  await expectNoAxeViolations(page, "map replaced");
});

test("M5: a previously published file is a notice, not a refusal", async ({ page, t }) => {
  const fake = await mockImportApi(page);
  fake.batch = batchBody({
    warnings: [
      {
        code: "file_previously_published",
        publishedBatchId: BATCH_ID,
        publishedAt: "2026-11-14T10:00:00Z",
      },
    ],
  });
  await page.goto(`/catalog/import/${BATCH_ID}/map`);
  await expect(page.getByText(t("catalogImport.map.previouslyPublished.title"))).toBeVisible();
  await expect(page.getByRole("button", { name: t("catalogImport.map.submit") })).toBeEnabled();
});

test("V1: counts are the server's and filter the rows; issues read by code; error report downloads", async ({
  page,
  t,
}) => {
  const fake = await mockImportApi(page);
  fake.batch = validatedBatch();
  fake.rows = {
    all: [row(2, "ready_create"), ERROR_ROW],
    error: [ERROR_ROW],
  };
  await page.goto(`/catalog/import/${BATCH_ID}/validate`);
  await ready(page, t("catalogImport.step.validate"));
  const band = page.getByRole("group", { name: t("catalogImport.validate.band") });
  await expect(band.getByRole("button", { name: /812/ })).toBeVisible();
  await expect(band.getByRole("button", { name: /1,?240|١٬٢٤٠/ })).toBeVisible();
  await expectNoAxeViolations(page, "validate");

  await band.getByRole("button", { name: new RegExp(t("catalogImport.status.error")) }).click();
  await expect(page).toHaveURL(/status=error/);
  await expect(page.getByText(/wire english text/)).toHaveCount(0);
  await expect(
    page.getByText(
      t("catalogImport.issue.identifier_numeric_cell", { field: t("catalogImport.field.barcode") }),
      {
        exact: false,
      },
    ),
  ).toBeVisible();
  await expect(page.getByText("6.22103E+12")).toBeVisible();
  await expectNoAxeViolations(page, "validate filtered");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: t("catalogImport.validate.errorReport") }).click();
  expect((await download).suggestedFilename()).toBe("errors.csv");
});

test("V2: a failed continuation keeps the rows already shown, and retrying walks on", async ({
  page,
  t,
}) => {
  const fake = await mockImportApi(page);
  fake.batch = validatedBatch();
  fake.pageSize = 1;
  fake.failRowPages = 1;
  fake.rows = { all: [row(2, "ready_create"), row(3, "ready_create")] };
  await page.goto(`/catalog/import/${BATCH_ID}/validate`);
  await ready(page, t("catalogImport.step.validate"));
  await expect(page.getByRole("row", { name: /SKU-2/ })).toBeVisible();
  await page.getByRole("button", { name: t("catalogImport.validate.loadMore") }).click();
  await expect(page.getByText(t("catalogImport.validate.loadMoreFailed.title"))).toBeVisible();
  await expect(page.getByRole("row", { name: /SKU-2/ })).toBeVisible();
  await expectNoAxeViolations(page, "validate load-more failure");
  await page.getByRole("button", { name: t("catalogImport.validate.loadMore") }).click();
  await expect(page.getByRole("row", { name: /SKU-3/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /SKU-2/ })).toBeVisible();
});

test("V3: a reload returns to the same step and filter", async ({ page, t }) => {
  const fake = await mockImportApi(page);
  fake.batch = validatedBatch();
  fake.rows = { all: [row(2, "ready_create")], error: [ERROR_ROW] };
  await page.goto(`/catalog/import/${BATCH_ID}/validate?status=error`);
  await ready(page, t("catalogImport.step.validate"));
  await page.reload();
  await ready(page, t("catalogImport.step.validate"));
  await expect(page).toHaveURL(/status=error/);
});

test("V4: a draft batch with a mapping asks for a validation, then shows the result", async ({
  page,
  t,
}) => {
  const fake = await mockImportApi(page);
  fake.batch = batchBody({ version: 2, mapping: [{ columnNumber: 1, target: "sku" }] });
  fake.rows = { all: [row(2, "ready_create")] };
  await page.goto(`/catalog/import/${BATCH_ID}`);
  await expect(page).toHaveURL(/\/validate$/);
  await expect(page.getByText(t("catalogImport.validate.needed.title"))).toBeVisible();
  await expectNoAxeViolations(page, "validate needed");
  await page.getByRole("button", { name: t("catalogImport.validate.again") }).click();
  await expect(page.getByRole("group", { name: t("catalogImport.validate.band") })).toBeVisible();
  expect(JSON.parse(fake.to("POST", "/validate")[0]?.body ?? "{}")).toEqual({ expectedVersion: 2 });
});
