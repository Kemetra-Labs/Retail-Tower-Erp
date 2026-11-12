import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-765 catalog product list E2E against mocked Backend-Core (C-5), CAT-C1a.
 * S1: role-gated nav → the list, in the server's order, requested with the
 *     default status and the page size; only console catalog routes are asked.
 * S2: search text is sent verbatim; status and category go to the URL and the
 *     request; Load more walks the cursor and de-duplicates by product id.
 * S3: store_staff has no entry; a direct URL reads as not available, no read.
 * S4: a store in scope adds the availability column and the store's values.
 * S5: narrow widths drop the metadata columns first.
 * S6: keyboard walk with a real outline in normal and forced-colors modes.
 * RT-399: runs in both locales; copy comes from the catalog (`t`). axe (WCAG
 * 2.1 A/AA) runs on the loaded list, an empty list and an error state.
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
  const table = p.getByRole("table");
  await expect(table.getByText("Mineral water 1.5L")).toBeVisible();
  await expect(table.getByText("Loose tea")).toBeVisible();
  await expect(table.getByText(t("catalog.value.noPrice"))).toBeVisible();
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
  await expect(p.getByRole("table").getByText("Alpha", { exact: true })).toBeVisible();

  await p.getByLabel(t("catalog.filter.q")).fill(" 0012 ");
  await p.getByLabel(t("catalog.filter.status"), { exact: true }).selectOption("any");
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
  const table = p.getByRole("table");
  await expect(table.getByText("Charlie")).toBeVisible();
  await expect(table.getByText("Alpha renamed")).toBeVisible();
  await expect(table.getByText("Alpha", { exact: true })).toHaveCount(0);
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
  const table = p.getByRole("table");
  await expect(
    table.getByRole("columnheader", { name: t("catalog.list.col.availability") }),
  ).toBeVisible();
  await expect(table.getByText("12.00 EGP")).toBeVisible();
  await expect(table.getByText(t("catalog.availability.override"))).toBeVisible();
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

test("S5: narrow widths drop the metadata columns first", async ({ page: p, t }) => {
  await mockBase(p, "owner");
  await mockList(p, [{ items: [product()], nextCursor: null }]);
  await p.setViewportSize({ width: 1400, height: 900 });
  await p.goto("/catalog/products");
  const header = (key: Parameters<typeof t>[0]) =>
    p.getByRole("columnheader", { name: t(key), exact: true });
  await expect(header("catalog.list.col.updatedAt")).toBeVisible();
  await expect(header("catalog.list.col.taxCategory")).toBeVisible();
  await p.setViewportSize({ width: 1000, height: 900 });
  await expect(header("catalog.list.col.updatedAt")).toBeHidden();
  await expect(header("catalog.list.col.taxCategory")).toBeHidden();
  await expect(header("catalog.list.col.item")).toBeVisible();
  await expect(header("catalog.list.col.price")).toBeVisible();
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
    await expect(p.getByRole("table")).toBeVisible();

    // Filter form (4 fields, Search, Clear), the table scroll region (RT-826), both rows, then Load more.
    await p.getByLabel(t("catalog.filter.q")).focus();
    const stops: { label: string; outlineStyle: string; outlineWidth: number }[] = [];
    for (let i = 0; i < 10; i++) {
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
    // The walk really reached the rows and Load more, not only the form.
    expect(stops.some((s) => s.label.includes("Loose tea"))).toBe(true);
    expect(stops.at(-1)?.label).toContain(t("catalog.list.loadMore"));
  });
}

/**
 * RT-1236: the list anchors numbers and flexes identity (UX-10). A cell that
 * holds a number, a code or a date never breaks across lines; when the columns do
 * not fit, the item name takes the squeeze and metadata drops first (S5). Rows are
 * measured from the rendered text, so a wrapped cell cannot pass by being short:
 * a cell is wrapped when its text spans more than one line box. The Item cell is
 * left out of that count: a name wraps to two lines by design.
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

/** Per visible body cell: its column header and whether its text spans one line box. */
async function measureCells(p: Page, itemHeader: string) {
  return p.evaluate((itemHeader) => {
    const heads = [...document.querySelectorAll(".catalog-table th")].map((th) => ({
      th: th as HTMLElement,
      text: th.textContent?.trim() ?? "",
    }));
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
    const rows = [...document.querySelectorAll(".catalog-table tbody tr")];
    const region = document.querySelector(".data-table__scroll") as HTMLElement | null;
    const panel = document.querySelector(".catalog-results") as HTMLElement | null;
    const page = document.documentElement;
    return {
      headers: heads.filter((h) => h.th.offsetParent !== null).map((h) => h.text),
      rowHeights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
      wrapped: rows.flatMap((r) =>
        [...r.children]
          .map((td, i) => ({ td: td as HTMLElement, head: heads[i]?.text ?? "" }))
          .filter(
            ({ td, head }) => head !== itemHeader && td.offsetParent !== null && lines(td) > 1,
          )
          .map(({ head }) => head),
      ),
      regionScrolls: region ? region.scrollWidth > region.clientWidth + 1 : false,
      regionInsidePanel:
        region && panel
          ? region.getBoundingClientRect().right <= panel.getBoundingClientRect().right + 1 &&
            region.getBoundingClientRect().left >= panel.getBoundingClientRect().left - 1
          : false,
      itemWidth: Math.round(rows[0]?.firstElementChild?.getBoundingClientRect().width ?? 0),
      pageScrolls: page.scrollWidth > page.clientWidth,
    };
  }, itemHeader);
}

const MUST_SURVIVE = [
  "catalog.list.col.item",
  "catalog.list.col.status",
  "catalog.list.col.price",
] as const;

