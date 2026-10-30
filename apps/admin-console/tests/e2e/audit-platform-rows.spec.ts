import type { Locator } from "@playwright/test";
import { expectNoAxeViolations } from "./axe";
import { type LocaleFixtures, type Page, expect, test } from "./fixtures";

/**
 * RT-784 (RT-777 S5): a tenant owner sees the platform support-session rows in
 * the existing audit view (`/audit`), each with a recognisable label beside its
 * verbatim action code, in both locales and both themes. The rows come from the
 * tenant-scoped `listAuditEvents`; nothing new is requested. Mocked DP2 (C-5);
 * action codes and metadata follow the pinned `platform-support-sessions`
 * contract (`SupportSessionAuditMetadata`, `CrossTenantAccessAuditMetadata`).
 */

const context = {
  user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
  active_tenant: { id: "t1", name: "Northstar Retail" },
  active_store: null,
  active_role_code: "owner",
  memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: "owner" }],
};

const SESSION = "01a16955-845f-7559-99ae-7197bef2b47e";
const ADMIN = "b74f1728-0000-4000-8000-000000000001";

function row(id: string, at: string, action: string, metadata: Record<string, unknown>) {
  return {
    id,
    occurred_at: at,
    action,
    kind: "change",
    actor_user_id: ADMIN,
    actor_label: "platform_support",
    tenant_id: "t1",
    store_id: null,
    target_type: null,
    target_id: null,
    request_id: `0000000${id.slice(-1)}-2222-4222-8222-222222222222`,
    metadata,
  };
}

const base = {
  actor_kind: "platform_admin",
  support_session_id: SESSION,
  purpose: "customer_support",
};

const events = [
  row("p6", "2026-10-23T15:20:00Z", "platform.support_session.suspended", { outcome: "succeeded" }),
  row("p5", "2026-10-23T15:16:46Z", "platform.support_session.ended", {
    ...base,
    outcome: "succeeded",
    ticket_ref: "RT-782",
    end_reason: "operator",
  }),
  row("p4", "2026-10-23T15:16:40Z", "platform.cross_tenant.accessed", {
    ...base,
    outcome: "rejected",
    reason: "support_session_read_only",
    method: "POST",
    route: "/api/v1/stores",
  }),
  row("p3", "2026-10-23T15:16:30Z", "platform.cross_tenant.accessed", {
    ...base,
    outcome: "succeeded",
    method: "GET",
    route: "/api/v1/sales/:saleId",
  }),
  row("p2", "2026-10-23T15:16:20Z", "platform.support_session.renewed", {
    ...base,
    outcome: "succeeded",
    ticket_ref: "RT-782",
    expires_at: "2026-10-23T16:16:20Z",
  }),
  row("p1", "2026-10-23T15:16:14Z", "platform.support_session.opened", {
    ...base,
    outcome: "succeeded",
    ticket_ref: "RT-782",
    expires_at: "2026-10-23T16:16:14Z",
  }),
];

async function mockApi(page: Page): Promise<string[]> {
  const auditUrls: string[] = [];
  await page.route("**/api/v1/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/v1/context/me", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(context) }),
  );
  await page.route("**/api/v1/audit/events**", (r) => {
    auditUrls.push(r.request().url());
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: events, next_cursor: null }),
    });
  });
  return auditUrls;
}

async function darkTheme(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem("rt.theme.v1:user:u1", "dark");
    localStorage.setItem("rt.theme.v1:last", "dark");
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
}

async function search(page: Page, t: LocaleFixtures["t"]): Promise<void> {
  await page.getByRole("button", { name: t("filter.apply"), exact: true }).click();
  await expect(page.getByText("platform.support_session.opened")).toBeVisible();
}

test("owner sees platform support-session rows with labels; unknown action renders its code; axe light and dark", async ({
  page,
  t,
}) => {
  const auditUrls = await mockApi(page);
  await page.goto("/audit");
  await search(page, t);

  const table = page.getByRole("table", { name: t("audit.table.caption") });
  const expected: [string, string][] = [
    ["platform.support_session.opened", t("audit.action.supportSessionOpened")],
    ["platform.support_session.renewed", t("audit.action.supportSessionRenewed")],
    ["platform.support_session.ended", t("audit.action.supportSessionEnded")],
  ];
  for (const [code, label] of expected) {
    const button = table.getByRole("button", { name: new RegExp(code.replaceAll(".", "\\.")) });
    await expect(button).toBeVisible();
    await expect(button.getByText(label, { exact: true })).toBeVisible();
  }
  // Both cross-tenant rows: the admitted one and the refused one are told apart.
  await expect(table.getByText(t("audit.action.crossTenantAccessed"), { exact: true })).toHaveCount(
    1,
  );
  await expect(table.getByText(t("audit.action.crossTenantRefused"), { exact: true })).toHaveCount(
    1,
  );
  await expect(table.getByText("platform.cross_tenant.accessed", { exact: true })).toHaveCount(2);

  // A future platform action has no label: its code renders alone, nothing breaks.
  const future = table.getByRole("button", {
    name: "platform.support_session.suspended",
    exact: true,
  });
  await expect(future).toBeVisible();

  // Only the tenant-scoped read was used, with no tenant id on the wire.
  expect(auditUrls.length).toBeGreaterThan(0);
  for (const url of auditUrls) {
    expect(new URL(url).pathname).toBe("/api/v1/audit/events");
    expect(url).not.toContain("tenant");
  }

  await expectNoAxeViolations(page, "audit list with platform rows");
  await darkTheme(page);
  await search(page, t);
  await expect(
    page.getByText(t("audit.action.supportSessionOpened"), { exact: true }),
  ).toBeVisible();
  await expectNoAxeViolations(page, "audit list with platform rows dark");
});

test("inspecting a refused platform access row shows its label, code and metadata; axe light and dark", async ({
  page,
  t,
}) => {
  await mockApi(page);
  await page.goto("/audit");
  await search(page, t);

  async function openRefused(): Promise<Locator> {
    await page
      .getByRole("button", { name: new RegExp(t("audit.action.crossTenantRefused")) })
      .click();
    const drawer = page.getByRole("dialog", { name: t("audit.inspect.title") });
    await expect(drawer).toBeVisible();
    return drawer;
  }

  const drawer = await openRefused();
  await expect(
    drawer.getByText(t("audit.action.crossTenantRefused"), { exact: true }),
  ).toBeVisible();
  await expect(drawer.getByText("platform.cross_tenant.accessed", { exact: true })).toBeVisible();
  await expect(drawer.getByText('"support_session_read_only"', { exact: true })).toBeVisible();
  await expect(drawer.getByText('"/api/v1/stores"', { exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "audit inspect platform row");

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  await darkTheme(page);
  await search(page, t);
  const dark = await openRefused();
  await expect(dark.getByText(t("audit.action.crossTenantRefused"), { exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "audit inspect platform row dark");
});
