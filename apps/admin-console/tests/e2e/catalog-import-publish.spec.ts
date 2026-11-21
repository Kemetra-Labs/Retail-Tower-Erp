import { expectNoAxeViolations } from "./axe";
import {
  BATCH_ID,
  COUNTS,
  SUMMARY,
  batchBody,
  err,
  mockImportApi,
  previewBody,
  validatedBatch,
} from "./catalog-import-mock";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1509 steps 6 and 7, «النشر» and «النتيجة», against a mocked Backend-Core (C-5).
 *   P1 the confirm modal starts on «إلغاء», traps Tab, and its commit is the strong neutral button
 *      (not the red one); a confirmed publish sends the version and `previewHash` the merchant saw
 *      under an Idempotency-Key, and only the server's `200` opens the Result.
 *   P2 an unclear answer never says «published»: resend carries the SAME key and body, «refresh
 *      status» reads the batch, and after closing the modal every other action stays disabled.
 *   P3 `409 stale_validation` returns to Validate with a persistent notice; `preview_changed` and
 *      `import_not_publishable` stay on Preview with their notice; a 425 waits before a resend.
 *   P4 a replay (`Idempotent-Replayed`) and a reopened published batch say it is the stored result.
 * Runs in both locales; copy comes from the catalog (`t`). axe runs on every screen and state.
 */
const READY = { ...COUNTS, needs_review: 0, error: 0 };

async function atPreview(page: Page) {
  const fake = await mockImportApi(page);
  fake.batch = validatedBatch({ version: 4, counts: READY, publishable: true });
  fake.preview = previewBody();
  return fake;
}

async function openDialog(page: Page, t: (k: never, p?: never) => string) {
  await page.goto(`/catalog/import/${BATCH_ID}/preview`);
  await page.getByRole("button", { name: t("catalogImport.preview.publish" as never) }).click();
  return page.getByRole("dialog");
}

test("P1: the modal starts on cancel, traps Tab, commits neutral; the server's 200 opens the result", async ({
  page,
  t,
}) => {
  const fake = await atPreview(page);
  const dialog = await openDialog(page, t as never);
  const cancel = dialog.getByRole("button", { name: t("catalogImport.publish.cancel") });
  const confirm = dialog.getByRole("button", { name: t("catalogImport.publish.confirm") });
  await expect(cancel).toBeFocused();
  await expect(confirm).toHaveClass(/btn-primary/);
  await expect(confirm).not.toHaveClass(/btn-destructive/);
  await expect(dialog.getByText(t("catalogImport.publish.consequence"))).toBeVisible();
  await expectNoAxeViolations(page, "publish confirm");

  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirm).toBeFocused();

  await confirm.click();
  await expect(page).toHaveURL(new RegExp(`/catalog/import/${BATCH_ID}/result$`));
  await expect(
    page.getByRole("heading", { level: 2, name: t("catalogImport.step.result") }),
  ).toBeFocused();
  await expect(page.getByText(t("catalogImport.result.title"), { exact: true })).toBeVisible();
  await expect(page.getByText(t("catalogImport.result.replay.title"))).toHaveCount(0);
  await expect(page.getByText(BATCH_ID)).toBeVisible();
  const [publish] = fake.to("POST", "/publish");
  expect(JSON.parse(publish?.body ?? "{}")).toEqual({
    expectedVersion: 4,
    previewHash: "sha256:bbbb",
  });
  expect(publish?.headers["idempotency-key"]).toMatch(/^[\x21-\x7E]{16,128}$/);
  await expectNoAxeViolations(page, "result");
});

test("P1b: escape cancels the confirm and nothing is sent", async ({ page, t }) => {
  const fake = await atPreview(page);
  const dialog = await openDialog(page, t as never);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(fake.to("POST", "/publish")).toHaveLength(0);
});

test("P2: an unclear publish is resent as it was; closing it keeps every other action disabled", async ({
  page,
  t,
}) => {
  const fake = await atPreview(page);
  fake.publish.push("abort");
  const dialog = await openDialog(page, t as never);
  await dialog.getByRole("button", { name: t("catalogImport.publish.confirm") }).click();

  await expect(
    page.getByRole("dialog").getByText(t("catalogImport.publish.unclear.heading")),
  ).toBeVisible();
  await expect(page.getByText(t("catalogImport.result.title"), { exact: true })).toHaveCount(0);
  await expectNoAxeViolations(page, "publish unclear");

  await page
    .getByRole("dialog")
    .getByRole("button", { name: t("catalogImport.publish.unclear.close") })
    .click();
  await expect(page.getByText(t("catalogImport.publish.persistent.title"))).toBeVisible();
  await expect(
    page.getByRole("button", { name: t("catalogImport.preview.publish") }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: t("catalogImport.cancel.action") })).toBeDisabled();
  await expectNoAxeViolations(page, "publish unclear persistent");

  await page.getByRole("button", { name: t("catalogImport.publish.unclear.resend") }).click();
  await expect(page).toHaveURL(/\/result$/);
  const [first, second] = fake.to("POST", "/publish");
  expect(second?.headers["idempotency-key"]).toBe(first?.headers["idempotency-key"]);
  expect(second?.body).toBe(first?.body);
});

test("P2b: «refresh status» reads the batch; a published one opens the stored result", async ({
  page,
  t,
}) => {
  const fake = await atPreview(page);
  fake.publish.push("abort");
  const dialog = await openDialog(page, t as never);
  await dialog.getByRole("button", { name: t("catalogImport.publish.confirm") }).click();
  fake.batch = batchBody({
    state: "published",
    version: 5,
    publishedAt: "2026-11-21T19:47:00Z",
    counts: READY,
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: t("catalogImport.publish.unclear.refresh") })
    .click();
  await expect(page).toHaveURL(/\/result$/);
  await expect(page.getByText(t("catalogImport.result.replay.title"))).toBeVisible();
  await expectNoAxeViolations(page, "result stored");
});

