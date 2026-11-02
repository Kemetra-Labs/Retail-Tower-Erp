import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1070: display names beside user ids on audit and shift-close detail, via
 * the Backend-Core people-name read (mocked, C-5). The id stays visible; a
 * failed lookup falls back to the id without a banner. Runs in ar and en,
 * light and dark; axe over each.
 */
const STORE = "0190f000-0000-7000-8000-0000000000a1";
const SHIFT = "0190f000-0000-7000-8000-0000000000b1";
const OMAR = "0190f000-0000-7000-8000-0000000000c1";
const SARA = "0190f000-0000-7000-8000-0000000000c2";

const ctx = {
  user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
  active_tenant: { id: "t1", name: "Northstar Retail" },
  active_store: null,
  active_role_code: "store_manager",
  memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: "store_manager" }],
};
const store = {
  id: STORE,
  tenant_id: "t1",
  code: "DXB",
  name: "Dubai Mall",
  timezone: "Asia/Dubai",
  is_active: true,
};
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mockBase(page: Page, peopleStatus = 200): Promise<string[]> {
  const asked: string[] = [];
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx)));
  await page.route("**/api/v1/stores", (r) => r.fulfill(json([store])));
  await page.route(`**/api/v1/stores/${STORE}`, (r) => r.fulfill(json(store)));
  await page.route("**/api/v1/console/people**", (r) => {
    asked.push(new URL(r.request().url()).searchParams.get("ids") ?? "");
    if (peopleStatus !== 200) return r.fulfill(json({ error: { code: "x" } }, peopleStatus));
    return r.fulfill(
      json({
        items: [
          { user_id: OMAR, display_name: "Omar Khaled" },
          { user_id: SARA, display_name: null },
        ],
      }),
    );
  });
  return asked;
}

const events = {
  items: [
    {
      id: "e1",
      occurred_at: "2026-06-01T21:14:03Z",
      action: "shift.forced_close",
      actor_label: null,
      actor_user_id: OMAR,
      store_id: STORE,
      request_id: "11111111-1111-1111-1111-111111111111",
      metadata: {},
    },
  ],
  next_cursor: null,
};

const detail = {
  shiftId: SHIFT,
  storeId: STORE,
  closeKind: "normal",
  closedAt: "2026-10-07T20:30:00Z",
  openedAt: "2026-10-07T08:05:00Z",
  receivedAt: "2026-10-07T20:30:05Z",
  saleCount: 3,
  currencyCode: "EGP",
  forcedReason: null,
  openingFloat: "500.0000",
  cashSalesTotal: "2500.0000",
  cashRefundsTotal: "100.0000",
  payInTotal: "0.0000",
  payOutTotal: "50.0000",
  expectedCash: "2850.0000",
  countedCash: "2810.0000",
  variance: "-40.0000",
  openingUserId: OMAR,
  closingUserId: OMAR,
  recordedByUserId: SARA,
  varianceApprovedByUserId: SARA,
  cashRefundReturnRefs: [],
  cashMovements: [],
};

async function darkAxe(page: Page, label: string): Promise<void> {
  await expectNoAxeViolations(page, `${label} light`);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expectNoAxeViolations(page, `${label} dark`);
}

test("audit: the actor name sits beside the short id", async ({ page, t }) => {
  const asked = await mockBase(page);
  await page.route("**/api/v1/audit/events**", (r) => r.fulfill(json(events)));
  await page.goto("/audit");
  await page.getByRole("button", { name: t("filter.apply"), exact: true }).click();
  await expect(page.getByText("Omar Khaled")).toBeVisible();
  await expect(page.getByText(`${OMAR.slice(0, 8)}…`).first()).toBeVisible();
  expect(asked).toEqual([OMAR]);
  await darkAxe(page, "audit");
});

test("shift-close: names beside the ids, null name falls back to the id", async ({ page, t }) => {
  const asked = await mockBase(page);
  await page.route(`**/api/v1/shift-closes/${SHIFT}`, (r) => r.fulfill(json(detail)));
  await page.goto(`/shift-closes/${SHIFT}`);
  await expect(page.getByRole("heading", { name: t("shift.detail.title") })).toBeVisible();
  await expect(page.getByText("Omar Khaled").first()).toBeVisible();
  await expect(page.getByText(OMAR).first()).toBeVisible();
  // SARA's name is null: the id alone.
  await expect(page.getByText(SARA).first()).toBeVisible();
  expect(asked).toEqual([`${OMAR},${SARA}`]);
  await darkAxe(page, "shift-close");
});

test("shift-close: a failed lookup shows the ids and no banner", async ({ page, t }) => {
  await mockBase(page, 500);
  await page.route(`**/api/v1/shift-closes/${SHIFT}`, (r) => r.fulfill(json(detail)));
  await page.goto(`/shift-closes/${SHIFT}`);
  await expect(page.getByRole("heading", { name: t("shift.detail.title") })).toBeVisible();
  await expect(page.getByText(OMAR).first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
