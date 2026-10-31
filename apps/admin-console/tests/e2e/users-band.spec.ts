import { expectNoAxeViolations } from "./axe";
/**
 * RT-1014 — the Users band and role groups in a real layout. The band shows the
 * counts of the whole list (total, active, revoked); from 640px it is an Ink band
 * within 132px even with a very long Arabic tenant name, narrower it wraps its
 * facts instead of clipping them and the page never scrolls sideways. The roster
 * is one table with a header row per role, every member still opened by their
 * own named «Open» button, and the route passes axe.
 */
import { STORE, context } from "./compact-shell-data";
import { type Page, expect, test } from "./fixtures";

/** One long Arabic tenant name, so the band is measured with real pressure. */
const TENANT = "نورثستار للتجزئة والتوزيع والخدمات اللوجستية بالقاهرة الجديدة والتجمع الخامس";

function member(id: string, name: string | null, role: string, revoked = false, stores = 2) {
  return {
    membership_id: `m-${id}`,
    user: { id: `u-${id}`, email: `${id}@northstar-retail.eg`, display_name: name },
    role_code: role,
    store_access_kind: stores === 0 ? "all" : "specific",
    accessible_store_ids: Array.from({ length: stores }, (_, i) => `s${i}`),
    revoked_at: revoked ? "2026-06-01T00:00:00Z" : null,
  };
}

const MEMBERS = [
  member("a1", "منى السيد", "tenant_admin", false, 0),
  member("a2", "كريم عادل", "store_manager"),
  member("a3", "هالة فوزي", "store_manager", false, 1),
  member("a4", "يوسف ناصر", "manager", false, 3),
  member("a5", null, "cashier", false, 1),
  member("a6", "طارق منير", "auditor"),
  member("a7", "سارة إبراهيم", "cashier", true),
];

async function openUsers(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await page.route("**/api/v1/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/v1/context/me", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...context,
        active_store: { id: STORE, name: "x" },
        active_tenant: { id: "t1", name: TENANT },
      }),
    }),
  );
  await page.route("**/api/v1/tenants/t1/members", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MEMBERS) }),
  );
  await page.goto("/operators");
  await page.locator("dl.list-band__facts").waitFor();
}

function measure(page: Page) {
  return page.evaluate(() => {
    const band = document.querySelector("header.list-band") as HTMLElement;
    const box = band.getBoundingClientRect();
    const parts = [...band.querySelectorAll("dd, .list-band__end")];
    const allInside = parts.every((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
    });
    return {
      height: Math.round(box.height),
      allInside,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

test("1280: the Ink band holds the three counts within 132px, with a very long tenant name", async ({
  page,
  t,
}) => {
  await openUsers(page, 1280);
  const facts = page.locator("dl.list-band__facts");
  await expect(facts).toHaveAttribute("aria-label", t("operators.band.label"));
  const values = await facts.locator("div").evaluateAll((rows) =>
    rows.map((row) => ({
      label: row.querySelector("dt")?.textContent,
      // The first fact also holds the (aria-hidden) avatar pile: read its figure span.
      value: row.querySelector("dd .member-fact > span:last-child, dd:not(:has(.member-fact))")
        ?.textContent,
    })),
  );
  expect(values).toEqual([
    { label: t("operators.band.total"), value: "7" },
    { label: t("operators.band.active"), value: "6" },
    { label: t("operators.band.revoked"), value: "1" },
  ]);
  const layout = await measure(page);
  expect(layout.height).toBeLessThanOrEqual(132);
  expect(layout.allInside).toBe(true);
  expect(layout.pageOverflow).toBe(0);
});

test("one table with a header row per role; every member keeps a named Open button", async ({
  page,
  t,
  roleName,
}) => {
  await openUsers(page, 1280);
  const groups = page.locator("th[scope=rowgroup]");
  // tenant_admin, store_manager, manager, cashier, then the unknown «auditor».
  await expect(groups).toHaveCount(5);
  await expect(groups.nth(1)).toContainText(roleName("store_manager"));
  await expect(groups.last()).toContainText(roleName("auditor"));
  await expect(page.getByRole("table")).toHaveCount(1);
  for (const m of MEMBERS) {
    const name = m.user.display_name ? `${m.user.display_name} (${m.user.email})` : m.user.email;
    await expect(
      page.getByRole("button", { name: t("table.selection.openRow", { value: name }) }),
    ).toHaveCount(1);
  }
  // A raw role code never reaches the page.
  await expect(page.getByText("auditor", { exact: true })).toHaveCount(0);
});

test("900: the band wraps rather than clips; 390: the page never scrolls sideways", async ({
  page,
}) => {
  await openUsers(page, 900);
  const mid = await measure(page);
  expect(mid.allInside).toBe(true);
  expect(mid.pageOverflow).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator("dl.list-band__facts").waitFor();
  const phone = await measure(page);
  expect(phone.allInside).toBe(true);
  expect(phone.pageOverflow).toBe(0);
});

test("the Users route has no axe violations", async ({ page }) => {
  await openUsers(page, 1280);
  await page.locator("table.member-table").waitFor();
  await expectNoAxeViolations(page, "operators v4");
});