test("P2c: a status check that finds the batch unpublished says so and offers the resend", async ({
  page,
  t,
}) => {
  const fake = await atPreview(page);
  fake.publish.push("abort");
  const dialog = await openDialog(page, t as never);
  await dialog.getByRole("button", { name: t("catalogImport.publish.confirm") }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: t("catalogImport.publish.unclear.refresh") })
    .click();
  await expect(page.getByText(t("catalogImport.publish.unclear.notPublished"))).toBeVisible();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: t("catalogImport.publish.unclear.resend") }),
  ).toBeEnabled();
});

test("P3a: stale_validation returns to Validate with a persistent notice", async ({ page, t }) => {
  const fake = await atPreview(page);
  fake.publish.push(err(409, "stale_validation"));
  const dialog = await openDialog(page, t as never);
  fake.batch = batchBody({ version: 5, mapping: [{ columnNumber: 1, target: "sku" }] });
  await dialog.getByRole("button", { name: t("catalogImport.publish.confirm") }).click();
  await expect(page).toHaveURL(/\/validate$/);
  await expect(page.getByText(t("catalogImport.validate.stale.title"))).toBeVisible();
  await expect(page.getByText(t("catalogImport.result.title"), { exact: true })).toHaveCount(0);
  await expectNoAxeViolations(page, "validate stale");
});

test("P3b: preview_changed and import_not_publishable stay on Preview with their notice", async ({
  page,
  t,
}) => {
  const fake = await atPreview(page);
  fake.publish.push(err(409, "preview_changed"), err(409, "import_not_publishable"));
  const dialog = await openDialog(page, t as never);
  await dialog.getByRole("button", { name: t("catalogImport.publish.confirm") }).click();
  await expect(page.getByText(t("catalogImport.preview.changed.title"))).toBeVisible();
  await expect(page).toHaveURL(/\/preview$/);
  await expectNoAxeViolations(page, "preview changed");

  await page.getByRole("button", { name: t("catalogImport.preview.publish") }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: t("catalogImport.publish.confirm") })
    .click();
  await expect(page.getByText(t("catalogImport.preview.notPublishable.title"))).toBeVisible();
  await expect(page).toHaveURL(/\/preview$/);
  await expectNoAxeViolations(page, "preview not publishable");
});

test("P3c: a 425 waits for Retry-After before a resend, then resends the same key", async ({
  page,
  t,
}) => {
  const fake = await atPreview(page);
  fake.publish.push({
    status: 425,
    headers: { "retry-after": "2" },
    body: { error: "idempotency_in_progress", retryAfterSec: 2 },
  });
  const dialog = await openDialog(page, t as never);
  await dialog.getByRole("button", { name: t("catalogImport.publish.confirm") }).click();
  const resend = page
    .getByRole("dialog")
    .getByRole("button", { name: t("catalogImport.publish.unclear.resend") });
  await expect(resend).toBeDisabled();
  await expect(resend).toBeEnabled({ timeout: 6000 });
  await resend.click();
  await expect(page).toHaveURL(/\/result$/);
  const [first, second] = fake.to("POST", "/publish");
  expect(second?.headers["idempotency-key"]).toBe(first?.headers["idempotency-key"]);
});

test("P4a: a replay says it is the stored result", async ({ page, t }) => {
  const fake = await atPreview(page);
  fake.publish.push({
    status: 200,
    headers: { "idempotent-replayed": "true" },
    body: {
      batch: batchBody({
        state: "published",
        version: 5,
        publishedAt: "2026-11-21T19:47:00Z",
        counts: READY,
      }),
      summary: SUMMARY,
    },
  });
  const dialog = await openDialog(page, t as never);
  await dialog.getByRole("button", { name: t("catalogImport.publish.confirm") }).click();
  await expect(page.getByText(t("catalogImport.result.replay.title"))).toBeVisible();
});

test("P4b: reopening a published batch reads the stored result and copies the reference", async ({
  page,
  t,
  context,
}) => {
  const fake = await mockImportApi(page);
  fake.batch = batchBody({
    state: "published",
    version: 5,
    publishedAt: "2026-11-21T19:47:00Z",
    counts: READY,
  });
  fake.preview = previewBody();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
  await page.goto(`/catalog/import/${BATCH_ID}`);
  await expect(page).toHaveURL(/\/result$/);
  await expect(page.getByText(t("catalogImport.result.replay.title"))).toBeVisible();
  await expect(page.getByText(t("catalogImport.result.unpriced", { count: 812 }))).toBeVisible();
  await page.getByRole("button", { name: t("catalogImport.result.copy") }).click();
  await expect(
    page.locator("output", { hasText: /\S/ }).filter({ hasText: /./ }).last(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: t("catalogImport.result.viewProducts") }),
  ).toHaveAttribute("href", "/catalog/products");
  await expectNoAxeViolations(page, "result reopened");
});

test("P5: a closed batch has nothing to continue", async ({ page, t }) => {
  const fake = await mockImportApi(page);
  fake.batch = batchBody({ state: "cancelled", version: 3 });
  await page.goto(`/catalog/import/${BATCH_ID}`);
  await expect(page.getByText(t("catalogImport.closed.title"))).toBeVisible();
  await expect(page.getByRole("link", { name: t("catalogImport.back") })).toBeVisible();
  await expectNoAxeViolations(page, "closed");
});
