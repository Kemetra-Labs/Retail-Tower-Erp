import { expectNoAxeViolations } from "./axe";
import { BATCH_ID, err, mockImportApi } from "./catalog-import-mock";
import { expect, test } from "./fixtures";

/**
 * RT-1509 (spec 049 S7) step 1, «رفع الملف», against a mocked Backend-Core (C-5).
 *   S1 role gating: the entry is on Products for an owner and absent for a store role; a direct URL
 *      is the non-disclosing "not available".
 *   S2 the upload: no default mode (the primary waits, the reason in text), the raw file goes up with
 *      the mode and file name as query values and an Idempotency-Key, then the batch opens at Map.
 *   S3 a refused file is shown by its code, linked to the file button, and nothing was created.
 *   S4 an unclear answer resends the SAME file under the SAME key; a changed option takes a new key.
 *   S5 `409 import_batch_open` offers resume or cancel; the cancel dialog starts on «إبقاء».
 * Runs in both locales; copy comes from the catalog (`t`). axe (WCAG 2.1 A/AA) runs on the screen.
 */
const FILE = {
  name: "products-nov.xlsx",
  mimeType: "application/octet-stream",
  buffer: Buffer.from("PK-not-really-a-workbook"),
};

test("S1: owner sees the entry on Products; a store role does not and the URL is not available", async ({
  page,
  t,
}) => {
  await mockImportApi(page, "owner");
  await page.goto("/catalog/products");
  const link = page.getByRole("link", { name: t("catalogImport.nav.link") });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/catalog\/import$/);
  await expect(
    page.getByRole("heading", { level: 1, name: t("catalogImport.title") }),
  ).toBeVisible();
});

test("S1b: a store manager has no entry and no form", async ({ page, t }) => {
  await mockImportApi(page, "store_manager");
  await page.goto("/catalog/products");
  await expect(page.getByRole("link", { name: t("catalogImport.nav.link") })).toHaveCount(0);
  await page.goto("/catalog/import");
  await expect(page.getByText(t("catalogImport.error.notAvailable"))).toBeVisible();
  await expect(page.getByRole("button", { name: t("catalogImport.upload.submit") })).toHaveCount(0);
});

test("S2: no default mode; the raw file goes up with the mode, the file name and a key", async ({
  page,
  t,
}) => {
  const fake = await mockImportApi(page);
  await page.goto("/catalog/import");
  await expect(
    page.getByRole("heading", { level: 1, name: t("catalogImport.title") }),
  ).toBeVisible();
  await expectNoAxeViolations(page, "upload");

  const submit = page.getByRole("button", { name: t("catalogImport.upload.submit") });
  await expect(submit).toBeDisabled();
  await expect(page.getByText(t("catalogImport.upload.blocked.both"))).toBeVisible();

  await page
    .getByRole("radio", { name: new RegExp(t("catalogImport.upload.mode.create")) })
    .check();
  await page.locator('input[type="file"]').setInputFiles(FILE);
  await expect(page.getByText(FILE.name)).toBeVisible();
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page).toHaveURL(new RegExp(`/catalog/import/${BATCH_ID}/map$`));
  const [up] = fake.to("POST", "/catalog/imports");
  expect(up?.query.get("mode")).toBe("create");
  expect(up?.query.get("file_name")).toBe(FILE.name);
  expect(up?.query.has("sheet")).toBe(false);
  expect(up?.headers["content-type"]).toBe("application/octet-stream");
  expect(up?.headers["idempotency-key"]).toMatch(/^[\x21-\x7E]{16,128}$/);
  expect(up?.body).toBe("PK-not-really-a-workbook");
});

test("S3: a refused file is shown by its code, linked to the file button", async ({ page, t }) => {
  const fake = await mockImportApi(page);
  fake.upload.push(err(422, "encoding_not_utf8"));
  await page.goto("/catalog/import");
  await page
    .getByRole("radio", { name: new RegExp(t("catalogImport.upload.mode.upsert")) })
    .check();
  await page.locator('input[type="file"]').setInputFiles({ ...FILE, name: "latin1.csv" });
  await page.getByRole("button", { name: t("catalogImport.upload.submit") }).click();

  const message = page.getByText(t("catalogImport.error.encoding_not_utf8"), { exact: false });
  await expect(message).toBeVisible();
  await expect(page.getByText("req_3f9c1a")).toBeVisible();
  const choose = page.getByRole("button", { name: t("catalogImport.upload.file.chooseAnother") });
  await expect(choose).toHaveAttribute("aria-describedby", /-err/);
  await expect(page).toHaveURL(/\/catalog\/import$/);
  await expectNoAxeViolations(page, "upload refused");
});

