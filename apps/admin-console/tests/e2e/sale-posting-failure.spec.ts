import { expectNoAxeViolations } from "./axe";
import { context } from "./compact-shell-data";
import { DETAIL_ROUTES, SALE, mockDetailTemplate, saleDetail } from "./detail-template-data";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1072 (RT-977 §7, §10 slice 2): the sale detail's ERPNext posting-failure
 * banner and repair, in the built SPA, in both locale projects, axe clean.
 *   - `full` (tenant_admin): cause → safety → action, the stored message as
 *     plain text, "Send to ERPNext again" behind a confirmation, one
 *     `repairPosting` with an Idempotency-Key and `{}`, and its outcome.
 *   - `category_only` (store_manager): the cause and time, who can repair,
 *     no message and no button.
 */
const WORK_ITEM = "0190f000-0000-7000-8000-0000000009a1";
const REASON = "Item ITM-001: no stock in warehouse Stores - NS";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

function withFailure(disclosure: "full" | "category_only") {
  const full = disclosure === "full";
  return {
    ...saleDetail,
    erpPostingFailure: {
      disclosure,
      sale: {
        rejectionCategory: "unmapped_item",
        deadLetteredAt: "2026-10-30T19:30:00Z",
        reason: full ? REASON : null,
        reconciliationDocumentRef: null,
        repair: full ? { workItemRef: WORK_ITEM } : null,
      },
      reversal: null,
    },
  };
}

async function open(page: Page, disclosure: "full" | "category_only"): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockDetailTemplate(page);
  if (disclosure === "category_only") {
    const manager = {
      ...context,
      active_role_code: "store_manager",
      memberships: [{ ...context.memberships[0], role_code: "store_manager" }],
    };
    await page.route("**/api/v1/context/me", (r) => r.fulfill(json(manager)));
  }
  await page.route(`**/api/v1/sales/${SALE}`, (r) => r.fulfill(json(withFailure(disclosure))));
  await page.goto(DETAIL_ROUTES.sale);
  await expect(page.locator(".field-row").first()).toBeVisible();
}

test("full: the cause, safety and message; a confirmed repair sends one keyed request and shows its outcome", async ({
  page,
  t,
}) => {
  await open(page, "full");
  const banner = page.locator(".sale-erp-failure").getByRole("alert");
  await expect(banner).toContainText(t("sales.erpFailure.sale"));
  await expect(banner).toContainText(t("postingRepair.cause.unmappedItem"));
  await expect(banner).toContainText(t("postingRepair.safety"));
  await expect(banner).toContainText(t("postingRepair.action.mappingHint"));
  const reason = page.locator(".sale-erp-failure__evidence bdi");
  await expect(reason).toHaveText(REASON);
  await expect(reason).toHaveAttribute("dir", "auto");
  await expectNoAxeViolations(page, "sale detail: posting failure, full");

  const requests: { key: string | null; body: string | null }[] = [];
  await page.route("**/api/v1/catalog/erpnext-reconciliation/postings/*/repair", (r) => {
    requests.push({
      key: r.request().headers()["idempotency-key"] ?? null,
      body: r.request().postData(),
    });
    return r.fulfill(
      json(
        {
          targetKind: "posting",
          targetRef: WORK_ITEM,
          repairKind: "re_post",
          outcome: "eligible_again",
          resolvedDocumentRef: null,
          recordedAt: "2026-10-30T20:00:00Z",
        },
        201,
      ),
    );
  });

  await banner.getByRole("button", { name: t("postingRepair.action.send") }).click();
  const confirm = page.getByRole("region", { name: t("postingRepair.confirm.label") });
  await expect(confirm).toContainText(t("postingRepair.confirm.sale"));
  await expectNoAxeViolations(page, "sale detail: posting repair confirmation");
  await confirm.getByRole("button", { name: t("postingRepair.confirm.submit") }).click();

  const outcome = page.locator(".sale-erp-failure__outcome");
  await expect(outcome).toContainText(t("postingRepair.outcome.eligibleAgain"));
  expect(requests).toHaveLength(1);
  expect(requests[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(requests[0].body).toBe("{}");
  await expectNoAxeViolations(page, "sale detail: posting repair outcome");
});

test("category_only (store_manager): the cause and time, who can repair; no message, no button", async ({
  page,
  t,
}) => {
  await open(page, "category_only");
  const failure = page.locator(".sale-erp-failure");
  const banner = failure.getByRole("alert");
  await expect(banner).toContainText(t("postingRepair.cause.unmappedItem"));
  await expect(banner).toContainText(t("postingRepair.action.categoryOnly"));
  await expect(failure.locator(".sale-erp-failure__evidence")).toBeVisible();
  await expect(failure.locator(".sale-erp-failure__evidence bdi")).toHaveCount(0);
  await expect(failure.getByRole("button")).toHaveCount(0);
  await expect(page.getByText(REASON)).toHaveCount(0);
  await expectNoAxeViolations(page, "sale detail: posting failure, category only");
});
