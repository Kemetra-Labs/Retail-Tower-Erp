/**
 * RT-455 — the tracking holds screen and the batch detail in a real layout,
 * against mocked contract reads (C-5). Runs in ar and en (the two projects),
 * each in light and dark, with axe over each. Covers: the nav entry appears
 * only with `hasTrackedProducts: true` (TR-6), the band's counts, the hold
 * drawer, the «قريبًا» tabs, the store_manager view and the batch detail.
 * Every capture is attached to the test; `TRACKING_SHOTS=<dir>` also writes it.
 */
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestInfo } from "@playwright/test";
import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

const STORE = "0190f000-0000-7000-8000-0000000007a1";
const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";
const IDENTITY = "0190f000-0000-7000-8000-0000000007b1";
const HOLD = "0190f000-0000-7000-8000-0000000007e1";
const OMAR = "0190f000-0000-7000-8000-0000000000c1";
const INV = "/api/inventory/v1";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

function ctx(role: string) {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: "t1", name: "مؤسسة النيل للتجزئة" },
    active_store: null,
    active_role_code: role,
    memberships: [{ tenant_id: "t1", tenant_name: "مؤسسة النيل للتجزئة", role_code: role }],
  };
}

const activeHold = {
  kind: "active_tracking_hold",
  severity: "critical",
  holdId: HOLD,
  holdKind: "quality_hold",
  recallId: null,
  trackingIdentityId: IDENTITY,
  tenantProductRef: PRODUCT,
  identityKind: "batch",
  identityCode: "LOT-2026-0912",
  expiryDate: "2027-03-12",
  placedAt: "2026-10-30T09:14:00Z",
  storeIds: [STORE],
};
const expired = {
  kind: "expired_lot_sellable",
  severity: "critical",
  trackingIdentityId: IDENTITY,
  tenantProductRef: PRODUCT,
  identityKind: "batch",
  identityCode: "LOT-2026-0418",
  expiryDate: "2026-10-29",
  storeId: STORE,
  storeBusinessDate: "2026-10-31",
  sellableQuantity: "14",
  stockingUnit: "pcs",
};
const hold = {
  id: HOLD,
  trackingIdentityId: IDENTITY,
  tenantProductRef: PRODUCT,
  kind: "quality_hold",
  reasonCode: "label_misprint",
  note: "ملصق تاريخ الانتهاء غير مقروء على عبوات الكرتونة 4.",
  recallId: null,
  placedBy: OMAR,
  placedAt: "2026-10-30T09:14:00Z",
  releasedBy: null,
  releasedAt: null,
  releaseNote: null,
  active: true,
};
const statuses = [
  "sellable",
  "return_inspection",
  "quality_hold",
  "damaged",
  "expired",
  "recall_hold",
];

async function mock(page: Page, role: string, tracked = true): Promise<void> {
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  // RT-455 part 1 (OD-T4): the tracking pages show only while the switch is on.
  await page.route(`**${INV}/settings/tracked-selling`, (r) =>
    r.fulfill(
      json({
        enabled: true,
        changedAt: "2026-11-08T18:00:00Z",
        changedBy: OMAR,
        preconditionsMet: true,
        unmetPreconditions: [],
      }),
    ),
  );
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(role))));
  await page.route("**/api/v1/stores", (r) =>
    r.fulfill(
      json([
        {
          id: STORE,
          tenant_id: "t1",
          code: "MAA",
          name: "فرع المعادي",
          timezone: "Africa/Cairo",
          is_active: true,
        },
      ]),
    ),
  );
  await page.route("**/api/v1/catalog/tracking-summary", (r) =>
    r.fulfill(json({ hasTrackedProducts: tracked })),
  );
  await page.route(`**/api/v1/catalog/products/${PRODUCT}`, (r) =>
    r.fulfill(json({ summary: { productId: PRODUCT, name: "عصير مانجو 1 لتر" } })),
  );
  await page.route("**/api/v1/tenants/t1/members", (r) =>
    r.fulfill(
      json([
        {
          membership_id: "m1",
          user: { id: OMAR, email: "omar@nile.eg", display_name: "عمر نبيل" },
          role_code: "tenant_admin",
          store_access_kind: "all",
          revoked_at: null,
        },
      ]),
    ),
  );
  await page.route(`**${INV}/safety/findings`, (r) =>
    r.fulfill(json({ findings: [activeHold, expired], generatedAt: "2026-11-03T12:32:00Z" })),
  );
  await page.route(`**${INV}/tracking-holds**`, (r) =>
    r.fulfill(json({ items: [hold], nextCursor: null })),
  );
  await page.route(`**${INV}/tracking-holds/${HOLD}`, (r) => r.fulfill(json(hold)));
  await page.route(`**${INV}/recalls**`, (r) => r.fulfill(json({ items: [], nextCursor: null })));
  await page.route(`**${INV}/tracking-identities/${IDENTITY}`, (r) =>
    r.fulfill(
      json({
        id: IDENTITY,
        productId: PRODUCT,
        kind: "batch",
        code: "LOT-2026-1004",
        expiryDate: "2027-04-04",
        manufacturedOn: "2026-10-04",
        origin: "erp_external",
      }),
    ),
  );
  await page.route(`**${INV}/tracking-identities/${IDENTITY}/positions`, (r) =>
    r.fulfill(
      json({
        trackingIdentityId: IDENTITY,
        tenantProductRef: PRODUCT,
        stores: [
          {
            storeId: STORE,
            stockingUnit: "pcs",
            quantity: "24",
            sellableQuantity: "0",
            statusQuantities: statuses.map((s) => ({
              inventoryStatus: s,
              quantity: s === "quality_hold" ? "24" : "0",
            })),
          },
        ],
      }),
    ),
  );
  await page.route(`**${INV}/tracking-identities/${IDENTITY}/expiry-corrections**`, (r) =>
    r.fulfill(json({ items: [], nextCursor: null })),
  );
}

