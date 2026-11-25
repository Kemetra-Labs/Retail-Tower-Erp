import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-765 catalog product list E2E against mocked Backend-Core (C-5), CAT-C1a.
 * S1: role-gated nav → the list, in the server's order, requested with the
 *     default status and the page size; only console catalog routes are asked.
 * S2: search text is sent verbatim; status and category go to the URL and the
 *     request; Load more walks the cursor and de-duplicates by product id.
 * S3: store_staff has no entry; a direct URL reads as not available, no read.
 * S4: a store in scope adds the availability badges and the store's values.
 * S5: narrow widths keep every card readable: name, status and price stay,
 *     the metadata stays behind the card's details disclosure.
 * S6: keyboard walk with a real outline in normal and forced-colors modes.
 * RT-399: runs in both locales; copy comes from the catalog (`t`). axe (WCAG
 * 2.1 A/AA) runs on the loaded list, an empty list and an error state.
 *
 * Modern concept 2/6 (Catalog): the list is a card grid, not a table — the
 * old column-drop tests (S5/S7, RT-1236) are replaced by card-layout checks.
 */
const CAIRO = "0190f000-0000-7000-8000-0000000007a1";
const P1 = "0190f000-0000-7000-8000-0000000007b1";
const P2 = "0190f000-0000-7000-8000-0000000007b2";
const P3 = "0190f000-0000-7000-8000-0000000007b3";
const CATEGORY = "0190f000-0000-7000-8000-0000000007c1";

function ctx(role: string, store: { id: string; name: string } | null = null) {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: store,
    active_role_code: role,
    memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: role }],
  };
}

function product(over: Record<string, unknown> = {}) {
  return {
    productId: P1,
    name: "Mineral water 1.5L",
    status: "active",
    categoryId: CATEGORY,
    categoryName: "Beverages",
    primarySku: "SKU-0042",
    primaryBarcode: "0012345678905",
    defaultPrice: { amount: "10.5000", currencyCode: "EGP" },
    taxCategory: "standard",
    trackingMode: "none",
    updatedAt: "2026-10-07T10:30:00Z",
    ...over,
  };
}

function storeView(over: Record<string, unknown> = {}) {
  return {
    storeId: CAIRO,
    effectivePrice: { amount: "12.0000", currencyCode: "EGP" },
    effectiveActive: true,
    effectiveTaxCategory: "standard",
    hasOverride: true,
    ...over,
  };
}

const categories = {
  items: [
    {
      categoryId: CATEGORY,
      name: "Beverages",
      description: null,
      updatedAt: "2026-10-01T08:00:00Z",
    },
  ],
};

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

async function mockBase(
  page: Page,
  role: string,
  store: { id: string; name: string } | null = null,
) {
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(role, store))));
  await page.route("**/api/v1/catalog/categories", (r) => r.fulfill(json(categories)));
}

/**
 * Records every list query. Each answer is the next queued page, except that a
 * request carrying a cursor is answered by the page queued for that cursor.
 */
async function mockList(
  p: Page,
  pages: unknown[],
  byCursor: Record<string, unknown> = {},
): Promise<URLSearchParams[]> {
  const queries: URLSearchParams[] = [];
  await p.route("**/api/v1/catalog/products?**", (r) => {
    const params = new URL(r.request().url()).searchParams;
    queries.push(params);
    const cursor = params.get("cursor");
    const body =
      cursor !== null && cursor in byCursor
        ? byCursor[cursor]
        : pages[Math.min(queries.length - 1, pages.length - 1)];
    return r.fulfill(json(body));
  });
  return queries;
}

