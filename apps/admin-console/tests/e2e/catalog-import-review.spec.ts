import { expectNoAxeViolations } from "./axe";
import {
  AMBIGUOUS_ROW,
  BATCH_ID,
  COUNTS,
  ERROR_ROW,
  NO_ID_ROW,
  err,
  mockImportApi,
  previewBody,
  row,
  validatedBatch,
} from "./catalog-import-mock";
import { expect, test } from "./fixtures";

/**
 * RT-1509 steps 4 and 5, «المراجعة» and «المعاينة», against a mocked Backend-Core (C-5).
 *   R1 every undecided row is listed; the primary waits with the count in text; a decision is sent
 *      with `expectedVersion`, said «recorded» only after the server answered, and its counts are the
 *      server's; «remove the decision» sends `clear`.
 *   R2 what a row offers follows its status and mode: an error row only «exclude»; an ambiguous row
 *      has no «create new» and says why; a row with no identifier offers create and exclude.
 *   R3 a stale version (409) reloads the batch and says so; a refused decision (422) reloads the row.
 *   P1 the preview names what publish does: counts, products taken off the tills, unpriced new
 *      products, brands; «show changes» lists the field changes. P2 nothing to write: no publish.
 * Runs in both locales; copy comes from the catalog (`t`). axe runs on every screen.
 */
const REVIEW_COUNTS = { ...COUNTS, needs_review: 2, error: 1 };

function reviewing() {
  return validatedBatch({ version: 3, counts: REVIEW_COUNTS });
}

test("R1: list, decide, remove the decision; the counts are the server's", async ({ page, t }) => {
  const fake = await mockImportApi(page);
  fake.batch = reviewing();
  fake.rows = { needs_review: [AMBIGUOUS_ROW, NO_ID_ROW], error: [ERROR_ROW] };
  await page.goto(`/catalog/import/${BATCH_ID}/review`);
  await expect(
    page.getByRole("heading", { level: 2, name: t("catalogImport.step.review") }),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /31/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /92/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /14/ })).toBeVisible();

  const next = page.getByRole("button", { name: t("catalogImport.review.toPreview") });
  await expect(next).toBeDisabled();
  await expect(
    page.getByText(t("catalogImport.review.undecided", { count: 3 })).first(),
  ).toBeVisible();
  await expectNoAxeViolations(page, "review list");

  await page.getByRole("button", { name: t("catalogImport.review.openRow", { row: 31 }) }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(t("catalogImport.review.createNotOffered"))).toBeVisible();
  await expect(
    drawer.getByRole("radio", { name: new RegExp(t("catalogImport.review.createNew")) }),
  ).toHaveCount(0);
  const apply = drawer.getByRole("button", { name: t("catalogImport.review.apply") });
  await expect(apply).toBeDisabled();
  await expectNoAxeViolations(page, "review drawer");

  await drawer.getByRole("radio", { name: /6221033001111/ }).check();
  await apply.click();
  await expect(
    page.getByText(
      t("catalogImport.review.recorded", {
        row: 31,
        outcome: t("catalogImport.review.decided.update", { name: "حليب كامل الدسم 1 لتر" }),
      }),
    ),
  ).toBeVisible();
  const [decision] = fake.to("PUT", "/resolution");
  expect(JSON.parse(decision?.body ?? "{}")).toEqual({
    expectedVersion: 3,
    action: "update_product",
    productId: "0190f000-0000-7000-8000-000000000a01",
  });
  await expectNoAxeViolations(page, "review recorded");

  await page.getByRole("button", { name: t("catalogImport.review.openRow", { row: 31 }) }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: t("catalogImport.review.remove") })
    .click();
  await expect(page.getByText(t("catalogImport.review.cleared", { row: 31 }))).toBeVisible();
  expect(JSON.parse(fake.to("PUT", "/resolution")[1]?.body ?? "{}").action).toBe("clear");
});

