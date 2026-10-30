import { pending } from "../unit/device-pairing-fixtures";
import { TIER1, mockRealisticApi } from "./compact-shell-data";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-963 screen-reader and reflow semantics, in both locale projects with
 * mocked Backend-Core (C-5).
 *
 * AC 1: every Tier 1 route names the document «<page title> – <app title>»,
 * and no two routes share a title.
 * AC 5: at 390px the non-detail tables scroll inside their own region, never
 * `.content`, and each region is a named, focusable Tab stop.
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

test("AC 1: each Tier 1 route sets its own document title", async ({ page, t }) => {
  await mockRealisticApi(page);
  const titles = new Map<string, string>();
  for (const path of TIER1) {
    await page.goto(path);
    const h1 = page.locator("h1[data-page-title]");
    await expect(h1).toBeVisible();
    await expect
      .poll(
        async () => {
          const heading = (await h1.textContent())?.trim() ?? "";
          return (await page.title()) === `${heading} – ${t("app.title")}`;
        },
        { message: `${path}: title follows the h1` },
      )
      .toBe(true);
    titles.set(path, await page.title());
  }
  const seen = new Map<string, string>();
  for (const [path, title] of titles) {
    expect(seen.get(title), `${path} shares its title «${title}»`).toBeUndefined();
    seen.set(title, path);
  }
});

async function mockListTables(page: Page): Promise<void> {
  await mockRealisticApi(page);
  await page.route("**/api/v1/tenants/t1/members", (r) =>
    r.fulfill(
      json([
        {
          membership_id: "m1",
          user: {
            id: "u1",
            email: "mohamed.abdelrahman@northstar-retail.eg",
            display_name: "محمد عبد الرحمن السيد",
          },
          role_code: "tenant_admin",
          store_access_kind: "specific",
          accessible_store_ids: ["s1", "s2", "s3"],
          revoked_at: null,
        },
      ]),
    ),
  );
  await page.route("**/api/v1/pairing-codes?**", (r) =>
    r.fulfill(json({ items: [pending()], nextCursor: null })),
  );
  await page.route("**/api/v1/settlement/payer-accounts**", (r) =>
    r.fulfill(
      json({
        items: [
          {
            payerRef: "p1",
            category: "insurer",
            displayName: "شركة التأمين الطبي المتحدة للخدمات الصحية",
            externalRef: "INS-99-NORTHSTAR-CAIRO",
            status: "active",
            storeId: null,
            version: 0,
          },
        ],
        nextCursor: null,
      }),
    ),
  );
  await page.route("**/api/v1/audit/events**", (r) =>
    r.fulfill(
      json({
        items: [
          {
            id: "e1",
            occurred_at: "2026-06-01T21:14:03Z",
            action: "shift.forced_close",
            actor_label: "محمد عبد الرحمن السيد",
            store_id: "s1",
            target_type: "shift",
            target_id: "sh-9",
            request_id: "11111111-1111-1111-1111-111111111111",
            metadata: { reason: "till_discrepancy" },
          },
        ],
        next_cursor: null,
      }),
    ),
  );
}

test.describe("AC 5: list tables reflow at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const path of ["/operators", "/devices/pairing-codes", "/payer-accounts", "/audit"]) {
    test(`${path}: no sideways page scroll; the table region is focusable`, async ({ page, t }) => {
      await mockListTables(page);
      await page.goto(path);
      // The audit view reads only once a search is applied.
      if (path === "/audit")
        await page.getByRole("button", { name: t("filter.apply"), exact: true }).click();
      const region = page.locator(".data-table__scroll");
      await expect(region.locator("tbody tr").first()).toBeVisible();

      const o = await page.evaluate(() => {
        const content = document.querySelector<HTMLElement>(".content");
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          contentScroll: content?.scrollWidth ?? -1,
          contentClient: content?.clientWidth ?? -1,
        };
      });
      expect(o.innerWidth, "viewport not zoomed out").toBe(390);
      expect(o.scrollWidth, "page width").toBeLessThanOrEqual(390);
      expect(o.contentClient, ".content rendered").toBeGreaterThan(0);
      expect(o.contentScroll, ".content sideways scroll").toBeLessThanOrEqual(o.contentClient);

      await expect(region).toHaveCount(1);
      await expect(region).toHaveAttribute("tabindex", "0");
      await expect(region).toHaveAccessibleName(/\S/);
      await region.focus();
      await expect(region).toBeFocused();
    });
  }
});