test("S1: owner → Items → list in server order; console catalog routes only", async ({
  page: p,
  t,
}) => {
  await mockBase(p, "owner");
  const queries = await mockList(p, [
    {
      items: [product(), product({ productId: P2, name: "Loose tea", defaultPrice: null })],
      nextCursor: null,
    },
  ]);
  const requested: { method: string; pathname: string }[] = [];
  p.on("request", (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.startsWith("/api/")) requested.push({ method: r.method(), pathname });
  });

  await p.goto("/");
  await p.getByRole("link", { name: t("catalog.nav.label"), exact: true }).click();
  await expect(p).toHaveURL(/\/catalog\/products$/);
  await expect(p.getByRole("heading", { name: t("catalog.list.title") })).toBeVisible();
  const grid = p.locator(".catalog-grid");
  await expect(grid.getByText("Mineral water 1.5L")).toBeVisible();
  await expect(grid.getByText("Loose tea")).toBeVisible();
  await expect(grid.getByText(t("catalog.value.noPrice"))).toBeVisible();
  await expect(p.getByRole("link", { name: t("catalog.nav.label"), exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );

  expect(queries).toHaveLength(1);
  expect(Object.fromEntries(queries[0])).toEqual({ status: "active", limit: "50" });
  // The catalog surface reads exactly the two catalog list operations, and the
  // page makes no write and no POS or ERP call. (The Overview the test passes
  // through reads other console panels of its own; those are not the catalog's.)
  const catalogReads = new Set(
    requested
      .filter((r) => r.pathname.startsWith("/api/v1/catalog/products"))
      .map((r) => r.pathname),
  );
  expect([...catalogReads]).toEqual(["/api/v1/catalog/products"]);
  expect(requested.filter((r) => r.method !== "GET")).toEqual([]);
  expect(requested.filter((r) => /\/api\/pos\/|frappe|erpnext(?!-)/i.test(r.pathname))).toEqual([]);

  await expectNoAxeViolations(p, "catalog list");
});

test("S2: search is verbatim, filters reach the URL and the request, Load more de-duplicates", async ({
  page: p,
  t,
}) => {
  await mockBase(p, "tenant_admin");
  const first = {
    items: [product({ productId: P1, name: "Alpha" }), product({ productId: P2, name: "Bravo" })],
    nextCursor: "c1",
  };
  const second = {
    items: [
      product({ productId: P1, name: "Alpha renamed" }),
      product({ productId: P3, name: "Charlie" }),
    ],
    nextCursor: null,
  };
  const queries = await mockList(p, [first], { c1: second });
  await p.goto("/catalog/products");
  await expect(p.locator(".catalog-grid").getByText("Alpha", { exact: true })).toBeVisible();

  await p.getByLabel(t("catalog.filter.q")).fill(" 0012 ");
  await p.getByLabel(t("catalog.filter.status"), { exact: true }).selectOption("any");
  // The category select sits behind «More filters».
  await p.getByRole("button", { name: t("filter.more"), exact: true }).click();
  await p.getByLabel(t("catalog.filter.category")).selectOption(CATEGORY);
  await p.getByRole("button", { name: t("filter.apply"), exact: true }).click();
  await expect.poll(() => queries.length).toBe(2);
  expect(Object.fromEntries(queries[1])).toEqual({
    q: " 0012 ",
    status: "any",
    category_id: CATEGORY,
    limit: "50",
  });
  await expect(p).toHaveURL(new RegExp(`status=any&category=${CATEGORY}`));

  await p.getByRole("button", { name: t("catalog.list.loadMore") }).click();
  await expect.poll(() => queries.length).toBe(3);
  expect(queries[2].get("cursor")).toBe("c1");
  const grid = p.locator(".catalog-grid");
  await expect(grid.getByText("Charlie")).toBeVisible();
  await expect(grid.getByText("Alpha renamed")).toBeVisible();
  await expect(grid.getByText("Alpha", { exact: true })).toHaveCount(0);
  await expect(p.getByText(t("catalog.list.ended"))).toBeFocused();
});

test("S2b: a filtered empty list names the filters and Clear returns to the default", async ({
  page: p,
  t,
}) => {
  await mockBase(p, "owner");
  await mockList(p, [{ items: [], nextCursor: null }]);
  await p.goto("/catalog/products?q=zzz&status=retired");
  // The search text shows in the applied-filter chip and in the empty message;
  // the exact match is the empty message's isolated <bdi>.
  await expect(p.getByText("zzz", { exact: true })).toBeVisible();
  await expectNoAxeViolations(p, "catalog filtered empty");
  await p.getByRole("button", { name: t("catalog.list.clearFilters") }).click();
  await expect(p).toHaveURL(/\/catalog\/products$/);
});

test("S3: store_staff has no entry; a direct URL reads as not available, no request", async ({
  page: p,
  t,
}) => {
  await mockBase(p, "store_staff");
  const queries = await mockList(p, [{ items: [product()], nextCursor: null }]);
  await p.goto("/");
  await expect(p.getByRole("link", { name: t("catalog.nav.label"), exact: true })).toHaveCount(0);
  await p.goto("/catalog/products");
  await expect(p.getByText(t("catalog.list.unavailable"))).toBeVisible();
  await expect(p.getByRole("form")).toHaveCount(0);
  expect(queries).toHaveLength(0);
});

test("S4: a store in scope sends store_id and shows the server-resolved store values", async ({
  page: p,
  t,
}) => {
  await mockBase(p, "store_manager", { id: CAIRO, name: "Cairo Festival" });
  const queries = await mockList(p, [
    { items: [product({ storeView: storeView() })], nextCursor: null },
  ]);
  await p.goto("/catalog/products");
  const grid = p.locator(".catalog-grid");
  await expect(grid.getByText(t("catalog.availability.yes"))).toBeVisible();
  await expect(grid.getByText("12.00 EGP")).toBeVisible();
  await expect(grid.getByText(t("catalog.availability.override"))).toBeVisible();
  expect(queries[0].get("store_id")).toBe(CAIRO);
  await expectNoAxeViolations(p, "catalog list with a store");
});

test("S4b: a 404 with a store in scope is the stale-store message, never 'no items'", async ({
  page: p,
  t,
}) => {
  await mockBase(p, "owner", { id: CAIRO, name: "Cairo Festival" });
  await p.route("**/api/v1/catalog/products?**", (r) =>
    r.fulfill(json({ error: { code: "not_found", message: "Not found" } }, 404)),
  );
  await p.goto("/catalog/products");
  await expect(p.getByText(t("catalog.list.storeStale"))).toBeVisible();
  await expect(p.getByText(t("catalog.list.empty"))).toHaveCount(0);
});

test("S4c: a first-page failure is a banner with Retry; axe is clean", async ({ page: p, t }) => {
  await mockBase(p, "owner");
  await p.route("**/api/v1/catalog/products?**", (r) =>
    r.fulfill(json({ error: { code: "x", message: "y", request_id: "req-500" } }, 500)),
  );
  await p.goto("/catalog/products");
  await expect(p.getByText(t("catalog.list.loadFailed"))).toBeVisible();
  await expect(p.getByRole("button", { name: t("catalog.list.retry") })).toBeVisible();
  await expectNoAxeViolations(p, "catalog error state");
});

test("S5: narrow widths keep every card readable: name, status and price stay", async ({
  page: p,
  t,
}) => {
  await mockBase(p, "owner");
  await mockList(p, [{ items: [product()], nextCursor: null }]);
  await p.setViewportSize({ width: 1400, height: 900 });
  await p.goto("/catalog/products");
  const card = p.locator(".catalog-card").first();
  await expect(card.getByText("Mineral water 1.5L")).toBeVisible();
  await expect(card.getByText("10.50 EGP")).toBeVisible();
  // The metadata is behind the card's details disclosure at every width.
  await expect(card.getByText(t("catalog.detail.field.taxCategory"))).toHaveCount(0);
  await card.getByRole("button", { name: t("catalog.list.cardMore") }).click();
  await expect(card.getByText(t("catalog.detail.field.taxCategory"))).toBeVisible();
  await expect(card.getByText("standard")).toBeVisible();
  await p.setViewportSize({ width: 1000, height: 900 });
  await expect(card.getByText("Mineral water 1.5L")).toBeVisible();
  await expect(card.getByText("10.50 EGP")).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await p.evaluate(() => document.documentElement.clientWidth),
  );
});

