/**
 * RT-455 part 1 — the tenant's tracked-selling switch on the tenant page, and
 * the tracking pages hidden while it is off (RT-451 OD-T1..OD-T7), in a real
 * layout against mocked contract answers (C-5). Runs in ar and en (the two
 * projects), each in light and dark, with axe over each.
 * `TRACKING_SHOTS=<dir>` also writes the captures.
 */
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestInfo } from "@playwright/test";
import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

const OMAR = "0190f000-0000-7000-8000-0000000000c1";
const SETTING = "**/api/inventory/v1/settings/tracked-selling";

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

const off = {
  enabled: false,
  changedAt: "2026-11-08T17:40:00Z",
  changedBy: OMAR,
  preconditionsMet: false,
  unmetPreconditions: ["erp_batch_posting_verified", "identity_anchor"],
};

async function mock(page: Page, role: string, setting: unknown, status = 200): Promise<void> {
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(role))));
  await page.route("**/api/v1/stores", (r) => r.fulfill(json([])));
  await page.route("**/api/v1/tenants/t1", (r) =>
    r.fulfill(
      json({ id: "t1", slug: "nile-retail", name: "مؤسسة النيل للتجزئة", status: "active" }),
    ),
  );
  await page.route("**/api/v1/console/people**", (r) =>
    r.fulfill(json({ items: [{ user_id: OMAR, display_name: "عمر نبيل" }] })),
  );
  await page.route("**/api/v1/catalog/tracking-summary", (r) =>
    r.fulfill(json({ hasTrackedProducts: true })),
  );
  await page.route(SETTING, (r) =>
    r.request().method() === "GET" ? r.fulfill(json(setting, status)) : r.fallback(),
  );
}

async function save(name: string, body: Buffer): Promise<void> {
  const dir = process.env.TRACKING_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await writeFile(join(dir, `${name}.png`), body);
}

async function lightAndDark(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await expectNoAxeViolations(page, `${name} ${theme}`);
    const shot = await page.screenshot({ fullPage: true });
    const label = `tracked-selling-${name}-${theme}-${testInfo.project.name}`;
    await testInfo.attach(label, { body: shot, contentType: "image/png" });
    await save(label, shot);
  }
}

test("owner, off: preconditions in plain words; switching on is refused with 409 and explained", async ({
  page,
  t,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, "owner", off);
  await page.route(SETTING, (r) =>
    r.request().method() === "PUT"
      ? r.fulfill(
          json(
            {
              error: {
                code: "tracked_selling_preconditions_unmet",
                message: "Preconditions unmet.",
                request_id: "req-409",
              },
            },
            409,
          ),
        )
      : r.fallback(),
  );
  await page.goto("/tenants/t1");
  const section = page.getByTestId("tracked-selling-section");
  await expect(section.getByTestId("tracked-selling-state")).toHaveText(
    t("trackedSelling.state.off"),
  );
  await expect(section.getByText("عمر نبيل")).toBeVisible();
  await expect(
    section.getByText(t("trackedSelling.precondition.erp_batch_posting_verified")),
  ).toBeVisible();
  await lightAndDark(page, testInfo, "owner-off");

  await section.getByRole("button", { name: t("trackedSelling.turnOn") }).click();
  await expect(section.getByText(t("trackedSelling.unmet"))).toBeVisible();
  await expect(section.getByText("req-409")).toBeVisible();
  await expect(section.getByTestId("tracked-selling-state")).toHaveText(
    t("trackedSelling.state.off"),
  );
  await lightAndDark(page, testInfo, "owner-409");
});

test("owner, on with a failed precondition: OD-T7 warning; switching off confirms first", async ({
  page,
  t,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const on = { ...off, enabled: true, unmetPreconditions: ["identity_anchor"] };
  await mock(page, "owner", on);
  let sent: unknown;
  await page.route(SETTING, (r) => {
    if (r.request().method() !== "PUT") return r.fallback();
    sent = r.request().postDataJSON();
    return r.fulfill(json({ ...on, enabled: false }));
  });
  await page.goto("/tenants/t1");
  const section = page.getByTestId("tracked-selling-section");
  await expect(section.getByText(t("trackedSelling.warning.title"))).toBeVisible();
  await lightAndDark(page, testInfo, "owner-warning");

  await section.getByRole("button", { name: t("trackedSelling.turnOff") }).click();
  const confirm = section.getByTestId("tracked-selling-confirm");
  await expect(
    confirm.getByRole("button", { name: t("trackedSelling.confirm.cancel") }),
  ).toBeFocused();
  await lightAndDark(page, testInfo, "owner-confirm-off");
  await confirm.getByRole("button", { name: t("trackedSelling.confirm.yes") }).click();
  await expect(section.getByText(t("trackedSelling.saved.off"))).toBeVisible();
  expect(sent).toEqual({ enabled: false });
  await expect(section.getByTestId("tracked-selling-state")).toHaveText(
    t("trackedSelling.state.off"),
  );
});

test("store_manager: on/off only, no action", async ({ page, t }, testInfo) => {
  await mock(page, "store_manager", {
    enabled: true,
    changedAt: null,
    changedBy: null,
    preconditionsMet: null,
    unmetPreconditions: null,
  });
  await page.goto("/tenants/t1");
  const section = page.getByTestId("tracked-selling-section");
  await expect(section.getByTestId("tracked-selling-state")).toHaveText(
    t("trackedSelling.state.on"),
  );
  await expect(section.getByRole("button")).toHaveCount(0);
  await lightAndDark(page, testInfo, "manager");
});

test("the deployment gate's 404 hides the setting and the tracking pages", async ({ page, t }) => {
  await mock(page, "owner", { error: { code: "not_found", message: "Not found." } }, 404);
  await page.goto("/tenants/t1");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("tracked-selling-section")).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: t("shell.nav.label") });
  await expect(nav.getByRole("link", { name: t("tracking.nav.label") })).toHaveCount(0);
  await page.goto("/tracking");
  await expect(page.getByTestId("tracking-selling-off")).toBeVisible();
});

test("OD-T4: switched off, no nav entry, and a deep link says the section is not available", async ({
  page,
  t,
}, testInfo) => {
  await mock(page, "owner", off);
  let findingsAsked = false;
  await page.route("**/api/inventory/v1/safety/findings", (r) => {
    findingsAsked = true;
    return r.fulfill(json({ findings: [], generatedAt: "2026-11-08T18:00:00Z" }));
  });
  await page.goto("/tenants/t1");
  await expect(page.getByTestId("tracked-selling-section")).toBeVisible();
  const nav = page.getByRole("navigation", { name: t("shell.nav.label") });
  await expect(nav.getByRole("link", { name: t("tracking.nav.label") })).toHaveCount(0);
  await page.goto("/tracking");
  await expect(page.getByTestId("tracking-selling-off")).toBeVisible();
  await expect(page.getByText(t("trackedSelling.pagesOff.title"))).toBeVisible();
  expect(findingsAsked).toBe(false);
  await lightAndDark(page, testInfo, "pages-off");
});