/** The item name keeps room to read: a few words, not a sliver (S7 and S7b). */
const MIN_ITEM_WIDTH = 120;

for (const width of [1440, 1280, 1200]) {
  test(`S7: with a store in scope, SKU and price stay on one line at ${width}`, async ({
    page: p,
    t,
  }) => {
    await mockBase(p, "store_manager", { id: CAIRO, name: "Cairo Festival" });
    await mockList(p, [{ items: TEN_ROWS, nextCursor: null }]);
    await p.setViewportSize({ width, height: 900 });
    await p.goto("/catalog/products");
    await expect(p.getByRole("table").getByText("Item number 2")).toBeVisible();

    const m = await measureCells(p, t("catalog.list.col.item"));
    expect(m.wrapped).toEqual([]);
    expect(m.regionScrolls, "the results panel does not scroll sideways").toBe(false);
    expect(m.itemWidth).toBeGreaterThanOrEqual(MIN_ITEM_WIDTH);
    // Single-line rows from 1280. At 1200 the availability chips may stack (two
    // chips, 89px: CI's fonts are wider than the laptop's); they flex-wrap by design
    // and are not the cells this test guards, so only a sane height is asserted.
    expect(Math.max(...m.rowHeights)).toBeLessThanOrEqual(width >= 1280 ? 60 : 100);
    for (const key of [...MUST_SURVIVE, "catalog.list.col.sku"] as const) {
      expect(m.headers).toContain(t(key));
    }
    // Metadata goes first, in the existing order: tax category and tracking at
    // 1600px and below, updated-at last (1380px and below). So updated-at is a
    // measured single-line cell at 1440 only; at 1280 and 1200 it is dropped.
    expect(m.headers.includes(t("catalog.list.col.updatedAt"))).toBe(width === 1440);
    expect(m.headers).not.toContain(t("catalog.list.col.taxCategory"));
    expect(m.headers).not.toContain(t("catalog.list.col.tracking"));
  });
}

// The drop boundaries themselves: tax category and tracking go at 1600px and
// below, updated-at at 1380px and below.
for (const [width, taxAndTracking, updatedAt] of [
  [1601, true, true],
  [1600, false, true],
  [1381, false, true],
  [1380, false, false],
] as const) {
  test(`S7a: with a store in scope, metadata drops at the ${width}px boundary`, async ({
    page: p,
    t,
  }) => {
    await mockBase(p, "store_manager", { id: CAIRO, name: "Cairo Festival" });
    await mockList(p, [{ items: TEN_ROWS, nextCursor: null }]);
    await p.setViewportSize({ width, height: 900 });
    await p.goto("/catalog/products");
    await expect(p.getByRole("table").getByText("Item number 2")).toBeVisible();

    const m = await measureCells(p, t("catalog.list.col.item"));
    expect(m.headers.includes(t("catalog.list.col.taxCategory"))).toBe(taxAndTracking);
    expect(m.headers.includes(t("catalog.list.col.tracking"))).toBe(taxAndTracking);
    expect(m.headers.includes(t("catalog.list.col.updatedAt"))).toBe(updatedAt);
    expect(m.wrapped).toEqual([]);
  });
}

for (const width of [1440, 1280, 1200, 1101, 1024]) {
  test(`S7b: tenant scope at ${width} keeps single-line rows and a readable item name`, async ({
    page: p,
    t,
  }) => {
    await mockBase(p, "owner");
    await mockList(p, [
      { items: TEN_ROWS.map((r) => ({ ...r, storeView: undefined })), nextCursor: null },
    ]);
    await p.setViewportSize({ width, height: 900 });
    await p.goto("/catalog/products");
    await expect(p.getByRole("table").getByText("Item number 2")).toBeVisible();

    const m = await measureCells(p, t("catalog.list.col.item"));
    expect(m.wrapped).toEqual([]);
    expect(m.regionScrolls, "the results panel does not scroll sideways").toBe(false);
    expect(m.itemWidth).toBeGreaterThanOrEqual(MIN_ITEM_WIDTH);
    expect(Math.max(...m.rowHeights)).toBeLessThanOrEqual(60);
    for (const key of MUST_SURVIVE) expect(m.headers).toContain(t(key));
    // All three metadata columns at 1440, none at 1380px and below.
    expect(m.headers.includes(t("catalog.list.col.updatedAt"))).toBe(width === 1440);
  });
}

test("S7d: a very long SKU cannot squeeze the item name below its floor at 1101", async ({
  page: p,
  t,
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
  await expect(p.getByRole("table").getByText("Item number 2")).toBeVisible();

  const m = await measureCells(p, t("catalog.list.col.item"));
  expect(m.itemWidth).toBeGreaterThanOrEqual(MIN_ITEM_WIDTH);
  // The table is wider than its panel, so the panel's scroll region takes it.
  expect(m.regionScrolls).toBe(true);
  expect(m.regionInsidePanel).toBe(true);
  expect(m.pageScrolls).toBe(false);
});

test("S7c: a store in scope at 1024 keeps item, status and price and never clips the panel", async ({
  page: p,
  t,
}) => {
  await mockBase(p, "store_manager", { id: CAIRO, name: "Cairo Festival" });
  await mockList(p, [{ items: TEN_ROWS, nextCursor: null }]);
  await p.setViewportSize({ width: 1024, height: 900 });
  await p.goto("/catalog/products");
  await expect(p.getByRole("table").getByText("Item number 2")).toBeVisible();

  const m = await measureCells(p, t("catalog.list.col.item"));
  for (const key of MUST_SURVIVE) expect(m.headers).toContain(t(key));
  // The scroll region may scroll (RT-826) but stays inside its panel, and the page does not.
  expect(m.regionInsidePanel).toBe(true);
  expect(m.pageScrolls).toBe(false);
});