for (const forced of [false, true]) {
  test(`S6: keyboard walk reaches every control with a real outline (forced-colors ${forced})`, async ({
    page: p,
    t,
  }) => {
    await mockBase(p, "owner");
    await mockList(p, [
      { items: [product(), product({ productId: P2, name: "Loose tea" })], nextCursor: "c1" },
    ]);
    if (forced) await p.emulateMedia({ forcedColors: "active" });
    await p.goto("/catalog/products");
    await expect(p.locator(".catalog-grid")).toBeVisible();

    // Filter form (search, status, More filters, Clear, Apply), the category
    // chips, both cards (name link, then details), then Load more.
    await p.getByLabel(t("catalog.filter.q")).focus();
    const stops: { label: string; outlineStyle: string; outlineWidth: number }[] = [];
    for (let i = 0; i < 12; i++) {
      stops.push(
        await p.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          const style = getComputedStyle(el);
          return {
            label: el.textContent?.trim() || el.id || el.tagName,
            outlineStyle: style.outlineStyle,
            outlineWidth: Number.parseFloat(style.outlineWidth),
          };
        }),
      );
      await p.keyboard.press("Tab");
    }
    for (const stop of stops) {
      expect(stop.outlineStyle, stop.label).not.toBe("none");
      expect(stop.outlineWidth, stop.label).toBeGreaterThan(0);
    }
    // The walk really reached the cards and Load more, not only the form.
    expect(stops.some((s) => s.label.includes("Loose tea"))).toBe(true);
    expect(stops.at(-1)?.label).toContain(t("catalog.list.loadMore"));
  });
}

