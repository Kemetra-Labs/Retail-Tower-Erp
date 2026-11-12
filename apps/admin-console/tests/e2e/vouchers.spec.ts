import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1109 vouchers page E2E smoke. Mocked Backend-Core (C-5), both locales.
 *
 * S1: the list renders for a tenant_admin, without any code.
 * S2: issue → the 201 codes show once in the drawer → "I saved the codes"
 *     closes it → the codes are in no browser storage, and a reload cannot
 *     show them again (acceptance criterion 1). The POST carries a fresh
 *     Idempotency-Key and the closed request body.
 * S3: cancel from the detail drawer, after an explicit confirm.
 *
 * The journey against a real Backend-Core is a separate check.
 */
const user = { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" };
const ctx = {
  user,
  active_tenant: { id: "t1", name: "Northstar Retail" },
  active_store: null,
  active_role_code: "tenant_admin",
  memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: "tenant_admin" }],
};

const CODE = "ABCD-EFGH-JKMN-PQRS";
const VOUCHER_ID = "11111111-1111-4111-8111-111111111111";
const BATCH_ID = "22222222-2222-4222-8222-222222222222";

function voucher(over: Record<string, unknown> = {}) {
  return {
    voucher_id: VOUCHER_ID,
    batch_id: BATCH_ID,
    amount_minor: 5000,
    currency_code: "EGP",
    status: "active",
    expires_at: null,
    applies_to_all_stores: true,
    eligible_store_ids: [],
    note: null,
    created_at: "2026-11-11T10:00:00Z",
    cancelled_at: null,
    redemption: null,
    ...over,
  };
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mockBase(page: Page): Promise<void> {
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx)));
}

test("S1: the voucher list renders, without codes", async ({ page, t }) => {
  await mockBase(page);
  await page.route("**/api/v1/vouchers**", (r) =>
    r.fulfill(json({ items: [voucher()], next_cursor: null })),
  );
  await page.goto("/vouchers");
  await expect(
    page.getByRole("heading", { name: t("vouchers.list.title"), exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "50.00 EGP", exact: true })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: t("vouchers.status.active"), exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/)).toHaveCount(0);
  await expectNoAxeViolations(page, "vouchers list");
});

test("S2: issue shows the codes once; storage and a reload never hold them", async ({
  page,
  t,
}) => {
  await mockBase(page);
  let issued = false;
  let idempotencyKey: string | undefined;
  let postedBody: unknown;
  await page.route("**/api/v1/vouchers**", (r) => {
    if (r.request().method() === "POST") {
      issued = true;
      idempotencyKey = r.request().headers()["idempotency-key"];
      postedBody = r.request().postDataJSON();
      return r.fulfill({
        ...json(
          {
            batch_id: BATCH_ID,
            vouchers: [
              {
                voucher_id: VOUCHER_ID,
                code: CODE,
                amount_minor: 5000,
                currency_code: "EGP",
                expires_at: null,
              },
            ],
          },
          201,
        ),
        headers: { "Cache-Control": "no-store" },
      });
    }
    return r.fulfill(json({ items: issued ? [voucher()] : [], next_cursor: null }));
  });

  await page.goto("/vouchers");
  await page
    .getByRole("button", { name: t("vouchers.list.issue") })
    .first()
    .click();
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel(t("vouchers.issue.amount")).fill("50");
  await drawer.getByRole("button", { name: t("vouchers.issue.submit") }).click();

  const codes = page.getByRole("dialog", { name: t("vouchers.codes.title") });
  await expect(codes.getByText(CODE)).toBeVisible();
  await expectNoAxeViolations(page, "issued codes drawer");
  expect(idempotencyKey).toMatch(/^[\x21-\x7E]{16,128}$/);
  expect(postedBody).toEqual({
    count: 1,
    amount_minor: 5000,
    expires_at: null,
    applies_to_all_stores: true,
    note: null,
  });

  const stored = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  expect(stored).not.toContain(CODE);

  await codes.getByRole("button", { name: t("vouchers.codes.done") }).click();
  await expect(page.getByText(CODE)).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "50.00 EGP", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("cell", { name: "50.00 EGP", exact: true })).toBeVisible();
  await expect(page.getByText(CODE)).toHaveCount(0);
});

test("S3: cancel from the detail drawer, after a confirm", async ({ page, t }) => {
  await mockBase(page);
  let cancelled = false;
  let cancelKey: string | undefined;
  await page.route("**/api/v1/vouchers**", (r) => {
    const url = r.request().url();
    if (url.endsWith("/cancel")) {
      cancelled = true;
      cancelKey = r.request().headers()["idempotency-key"];
      return r.fulfill(
        json({
          voucher_id: VOUCHER_ID,
          status: "cancelled",
          cancelled_at: "2026-11-11T11:00:00Z",
          already_cancelled: false,
        }),
      );
    }
    const current = cancelled
      ? voucher({ status: "cancelled", cancelled_at: "2026-11-11T11:00:00Z" })
      : voucher();
    if (url.includes(`/vouchers/${VOUCHER_ID}`)) return r.fulfill(json(current));
    return r.fulfill(json({ items: [current], next_cursor: null }));
  });

  await page.goto("/vouchers");
  await page.getByRole("button", { name: t("vouchers.list.open") }).click();
  const drawer = page.getByRole("dialog", { name: t("vouchers.detail.title") });
  await drawer.getByRole("button", { name: t("vouchers.detail.cancel") }).click();
  await drawer.getByRole("button", { name: t("vouchers.detail.cancelConfirm") }).click();
  await expect(drawer.getByText(t("vouchers.detail.cancelled"))).toBeVisible();
  expect(cancelKey).toMatch(/^[\x21-\x7E]{16,128}$/);
  await expect(drawer.getByRole("button", { name: t("vouchers.detail.cancel") })).toHaveCount(0);
});
