import { type Page, expect, test } from "./fixtures";

/**
 * RT-965 (DESIGN.md §8): a failed load reads What → Safety → Action → Evidence, in both locales,
 * against mocked Backend-Core (C-5). The device registry list is the surface: a 500 whose body
 * carries `request_id`, and a network failure (the request is aborted).
 */
const REQUEST_ID = "req-rt965-0001";

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

async function mockBase(page: Page): Promise<void> {
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/device-health**", (r) => r.fulfill({ status: 404 }));
  await page.route("**/api/v1/context/me", (r) =>
    r.fulfill(
      json({
        user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
        active_tenant: { id: "t1", name: "Northstar Retail" },
        active_store: null,
        active_role_code: "owner",
        memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: "owner" }],
      }),
    ),
  );
  await page.route("**/api/v1/stores", (r) => r.fulfill(json([])));
}

test("a 500 on the device list: cause, nothing changed, a retry, and the request id", async ({
  page,
  t,
}) => {
  await mockBase(page);
  await page.route("**/api/v1/devices?**", (r) =>
    r.fulfill(json({ error: { code: "internal", message: "boom", request_id: REQUEST_ID } }, 500)),
  );

  await page.goto("/devices");
  const alert = page.getByRole("alert").filter({ hasText: t("devices.list.loadFailed") });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(t("errors.load.cause.server"));
  await expect(alert).toContainText(t("errors.load.safety"));
  await expect(alert).toContainText(REQUEST_ID);
  await expect(alert.getByRole("button", { name: t("devices.list.retry") })).toBeVisible();
});

test("a network failure on the device list: cause, nothing changed, a retry that recovers", async ({
  page,
  t,
}) => {
  await mockBase(page);
  let failing = true;
  await page.route("**/api/v1/devices?**", (r) =>
    failing ? r.abort("connectionfailed") : r.fulfill(json({ items: [], nextCursor: null })),
  );

  await page.goto("/devices");
  const alert = page.getByRole("alert").filter({ hasText: t("devices.list.loadFailed") });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(t("errors.load.cause.network"));
  await expect(alert).toContainText(t("errors.load.safety"));
  const retry = alert.getByRole("button", { name: t("devices.list.retry") });
  await expect(retry).toBeVisible();

  failing = false;
  await retry.click();
  await expect(page.getByText(t("devices.list.empty"))).toBeVisible();
  await expect(alert).toHaveCount(0);
});