/**
 * RT-1236, cards edition: the list anchors numbers and flexes identity (UX-10).
 * A card's price never breaks across lines; the item name keeps room beside
 * the thumb; the grid stays inside its panel and the page never scrolls
 * sideways. Cards are measured from the rendered text, so a wrapped price
 * cannot pass by being short: a price is wrapped when its text spans more
 * than one line box. The codes may wrap inside their card (overflow-wrap);
 * only the price is guarded.
 */
const TEN_ROWS = Array.from({ length: 10 }, (_, i) => {
  const id = `0190f000-0000-7000-8000-0000000008${String(i).padStart(2, "0")}`;
  return product({
    productId: id,
    name: i % 3 === 0 ? "Mineral water 1.5L" : `Item number ${i + 1}`,
    primarySku: `SKU-${String(42 + i).padStart(4, "0")}`,
    primaryBarcode: `00123456789${String(10 + i).padStart(2, "0")}`,
    defaultPrice: { amount: `${10 + i * 7}.5000`, currencyCode: "EGP" },
    storeView: storeView({
      effectivePrice: { amount: `${12 + i * 7}.0000`, currencyCode: "EGP" },
      hasOverride: i % 2 === 0,
    }),
  });
});

/** Per card: name width, whether any price wraps, grid inside panel, page scroll. */
async function measureCards(p: Page) {
  return p.evaluate(() => {
    const lines = (el: Element) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      let count = 0;
      let bottom = Number.NEGATIVE_INFINITY;
      for (const r of [...range.getClientRects()].sort((a, b) => a.top - b.top)) {
        if (r.width === 0 || r.height === 0) continue;
        if (r.top >= bottom - 1) count += 1;
        bottom = Math.max(bottom, r.bottom);
      }
      return count;
    };
    const cards = [...document.querySelectorAll(".catalog-grid .catalog-card")];
    const grid = document.querySelector(".catalog-grid") as HTMLElement | null;
    const panel = document.querySelector(".catalog-results") as HTMLElement | null;
    const page = document.documentElement;
    return {
      cardCount: cards.length,
      nameWidth: Math.round(
        cards[0]?.querySelector(".catalog-card__name")?.getBoundingClientRect().width ?? 0,
      ),
      wrappedPrices: cards.filter(
        (c) => lines(c.querySelector(".catalog-card__price") as Element) > 1,
      ).length,
      gridInsidePanel:
        grid && panel
          ? grid.getBoundingClientRect().right <= panel.getBoundingClientRect().right + 1 &&
            grid.getBoundingClientRect().left >= panel.getBoundingClientRect().left - 1
          : false,
      pageScrolls: page.scrollWidth > page.clientWidth,
    };
  });
}

/** The item name keeps room to read: a few words, not a sliver (S7 and S7b). */
const MIN_ITEM_WIDTH = 120;

