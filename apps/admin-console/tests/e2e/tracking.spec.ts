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
const SALE = "0190f000-0000-7000-8000-000000000a01";
const LINE = "0190f000-0000-7000-8000-000000000b01";

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
const unresolvedSale = {
  saleId: SALE,
  storeId: STORE,
  businessDate: "2026-11-10",
  occurredAt: "2026-11-10T09:00:00Z",
  capturedAt: "2026-11-10T09:05:00Z",
  status: "unresolved",
  unresolvedLines: [
    {
      saleLineId: LINE,
      tenantProductRef: PRODUCT,
      reason: "identity_unknown",
      sentIdentityId: null,
      scannedCode: "LOT-X-77",
      quantity: "2",
      unit: "pcs",
    },
  ],
  resolution: null,
};
const saleLineFinding = {
  id: "0190f000-0000-7000-8000-000000000d01",
  kind: "sold_under_hold",
  severity: "critical",
  cause: "quality_hold",
  storeId: STORE,
  saleId: SALE,
  saleLineId: LINE,
  tenantProductRef: PRODUCT,
  trackingIdentityId: IDENTITY,
  holdId: HOLD,
  businessDate: "2026-11-10",
  occurredAt: "2026-11-10T09:00:00Z",
  recordedAt: "2026-11-10T09:05:00Z",
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
  await page.route(`**${INV}/tracking-resolutions**`, (r) =>
    r.fulfill(
      json({
        items: role === "store_manager" ? [] : [unresolvedSale],
        nextCursor: null,
        unresolvedCount: 1,
      }),
    ),
  );
  await page.route(`**${INV}/safety/sale-line-findings**`, (r) =>
    r.fulfill(json({ items: [saleLineFinding], nextCursor: null })),
  );
  await page.route(`**${INV}/products/${PRODUCT}/tracking-identities**`, (r) =>
    r.fulfill(
      json({
        items: [
          {
            id: IDENTITY,
            productId: PRODUCT,
            kind: "batch",
            code: "LOT-2026-1004",
            expiryDate: "2027-04-04",
            manufacturedOn: null,
            origin: "erp_external",
          },
        ],
        nextCursor: null,
      }),
    ),
  );
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

test("owner: the resolution queue lists the unresolved sale and the count", async ({
  page,
  t,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, "owner");
  await page.goto("/tracking?tab=resolution");
  const table = page.getByTestId("tracking-queue-table");
  await expect(table.getByText("LOT-X-77")).toBeVisible();
  await expect(table.getByText("عصير مانجو 1 لتر")).toBeVisible();
  await expect(page.getByRole("tab", { name: t("tracking.tab.resolution") })).toContainText("1");
  await lightAndDark(page, testInfo, "resolution");
});

test("owner: binding captures the reason and the note, confirms, and shows the server's answer", async ({
  page,
  t,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, "owner");
  let sent: { reasonCode?: string; note?: string; lines?: unknown[] } | undefined;
  await page.route(`**${INV}/tracking-resolutions/${SALE}/bind`, async (r) => {
    sent = r.request().postDataJSON();
    await r.fulfill(
      json({
        id: "0190f000-0000-7000-8000-000000000e01",
        saleId: SALE,
        reasonCode: sent?.reasonCode,
        note: sent?.note,
        resolvedBy: OMAR,
        resolvedAt: "2026-11-12T01:10:00Z",
        lines: sent?.lines,
      }),
    );
  });
  await page.goto("/tracking?tab=resolution");
  await page.getByRole("button", { name: t("tracking.resolution.bind") }).click();
  const form = page.getByTestId("tracking-bind-form");
  await form.getByRole("button", { name: t("tracking.resolution.submit") }).click();
  await expect(form.getByText(t("tracking.write.error.bindNote"))).toBeVisible();
  await form.getByRole("combobox", { name: /عصير مانجو/ }).selectOption(IDENTITY);
  await form.getByLabel(t("tracking.write.reason")).selectOption("label_misprint");
  await form.getByLabel(t("tracking.write.note")).fill("مسح الدفعة الخطأ عند الكاشير");
  await lightAndDark(page, testInfo, "bind-form");
  await form.getByRole("button", { name: t("tracking.resolution.submit") }).click();
  await form.getByRole("button", { name: t("tracking.resolution.confirmYes") }).click();
  await expect(form.getByText(t("tracking.resolution.recorded", { count: 1 }))).toBeVisible();
  expect(sent?.reasonCode).toBe("label_misprint");
  expect(sent?.note).toBe("مسح الدفعة الخطأ عند الكاشير");
  expect(sent?.lines).toEqual([{ saleLineId: LINE, trackingIdentityId: IDENTITY }]);
});

test("owner: a 409 refusal is shown as sent and nothing reads as recorded", async ({ page, t }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, "owner");
  await page.route(`**${INV}/tracking-resolutions/${SALE}/bind`, (r) =>
    r.fulfill(
      json(
        {
          error: {
            code: "tracking_resolution_identity_held",
            message: "The identity is held.",
            request_id: "req-409",
          },
        },
        409,
      ),
    ),
  );
  await page.goto("/tracking?tab=resolution");
  await page.getByRole("button", { name: t("tracking.resolution.bind") }).click();
  const form = page.getByTestId("tracking-bind-form");
  await form.getByRole("combobox", { name: /عصير مانجو/ }).selectOption(IDENTITY);
  await form.getByLabel(t("tracking.write.reason")).selectOption("other");
  await form.getByLabel(t("tracking.write.note")).fill("n");
  await form.getByRole("button", { name: t("tracking.resolution.submit") }).click();
  await form.getByRole("button", { name: t("tracking.resolution.confirmYes") }).click();
  await expect(form.getByTestId("tracking-write-refusal")).toBeVisible();
  await expect(form.getByText(t("tracking.write.hint.resolutionHeld"))).toBeVisible();
});