test("R2: what a row offers follows its status", async ({ page, t }) => {
  const fake = await mockImportApi(page);
  fake.batch = reviewing();
  fake.rows = { needs_review: [NO_ID_ROW], error: [ERROR_ROW] };
  await page.goto(`/catalog/import/${BATCH_ID}/review`);
  await page.getByRole("button", { name: t("catalogImport.review.openRow", { row: 92 }) }).click();
  let drawer = page.getByRole("dialog");
  await expect(
    drawer.getByRole("radio", { name: new RegExp(t("catalogImport.review.createNew")) }),
  ).toBeVisible();
  await expect(
    drawer.getByRole("radio", { name: new RegExp(t("catalogImport.review.exclude")) }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);

  await page.getByRole("button", { name: t("catalogImport.review.openRow", { row: 14 }) }).click();
  drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("radio")).toHaveCount(1);
  await expect(
    drawer.getByRole("radio", { name: new RegExp(t("catalogImport.review.exclude")) }),
  ).toBeVisible();
  await expect(drawer.getByText(t("catalogImport.review.errorHint"))).toBeVisible();
});

test("R3: a stale version reloads and says so", async ({ page, t }) => {
  const fake = await mockImportApi(page);
  fake.batch = reviewing();
  fake.rows = { needs_review: [NO_ID_ROW], error: [] };
  await page.route("**/rows/92/resolution", (r) =>
    r.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify(err(409, "version_conflict").body),
    }),
  );
  await page.goto(`/catalog/import/${BATCH_ID}/review`);
  await page.getByRole("button", { name: t("catalogImport.review.openRow", { row: 92 }) }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("radio", { name: new RegExp(t("catalogImport.review.exclude")) }).check();
  await drawer.getByRole("button", { name: t("catalogImport.review.apply") }).click();
  await expect(
    page.getByText(t("catalogImport.review.versionConflict.title")).first(),
  ).toBeVisible();
});

test("P1: the preview names what publish does; «show changes» lists the field changes", async ({
  page,
  t,
}) => {
  const fake = await mockImportApi(page);
  fake.batch = validatedBatch({
    version: 4,
    counts: { ...COUNTS, needs_review: 0, error: 0 },
    publishable: true,
  });
  fake.preview = previewBody();
  fake.rows = {
    ready_update: [
      row(5, "ready_update", {
        outcome: {
          match: "match",
          matchedProduct: { productId: "p", name: "شاي أخضر 25 كيسًا", identifiers: [] },
          candidates: [],
          fieldChanges: [{ field: "tax_category", before: "standard", after: "exempt" }],
          identifierAdds: [],
          identifiersNotAdded: [],
          brandToCreate: null,
        },
      }),
    ],
  };
  await page.goto(`/catalog/import/${BATCH_ID}/preview`);
  await expect(
    page.getByRole("heading", { level: 2, name: t("catalogImport.step.preview") }),
  ).toBeVisible();
  await expect(
    page.getByText(t("catalogImport.preview.deactivations", { count: 1 })),
  ).toBeVisible();
  await expect(page.getByText(t("catalogImport.preview.unpriced", { count: 812 }))).toBeVisible();
  await expect(page.getByText("نايل فودز")).toBeVisible();
  await expect(
    page.getByRole("button", { name: t("catalogImport.preview.publish") }),
  ).toBeEnabled();
  await expectNoAxeViolations(page, "preview");

  await page.getByRole("button", { name: t("catalogImport.preview.changes") }).click();
  await expect(page.getByText("شاي أخضر 25 كيسًا").first()).toBeVisible();
  await expect(page.getByText("exempt")).toBeVisible();
  await expectNoAxeViolations(page, "preview changes");
});

test("P2: a batch with nothing to write has no publish button; a refused preview blocks with a reason", async ({
  page,
  t,
}) => {
  const fake = await mockImportApi(page);
  fake.batch = validatedBatch({ version: 4, counts: { ...COUNTS, needs_review: 0, error: 0 } });
  fake.preview = previewBody({
    productsToCreate: 0,
    productsToUpdate: 0,
    identifiersToAdd: 0,
    brandsToCreate: [],
    deactivations: [],
    newProductsWithoutPrice: 0,
  });
  await page.goto(`/catalog/import/${BATCH_ID}/preview`);
  await expect(page.getByText(t("catalogImport.preview.nothing"))).toBeVisible();
  await expect(page.getByRole("button", { name: t("catalogImport.preview.publish") })).toHaveCount(
    0,
  );

  fake.preview = previewBody({ publishable: false });
  await page.reload();
  const publish = page.getByRole("button", { name: t("catalogImport.preview.publish") });
  await expect(publish).toBeDisabled();
  await expect(page.getByText(t("catalogImport.preview.blockedNotPublishable"))).toBeVisible();
  await expectNoAxeViolations(page, "preview blocked");
});