for (const width of [1440, 1280, 1200]) {
  test(`S7: with a store in scope, price stays on one line at ${width}`, async ({
    page: p,
  }) => {
    await mockBase(p, "store_manager", { id: CAIRO, name: "Cairo Festival" });
    await mockList(p, [{ items: TEN_ROWS, nextCursor: null }]);
    await p.setViewportSize({ width, height: 900 });
    await p.goto("/catalog/products");
    await expect(p.locator(".catalog-grid").getByText("Item number 2")).toBeVisible();

    const m = await measureCards(p);
    expect(m.cardCount).toBe(10);
    expect(m.wrappedPrices).toBe(0);
    expect(m.gridInsidePanel, "the grid stays inside its panel").toBe(true);
    expect(m.pageScrolls, "the page does not scroll sideways").toBe(false);
    expect(m.nameWidth).toBeGreaterThanOrEqual(MIN_ITEM_WIDTH);
  });
}

for (const width of [1600, 1380, 1101, 1024]) {
  test(`S7a: with a store in scope, cards keep name and price at ${width}`, async ({
    page: p,
  }) => {
    await mockBase(p, "store_manager", { id: CAIRO, name: "Cairo Festival" });
    await mockList(p, [{ items: TEN_ROWS, nextCursor: null }]);
    await p.setViewportSize({ width, height: 900 });
    await p.goto("/catalog/products");
    await expect(p.locator(".catalog-grid").getByText("Item number 2")).toBeVisible();

    const m = await measureCards(p);
    expect(m.cardCount).toBe(10);
    expect(m.wrappedPrices).toBe(0);
    expect(m.gridInsidePanel, "the grid stays inside its panel").toBe(true);
    expect(m.pageScrolls, "the page does not scroll sideways").toBe(false);
    expect(m.nameWidth).toBeGreaterThanOrEqual(MIN_ITEM_WIDTH);
  });
}

for (const width of [1440, 1280, 1200, 1101, 1024]) {
  test(`S7b: tenant scope at ${width} keeps single-line prices and a readable item name`, async ({
    page: p,
  }) => {
    await mockBase(p, "owner");
    await mockList(p, [
      { items: TEN_ROWS.map((r) => ({ ...r, storeView: undefined })), nextCursor: null },
    ]);
    await p.setViewportSize({ width, height: 900 });
    await p.goto("/catalog/products");
    await expect(p.locator(".catalog-grid").getByText("Item number 2")).toBeVisible();

    const m = await measureCards(p);
    expect(m.cardCount).toBe(10);
    expect(m.wrappedPrices).toBe(0);
    expect(m.gridInsidePanel, "the grid stays inside its panel").toBe(true);
    expect(m.pageScrolls, "the page does not scroll sideways").toBe(false);
    expect(m.nameWidth).toBeGreaterThanOrEqual(MIN_ITEM_WIDTH);
  });
}

test("S7d: a very long SKU cannot squeeze the item name below its floor at 1101", async ({
  page: p,
}) => {
  await mockBase(p, "owner");
  await mockList(p, [
    {
      items: TEN_ROWS.map((r) => ({
        ...r,
        storeView: undefined,
        primarySku: "BEV-WATER-1500ML-PK6-EXTRA-LONG-SUPPLIER-CODE-000042",
      })),
      nextCursor: null,
    },
  ]);
  await p.setViewportSize({ width: 1101, height: 900 });
  await p.goto("/catalog/products");
  await expect(p.locator(".catalog-grid").getByText("Item number 2")).toBeVisible();

  const m = await measureCards(p);
  expect(m.nameWidth).toBeGreaterThanOrEqual(MIN_ITEM_WIDTH);
  // The long code wraps inside its card; the grid stays inside its panel and
  // the page does not scroll.
  expect(m.gridInsidePanel).toBe(true);
  expect(m.pageScrolls).toBe(false);
});

test("S7c: a store in scope at 1024 keeps item, status and price and never clips the panel", async ({
  page: p,
}) => {
  await mockBase(p, "store_manager", { id: CAIRO, name: "Cairo Festival" });
  await mockList(p, [{ items: TEN_ROWS, nextCursor: null }]);
  await p.setViewportSize({ width: 1024, height: 900 });
  await p.goto("/catalog/products");
  const grid = p.locator(".catalog-grid");
  await expect(grid.getByText("Item number 2")).toBeVisible();
  await expect(grid.locator(".catalog-card").first().getByText("Active")).toBeVisible();

  const m = await measureCards(p);
  expect(m.wrappedPrices).toBe(0);
  expect(m.gridInsidePanel).toBe(true);
  expect(m.pageScrolls).toBe(false);
});
