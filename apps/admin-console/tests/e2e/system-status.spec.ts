import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1071: the sidebar system-status block (RT-1056). Mocked Backend-Core (C-5),
 * both locales by project, light and dark, axe over the settled page.
 */

const AT = "2026-11-02T10:00:00.000Z";
const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const context = (role: string) => ({
  user: { id: "u1", email: "a@example.test", display_name: "Amal Saleh", is_platform_admin: false },
  active_tenant: { id: "t1", name: "Northstar Retail" },
  active_store: null,
  active_role_code: role,
  memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: role }],
});
const statusBody = {
  asOf: AT,
  overall: "degraded",
  components: {
    server: { state: "ok", reason: "answered", observedAt: AT, link: "none" },
    saleSync: {
      state: "degraded",
      reason: "queue_behind",
      observedAt: AT,
      link: "sale_sync_ops",
      facts: { undeliveredCount: 3, oldestUndeliveredAgeSeconds: 400, needsRepairCount: 0 },
    },
    erpConnector: {
      state: "unknown",
      reason: "not_configured",
      observedAt: null,
      link: "erp_connection",
      facts: null,
    },
  },
};

async function mock(
  page: Page,
  role: string,
  status: { code: number; body: unknown },
): Promise<void> {
  await page.route("**/api/v1/**", (r) =>
    r.fulfill(json(200, r.request().url().includes("?") ? { items: [], nextCursor: null } : {})),
  );
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(200, context(role))));
  await page.route("**/api/v1/stores", (r) => r.fulfill(json(200, [])));
  await page.route("**/api/v1/system-status", (r) => r.fulfill(json(status.code, status.body)));
}

test.describe("RT-1071 system-status block", () => {
  test("shows each component's state, links the destinations, passes axe in light and dark", async ({
    page,
    t,
  }) => {
    await mock(page, "owner", { code: 200, body: statusBody });
    await page.goto("/");
    const block = page.getByRole("group", { name: t("shell.status.title") });
    await expect(block).toBeVisible();
    await expect(block.getByText(t("shell.status.state.degraded"))).toBeVisible();
    await expect(block.getByText(t("shell.status.state.unknown"))).toBeVisible();
    await expect(block.getByText(t("shell.status.reason.queue_behind"))).toBeVisible();
    await expect(
      block.getByRole("link", { name: t("shell.status.component.saleSync") }),
    ).toHaveAttribute("href", "/sales-needing-repair");
    await expect(block.getByRole("link", { name: t("shell.status.component.server") })).toHaveCount(
      0,
    );
    for (const theme of ["light", "dark"] as const) {
      if (theme === "dark") {
        await page.evaluate(() => {
          localStorage.setItem("rt.theme.v1:user:u1", "dark");
          localStorage.setItem("rt.theme.v1:last", "dark");
        });
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await expect(block).toBeVisible();
      }
      await expectNoAxeViolations(page, `status block ${theme}`);
    }
  });

  // RT-1552: the optional shipmentTransfers component (RT-1516). Mocked Backend-Core; the link is none.
  const transfers = (state: string, reason: string, facts: object | null) => ({
    ...statusBody,
    overall: state === "ok" ? "degraded" : state,
    components: {
      ...statusBody.components,
      shipmentTransfers: { state, reason, observedAt: AT, link: "none", facts },
    },
  });
  const FACTS = {
    openTransferCount: 4,
    delayedTransferCount: 2,
    oldestOpenTransferAgeSeconds: 400_000,
    delayedThresholdDays: 3,
    stuckPostingCount: 0,
    postingsNeedingAttentionCount: 0,
    unreleasedReceiptCount: 0,
  };

  test("a degraded shipmentTransfers row names the component, its reason and one count, with no link", async ({
    page,
    t,
  }) => {
    await mock(page, "owner", {
      code: 200,
      body: transfers("degraded", "transfers_delayed", FACTS),
    });
    await page.goto("/");
    const block = page.getByRole("group", { name: t("shell.status.title") });
    const row = block.getByRole("listitem").filter({
      hasText: t("shell.status.component.shipmentTransfers"),
    });
    await expect(row).toBeVisible();
    await expect(row.getByText(t("shell.status.state.degraded"))).toBeVisible();
    await expect(row.getByText(t("shell.status.reason.transfers_delayed"))).toBeVisible();
    await expect(
      row.getByText(
        t("shell.status.fact.transfers_delayed", {
          threshold: t("shell.status.fact.days", { count: 3 }),
          count: 2,
        }),
      ),
    ).toBeVisible();
    await expect(row.getByRole("link")).toHaveCount(0);
    for (const theme of ["light", "dark"] as const) {
      if (theme === "dark") {
        await page.evaluate(() => {
          localStorage.setItem("rt.theme.v1:user:u1", "dark");
          localStorage.setItem("rt.theme.v1:last", "dark");
        });
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await expect(row).toBeVisible();
      }
      await expectNoAxeViolations(page, `status block shipmentTransfers ${theme}`);
    }
  });

  test("a timed-out shipmentTransfers check is unknown, and an older server shows no such row", async ({
    page,
    t,
  }) => {
    await mock(page, "owner", { code: 200, body: transfers("unknown", "check_timed_out", null) });
    await page.goto("/");
    const block = page.getByRole("group", { name: t("shell.status.title") });
    const row = block.getByRole("listitem").filter({
      hasText: t("shell.status.component.shipmentTransfers"),
    });
    await expect(row.getByText(t("shell.status.state.unknown"))).toBeVisible();
    await expect(row.getByText(t("shell.status.state.ok"), { exact: true })).toHaveCount(0);

    await mock(page, "owner", { code: 200, body: statusBody });
    await page.reload();
    await expect(block.getByText(t("shell.status.reason.queue_behind"))).toBeVisible();
    await expect(block.getByText(t("shell.status.component.shipmentTransfers"))).toHaveCount(0);
    await expect(block.getByRole("listitem")).toHaveCount(3);
  });

  test("a failed read is shown as unknown, not healthy", async ({ page, t }) => {
    await mock(page, "owner", { code: 500, body: { error: { code: "x", message: "x" } } });
    await page.goto("/");
    const block = page.getByRole("group", { name: t("shell.status.title") });
    await expect(block.getByText(t("shell.status.readFailed"))).toBeVisible();
    await expect(block.getByText(t("shell.status.state.ok"), { exact: true })).toHaveCount(0);
    await expectNoAxeViolations(page, "status block failed");
  });

  test("a 404 hides the block", async ({ page, t }) => {
    await mock(page, "owner", { code: 404, body: { error: { code: "not_found", message: "x" } } });
    await page.goto("/");
    await page.locator(".content").waitFor();
    await expect(page.getByRole("group", { name: t("shell.status.title") })).toHaveCount(0);
  });

  test("a role that cannot read it sends no request and shows no block", async ({ page, t }) => {
    let asked = 0;
    await mock(page, "cashier", { code: 200, body: statusBody });
    await page.route("**/api/v1/system-status", (r) => {
      asked++;
      return r.fulfill(json(200, statusBody));
    });
    await page.goto("/");
    await page.locator(".content").waitFor();
    await expect(page.getByRole("group", { name: t("shell.status.title") })).toHaveCount(0);
    expect(asked).toBe(0);
  });
});
