import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CSP_WITH_FRAME,
  RELEASE,
  context,
  envelope,
  mockDownloadPos,
} from "../e2e/download-pos-mock";
import { type Page, expect, test } from "../e2e/fixtures";

/**
 * RT-1304: evidence captures of the pilot Download POS page, taken in CI only (owner rule: no
 * browser on the owner's laptop), through the `admin-captures` workflow with Backend-Core and
 * S3 mocked. Every state of the spec's matrix (RT-1302 §6) is saved in the locale project that
 * runs it (Arabic and English): S0 ready, S1 busy, S2 issued, S3 unavailable, S4 session lost,
 * S5 not available (staff role, and a support session), S6 support-session refusal, S7
 * rate-limited, S8 failure, S9 network, S10 no tenant, S11 multi-tenant hint. Plus the page at
 * 360 px, in dark and in forced colours. It records what it shows; it fails only if the page
 * crashes. Files do not end `__meta.json`, so `build-index.mjs` ignores them.
 */

const OUT = process.env.CAPTURE_DIR ?? "playwright-report/captures";
const TICKET = "RT-1304";
const PATH = "/devices/download-pos";
mkdirSync(OUT, { recursive: true });

async function shot(page: Page, name: string, locale: string, suffix = ""): Promise<void> {
  await page.screenshot({
    path: join(OUT, `${TICKET}__${name}__${locale}${suffix}.png`),
    fullPage: true,
  });
}

const STATES = [
  { name: "S3-unavailable", latest: { status: 200, body: { available: false } } },
  { name: "S4-session-lost", latest: { status: 401, body: envelope("unauthorized") } },
  {
    name: "S6-support-session-refused",
    latest: { status: 403, body: envelope("support_session_required") },
  },
  {
    name: "S7-rate-limited",
    latest: { status: 429, body: envelope("rate_limited"), headers: { "retry-after": "30" } },
  },
  { name: "S8-failure", latest: { status: 500, body: envelope("system_failure") } },
  { name: "S5-not-found-404", latest: { status: 404, body: envelope("not_found") } },
] as const;

test("RT-1304 S0, S1, S2: ready, busy and issued", async ({ page, t, appLocale }) => {
  await mockDownloadPos(page, { delayMs: 1500, s3: "attachment", csp: CSP_WITH_FRAME });
  await page.goto(PATH);
  const action = page.getByRole("button", { name: t("devices.download.action") });
  await expect(action).toBeVisible();
  await shot(page, "S0-ready", appLocale);
  await action.click();
  await expect(page.getByText(t("devices.download.busy"))).toBeVisible();
  await shot(page, "S1-busy", appLocale);
  await expect(page.getByText(RELEASE.fileName)).toBeVisible();
  await shot(page, "S2-issued", appLocale);
});

for (const state of STATES) {
  test(`RT-1304 ${state.name}`, async ({ page, t, appLocale }) => {
    await mockDownloadPos(page, { latest: state.latest });
    await page.goto(PATH);
    await page.getByRole("button", { name: t("devices.download.action") }).click();
    await expect(page.getByRole("button", { name: t("devices.download.action") })).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, state.name, appLocale);
  });
}

test("RT-1304 S9: network failure", async ({ page, t, appLocale }) => {
  await mockDownloadPos(page, { abort: true });
  await page.goto(PATH);
  await page.getByRole("button", { name: t("devices.download.action") }).click();
  await expect(page.getByText(t("devices.download.network"))).toBeVisible();
  await shot(page, "S9-network", appLocale);
});

test("RT-1304 S5: not available to a staff role and in a support session", async ({
  page,
  t,
  appLocale,
}) => {
  await mockDownloadPos(page, { role: "store_staff" });
  await page.goto(PATH);
  await expect(page.getByText(t("devices.download.notAllowed"))).toBeVisible();
  await shot(page, "S5-not-available-role", appLocale);

  await mockDownloadPos(page, {
    ctx: context("owner", {
      support_session: {
        id: "11111111-1111-4111-8111-111111111111",
        tenant_id: "t1",
        purpose: "incident",
        ticket_ref: "SUP-1",
        status: "active",
        expires_at: new Date(Date.now() + 40 * 60_000).toISOString(),
        renewal_cap_at: new Date(Date.now() + 8 * 3_600_000).toISOString(),
      },
    }),
  });
  await page.goto(PATH);
  await expect(page.getByText(t("devices.download.notAllowed"))).toBeVisible();
  await shot(page, "S5-not-available-support-session", appLocale);
});

test("RT-1304 S10 and S11: no tenant, and the multi-tenant hint", async ({
  page,
  t,
  appLocale,
}) => {
  await mockDownloadPos(page, { ctx: { ...context("owner"), active_tenant: null } });
  await page.goto(PATH);
  await expect(page.getByText(t("devices.list.scopePrompt"))).toBeVisible();
  await shot(page, "S10-no-tenant", appLocale);

  await mockDownloadPos(page, {
    ctx: {
      ...context("owner"),
      memberships: [
        { tenant_id: "t1", tenant_name: "Northstar Retail", role_code: "owner" },
        { tenant_id: "t2", tenant_name: "Harbor Foods", role_code: "owner" },
      ],
    },
  });
  await page.goto(PATH);
  await expect(page.getByText(t("devices.download.multiTenant"))).toBeVisible();
  await shot(page, "S11-multi-tenant", appLocale);
});

test("RT-1304 360 px, dark and forced colours", async ({ page, t, appLocale }) => {
  await mockDownloadPos(page, { s3: "attachment", csp: CSP_WITH_FRAME });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(PATH);
  await page.getByRole("button", { name: t("devices.download.action") }).click();
  await expect(page.getByText(RELEASE.fileName)).toBeVisible();
  await shot(page, "issued-360", appLocale);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await shot(page, "issued-dark", appLocale);

  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.emulateMedia({ forcedColors: "active" });
  await page.getByRole("button", { name: t("devices.download.action") }).focus();
  await shot(page, "issued-forced-colors", appLocale);
});