test("S4: an unclear answer resends the same file under the same key", async ({ page, t }) => {
  const fake = await mockImportApi(page);
  fake.upload.push("abort");
  await page.goto("/catalog/import");
  await page
    .getByRole("radio", { name: new RegExp(t("catalogImport.upload.mode.upsert")) })
    .check();
  await page.locator('input[type="file"]').setInputFiles(FILE);
  await page.getByRole("button", { name: t("catalogImport.upload.submit") }).click();

  await expect(page.getByText(t("catalogImport.upload.unclear.title"))).toBeVisible();
  await expectNoAxeViolations(page, "upload unclear");
  await page.getByRole("button", { name: t("catalogImport.upload.unclear.resend") }).click();
  await expect(page).toHaveURL(new RegExp(`/catalog/import/${BATCH_ID}/map$`));

  const [first, second] = fake.to("POST", "/catalog/imports");
  expect(second?.headers["idempotency-key"]).toBe(first?.headers["idempotency-key"]);
  expect(second?.body).toBe(first?.body);
  expect(second?.query.toString()).toBe(first?.query.toString());
});

test("S4b: changing an option after an unclear answer takes a new key", async ({ page, t }) => {
  const fake = await mockImportApi(page);
  fake.upload.push("abort");
  await page.goto("/catalog/import");
  await page
    .getByRole("radio", { name: new RegExp(t("catalogImport.upload.mode.upsert")) })
    .check();
  await page.locator('input[type="file"]').setInputFiles(FILE);
  await page.getByRole("button", { name: t("catalogImport.upload.submit") }).click();
  await expect(page.getByText(t("catalogImport.upload.unclear.title"))).toBeVisible();

  await page
    .getByRole("radio", { name: new RegExp(t("catalogImport.upload.mode.create")) })
    .check();
  await page.getByRole("button", { name: t("catalogImport.upload.submit") }).click();
  await expect(page).toHaveURL(new RegExp(`/catalog/import/${BATCH_ID}/map$`));
  const [first, second] = fake.to("POST", "/catalog/imports");
  expect(second?.headers["idempotency-key"]).not.toBe(first?.headers["idempotency-key"]);
});

test("S5: an open batch offers resume or cancel; the cancel dialog starts on «keep»", async ({
  page,
  t,
}) => {
  const fake = await mockImportApi(page);
  fake.upload.push(err(409, "import_batch_open", { openBatchId: BATCH_ID }));
  await page.goto("/catalog/import");
  await page
    .getByRole("radio", { name: new RegExp(t("catalogImport.upload.mode.upsert")) })
    .check();
  await page.locator('input[type="file"]').setInputFiles(FILE);
  await page.getByRole("button", { name: t("catalogImport.upload.submit") }).click();

  await expect(page.getByRole("heading", { name: t("catalogImport.open.title") })).toBeVisible();
  await expectNoAxeViolations(page, "open batch");

  await page.getByRole("button", { name: t("catalogImport.cancel.action") }).click();
  const keep = page.getByRole("button", { name: t("catalogImport.cancelDialog.keep") });
  await expect(keep).toBeFocused();
  await expectNoAxeViolations(page, "cancel dialog");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: t("catalogImport.cancelDialog.confirm") })
    .click();
  await expect(page.getByRole("heading", { name: t("catalogImport.open.title") })).toHaveCount(0);
  const [cancel] = fake.to("POST", "/cancel");
  expect(JSON.parse(cancel?.body ?? "{}")).toEqual({ expectedVersion: 1 });
});

test("S6: the template downloads in the chosen language", async ({ page, t }) => {
  const fake = await mockImportApi(page);
  await page.goto("/catalog/import");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: `${t("catalogImport.upload.template.link")} · ${t("catalogImport.upload.template.en")}`,
    })
    .click();
  expect((await download).suggestedFilename()).toBe("template-en.csv");
  expect(fake.to("GET", "/import-template")[0]?.query.get("headers")).toBe("en");
});
