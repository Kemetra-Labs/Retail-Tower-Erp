import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AMBIGUOUS_ROW,
  BATCH_ID,
  COUNTS,
  ERROR_ROW,
  NO_ID_ROW,
  batchBody,
  mockImportApi,
  previewBody,
  row,
  validatedBatch,
} from "../e2e/catalog-import-mock";
import { type Page, test } from "../e2e/fixtures";

/**
 * RT-1509 (spec 049 S7): evidence captures of the product import workspace, one per step and its
 * key states, taken in CI only (owner rule: no browser on the owner's laptop) through the
 * `admin-captures` workflow, with Backend-Core mocked. Saved in the locale project that runs it
 * (Arabic is RTL, English is the control):
 *   step-1-upload, step-1-open-batch, step-2-map, step-3-validate, step-4-review, step-4-review-drawer,
 *   step-5-preview, step-6-publish-confirm, step-6-publish-unclear, step-7-result
 * It records what it shows; it fails only if the page crashes. The RT-1536 conflict state has no
 * capture: the contract does not carry it yet (see RT-1509 and the adapter in catalogImportLogic).
 */
const OUT = process.env.CAPTURE_DIR ?? "playwright-report/captures";
const TICKET = "RT-1509";
mkdirSync(OUT, { recursive: true });

const READY = { ...COUNTS, needs_review: 0, error: 0 };

async function shot(page: Page, name: string, locale: string): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: join(OUT, `${TICKET}__${name}__${locale}.png`), fullPage: true });
}

test("import workspace: upload and the open batch", async ({ page, appLocale, t }) => {
  const fake = await mockImportApi(page);
  fake.upload.push({
    status: 409,
    body: { error: { code: "import_batch_open", request_id: "req_x", openBatchId: BATCH_ID } },
  });
  fake.batch = validatedBatch({ counts: { ...COUNTS, needs_review: 18, error: 9 } });
  await page.goto("/catalog/import");
  await page.getByRole("heading", { level: 1 }).waitFor();
  await shot(page, "step-1-upload", appLocale);
  await page
    .getByRole("radio", { name: new RegExp(t("catalogImport.upload.mode.upsert")) })
    .check();
  await page
    .locator('input[type="file"]')
    .setInputFiles({
      name: "products-nov.xlsx",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("x"),
    });
  await page.getByRole("button", { name: t("catalogImport.upload.submit") }).click();
  await page.getByRole("heading", { name: t("catalogImport.open.title") }).waitFor();
  await shot(page, "step-1-open-batch", appLocale);
});

test("import workspace: map, validate, review", async ({ page, appLocale, t }) => {
  const fake = await mockImportApi(page);
  fake.batch = batchBody();
  await page.goto(`/catalog/import/${BATCH_ID}/map`);
  await page.getByRole("heading", { level: 2, name: t("catalogImport.step.map") }).waitFor();
  await shot(page, "step-2-map", appLocale);

  fake.batch = validatedBatch({ counts: { ...COUNTS, needs_review: 2, error: 1 } });
  fake.rows = {
    all: [row(2, "ready_create"), ERROR_ROW, AMBIGUOUS_ROW],
    needs_review: [AMBIGUOUS_ROW, NO_ID_ROW],
    error: [ERROR_ROW],
  };
  await page.goto(`/catalog/import/${BATCH_ID}/validate`);
  await page.getByRole("heading", { level: 2, name: t("catalogImport.step.validate") }).waitFor();
  await page.getByRole("row", { name: /14/ }).waitFor();
  await shot(page, "step-3-validate", appLocale);

  await page.goto(`/catalog/import/${BATCH_ID}/review`);
  await page.getByRole("button", { name: t("catalogImport.review.openRow", { row: 31 }) }).click();
  await page.getByRole("dialog").waitFor();
  await shot(page, "step-4-review-drawer", appLocale);
  await page.keyboard.press("Escape");
  await shot(page, "step-4-review", appLocale);
});

test("import workspace: preview, publish, result", async ({ page, appLocale, t }) => {
  const fake = await mockImportApi(page);
  fake.batch = validatedBatch({ version: 4, counts: READY, publishable: true });
  fake.preview = previewBody();
  await page.goto(`/catalog/import/${BATCH_ID}/preview`);
  await page.getByRole("button", { name: t("catalogImport.preview.publish") }).waitFor();
  await shot(page, "step-5-preview", appLocale);

  await page.getByRole("button", { name: t("catalogImport.preview.publish") }).click();
  await page.getByRole("dialog").waitFor();
  await shot(page, "step-6-publish-confirm", appLocale);

  fake.publish.push("abort");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: t("catalogImport.publish.confirm") })
    .click();
  await page.getByText(t("catalogImport.publish.unclear.heading")).waitFor();
  await shot(page, "step-6-publish-unclear", appLocale);

  await page
    .getByRole("dialog")
    .getByRole("button", { name: t("catalogImport.publish.unclear.resend") })
    .click();
  await page.getByRole("heading", { level: 2, name: t("catalogImport.step.result") }).waitFor();
  await page.getByText(t("catalogImport.result.title"), { exact: true }).waitFor();
  await shot(page, "step-7-result", appLocale);
});
