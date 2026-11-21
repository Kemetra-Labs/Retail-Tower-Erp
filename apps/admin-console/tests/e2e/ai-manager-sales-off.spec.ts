import { expect, test } from "./fixtures";

/**
 * RT-1541 against the BUILT SPA (production preview, mocked Backend-Core): the Manager Sales panel
 * is behind a default-OFF rollout flag (VITE_AI_MANAGER_SALES_PANEL, unset in every committed
 * config), so no role sees it, the base sales-by-store page still works, and no request to the
 * explain operation is ever sent. The panel's states are covered by ai-manager-sales.spec.ts
 * (harness, mocked API) and by the unit tests.
 */
const TENANT = "t1";

function ctx(role: string) {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: TENANT, name: "Northstar Retail" },
    active_store: null,
    active_role_code: role,
    memberships: [
      {
        tenant_id: TENANT,
        tenant_name: "Northstar Retail",
        role_code: role,
        store_access_kind: "all",
      },
    ],
  };
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

for (const role of ["owner", "tenant_admin", "store_manager"]) {
  test(`flag OFF (production build): ${role} sees no panel and no explain request is sent`, async ({
    page,
    t,
  }) => {
    let explainCalls = 0;
    await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
    await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(role))));
    await page.route("**/api/v1/stores", (r) => r.fulfill(json([])));
    await page.route("**/api/v1/sales-by-store**", (r) => r.fulfill(json({}, 404)));
    await page.route("**/api/v1/ai/manager-sales/explain", (r) => {
      explainCalls += 1;
      return r.fulfill(json({}, 404));
    });

    await page.goto("/sales-by-store");
    await expect(page.getByRole("heading", { name: t("salesByStore.title") })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(t("aiManagerSales.title"))).toHaveCount(0);
    await expect(page.getByRole("button", { name: t("aiManagerSales.ask") })).toHaveCount(0);
    expect(explainCalls).toBe(0);
  });
}