test("tenant_admin: reads the queue, the bind is recessed with the owner-only reason", async ({
  page,
  t,
}, testInfo) => {
  await mock(page, "tenant_admin");
  await page.goto("/tracking?tab=resolution");
  const bind = page.getByRole("button", { name: t("tracking.resolution.bind") });
  await expect(bind).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("tracking-bind-notice")).toBeVisible();
  await bind.click({ force: true });
  await expect(page.getByTestId("tracking-bind-form")).toHaveCount(0);
  await lightAndDark(page, testInfo, "resolution-admin");
});

test("owner: empty, error and loading states of the queue", async ({ page, t }, testInfo) => {
  await mock(page, "owner");
  await page.route(`**${INV}/tracking-resolutions**`, (r) =>
    r.fulfill(json({ items: [], nextCursor: null, unresolvedCount: 0 })),
  );
  await page.goto("/tracking?tab=resolution");
  await expect(page.getByText(t("tracking.resolution.empty"))).toBeVisible();
  await lightAndDark(page, testInfo, "resolution-empty");

  await page.route(`**${INV}/tracking-resolutions**`, (r) =>
    r.fulfill(json({ error: { code: "x", message: "x", request_id: "req-5" } }, 500)),
  );
  await page.goto("/tracking?tab=resolution");
  await expect(page.getByText(t("tracking.resolution.loadFailed"))).toBeVisible();
  await lightAndDark(page, testInfo, "resolution-error");

  await page.route(`**${INV}/tracking-resolutions**`, async (r) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await r.fulfill(json({ items: [], nextCursor: null, unresolvedCount: 0 }));
  });
  await page.goto("/tracking?tab=resolution");
  await expect(page.getByRole("status").first()).toBeVisible();
});

test("owner: the sale-line findings tab, and the consistency check shown as unavailable", async ({
  page,
  t,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, "owner");
  await page.goto("/tracking?tab=saleLines");
  const table = page.getByTestId("tracking-saleline-table");
  await expect(table.getByText(t("tracking.saleLines.kind.sold_under_hold"))).toBeVisible();
  await expect(page.getByTestId("tracking-consistency-unavailable")).toBeVisible();
  await lightAndDark(page, testInfo, "sale-lines");
});

test("store_manager: findings only, no drawer, the OD-9 line", async ({ page, t }, testInfo) => {
  await mock(page, "store_manager");
  await page.goto("/tracking");
  const table = page.getByTestId("tracking-active-table");
  await expect(table.getByText("LOT-2026-0912")).toBeVisible();
  await expect(table.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: t("tracking.tab.recalls") })).toHaveCount(0);
  const notes = page.getByTestId("tracking-manager-notes");
  await expect(notes).toBeVisible();
  // OD-9: the count only, never a row.
  await expect(notes.getByTestId("tracking-queue-count")).toContainText("1");
  await page.goto("/tracking?tab=resolution");
  await expect(page.getByTestId("tracking-queue-table")).toHaveCount(0);
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