async function save(name: string, body: Buffer): Promise<void> {
  const dir = process.env.TRACKING_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await writeFile(join(dir, `${name}.png`), body);
}

/** Axe and a capture in light, then the same in dark. */
async function lightAndDark(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await expectNoAxeViolations(page, `${name} ${theme}`);
    const shot = await page.screenshot({ fullPage: true });
    const label = `tracking-${name}-${theme}-${testInfo.project.name}`;
    await testInfo.attach(label, { body: shot, contentType: "image/png" });
    await save(label, shot);
  }
}

test("TR-6: no tracked products, no nav entry", async ({ page, t }) => {
  await mock(page, "owner", false);
  await page.goto("/inventory");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const nav = page.getByRole("navigation", { name: t("shell.nav.label") });
  await expect(nav.getByRole("link", { name: t("inventory.nav.label") })).toBeVisible();
  await expect(nav.getByRole("link", { name: t("tracking.nav.label") })).toHaveCount(0);
});

test("owner: nav entry, band counts, active holds and the hold drawer", async ({
  page,
  t,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, "owner");
  await page.goto("/inventory");
  const nav = page.getByRole("navigation", { name: t("shell.nav.label") });
  await nav.getByRole("link", { name: t("tracking.nav.label") }).click();
  await expect(page.getByRole("heading", { level: 1, name: t("tracking.title") })).toBeVisible();
  const band = page.locator("header.list-band");
  await expect(band.getByText(t("tracking.band.activeHolds"))).toBeVisible();
  const table = page.getByTestId("tracking-active-table");
  await expect(table.getByText("LOT-2026-0912")).toBeVisible();
  await expect(table.getByText("عصير مانجو 1 لتر")).toBeVisible();
  await lightAndDark(page, testInfo, "holds");

  await page
    .getByRole("button", { name: t("tracking.active.openLabel", { code: "LOT-2026-0912" }) })
    .click();
  const drawer = page.getByTestId("tracking-hold-drawer");
  await expect(drawer.getByText("عمر نبيل")).toBeVisible();
  await expect(drawer.getByText(t("tracking.reason.label_misprint"))).toBeVisible();
  await lightAndDark(page, testInfo, "hold-drawer");
});

test("owner: the resolution tab is «coming soon» and calls nothing", async ({
  page,
  t,
}, testInfo) => {
  await mock(page, "owner");
  const asked: string[] = [];
  page.on("request", (req) => {
    if (/tracking-resolution|sale-line-findings/.test(req.url())) asked.push(req.url());
  });
  await page.goto("/tracking?tab=resolution");
  await expect(page.getByTestId("tracking-soon")).toBeVisible();
  await expect(page.getByText(t("tracking.resolution.title"))).toBeVisible();
  await page.goto("/tracking?tab=saleLines");
  await expect(page.getByTestId("tracking-soon")).toBeVisible();
  expect(asked).toEqual([]);
  await lightAndDark(page, testInfo, "sale-lines-soon");
});

test("store_manager: findings only, no drawer, the OD-9 line", async ({ page, t }, testInfo) => {
  await mock(page, "store_manager");
  await page.goto("/tracking");
  const table = page.getByTestId("tracking-active-table");
  await expect(table.getByText("LOT-2026-0912")).toBeVisible();
  await expect(table.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: t("tracking.tab.recalls") })).toHaveCount(0);
  await expect(page.getByTestId("tracking-manager-notes")).toBeVisible();
  await lightAndDark(page, testInfo, "manager");
});

test("owner: the batch detail, its holds, positions and corrections", async ({
  page,
  t,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, "owner");
  await page.goto(`/tracking/identities/${IDENTITY}?store=${STORE}`);
  await expect(page.getByTestId("tracking-identity-fields")).toBeVisible();
  await expect(page.getByTestId("tracking-identity-active-holds")).toBeVisible();
  await expect(
    page.getByTestId("tracking-identity-positions").getByText("فرع المعادي"),
  ).toBeVisible();
  await expect(page.getByText(t("tracking.identity.correctionsEmpty"))).toBeVisible();
  await lightAndDark(page, testInfo, "identity");
});

test("390: the holds screen never scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await mock(page, "owner");
  await page.goto("/tracking");
  await page.getByTestId("tracking-active-table").waitFor();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test("owner: placing a hold answers 404 until RT-453, and the page says nothing was recorded", async ({
  page,
  t,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, "owner");
  await page.route(`**${INV}/tracking-holds?**`, (r) =>
    r.fulfill(json({ items: [], nextCursor: null })),
  );
  await page.route(`**${INV}/tracking-holds`, (r) =>
    r.request().method() === "POST"
      ? r.fulfill(
          json(
            { error: { code: "not_found", message: "Resource not found.", request_id: "req-404" } },
            404,
          ),
        )
      : r.fallback(),
  );
  await page.goto(`/tracking/identities/${IDENTITY}`);
  await page.getByRole("button", { name: t("tracking.placeHold.open") }).click();
  const form = page.getByTestId("tracking-place-hold");
  await form.getByLabel(t("tracking.write.reason")).selectOption("label_misprint");
  await form.getByRole("button", { name: t("tracking.placeHold.submit") }).click();
  await expect(form.getByTestId("tracking-write-refusal")).toBeVisible();
  await expect(form.getByText(t("tracking.write.hint.notFound"))).toBeVisible();
  await lightAndDark(page, testInfo, "place-hold-404");
});
