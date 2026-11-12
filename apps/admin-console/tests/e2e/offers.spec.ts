import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1338 (RT-286 S6) offers E2E against mocked Backend-Core (C-5), both locales.
 *
 * J1 (acceptance 1): create a brand → assign it to a product → create an offer that includes the
 *    brand and EXCLUDES a product → save the draft → preview (the server's eligible count) → publish
 *    → pause with a required reason → end. A stateful mock plays Backend-Core; the Console computes
 *    nothing, so every number on screen is one the mock returned.
 * J2 (acceptance 2): a store_manager reads the offer and can only pause, in their own store.
 *
 * Set OFFERS_EVIDENCE to a folder to also write the editor and preview screenshots there.
 */
const STORE_A = "0190f000-0000-7000-8000-00000000b001";
const STORE_B = "0190f000-0000-7000-8000-00000000b002";
const OFFER_ID = "0190f000-0000-7000-8000-00000000a001";
const PRODUCT = "0190f000-0000-7000-8000-0000000007b1";
const CATEGORY = "0190f000-0000-7000-8000-0000000007c1";
const BRAND_NEW = "0190f000-0000-7000-8000-0000000007d1";
const NOW = "2026-11-12T10:00:00Z";

function ctx(role: string, membership: Record<string, unknown> = {}) {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: null,
    active_role_code: role,
    memberships: [
      { tenant_id: "t1", tenant_name: "Northstar Retail", role_code: role, ...membership },
    ],
  };
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

function productDetail(brand: { id: string; name: string } | null, updatedAt: string) {
  return {
    summary: {
      productId: PRODUCT,
      name: "Mineral water 1.5L",
      status: "active",
      categoryId: CATEGORY,
      categoryName: "Beverages",
      brandId: brand?.id ?? null,
      brandName: brand?.name ?? null,
      primarySku: "SKU-0042",
      primaryBarcode: "0012345678905",
      defaultPrice: { amount: "10.5000", currencyCode: "EGP" },
      taxCategory: "standard",
      trackingMode: "none",
      updatedAt,
    },
    description: null,
    expiryRequired: false,
    sourceGlobalProductId: null,
    createdAt: "2026-09-01T08:00:00Z",
    identifiers: [],
    storeOverrides: [],
  };
}

interface Backend {
  brands: { brandId: string; name: string; updatedAt: string }[];
  product: ReturnType<typeof productDetail>;
  offer: Record<string, unknown> | null;
  definition: Record<string, unknown> | null;
  calls: { method: string; path: string; body: unknown; key?: string }[];
}

function offerOf(b: Backend, state: string, extra: Record<string, unknown> = {}) {
  const published = ["scheduled", "active", "paused", "ended"].includes(state);
  return {
    offerId: OFFER_ID,
    state,
    draft: published
      ? null
      : {
          draftRevision: 1,
          definition: b.definition,
          updatedAt: NOW,
          updatedByUserId: "u1",
        },
    currentVersion: published
      ? {
          version: 1,
          definition: b.definition,
          publishedAt: NOW,
          publishedByUserId: "u1",
          eligibleSetCount: 12,
        }
      : null,
    pause: null,
    pausedStores: [],
    createdAt: NOW,
    updatedAt: NOW,
    endedAt: state === "ended" ? NOW : null,
    archivedAt: null,
    rematerialisationConflicts: [],
    ...extra,
  };
}

/** One row of the offers list, as Backend-Core summarises the saved offer. */
function listBody(b: Backend) {
  if (!b.offer || !b.definition) return { items: [], nextCursor: null };
  const d = b.definition as { nameAr: string; schedule: unknown; storeScope: unknown };
  return {
    items: [
      {
        offerId: OFFER_ID,
        state: b.offer.state,
        nameAr: d.nameAr,
        nameEn: null,
        currentVersion: b.offer.currentVersion ? 1 : null,
        hasDraft: b.offer.draft !== null,
        schedule: d.schedule,
        storeScope: d.storeScope,
        updatedAt: NOW,
        rematerialisationConflictCount: 0,
      },
    ],
    nextCursor: null,
  };
}

const PREVIEW = {
  offerId: OFFER_ID,
  draftRevision: 1,
  publishable: true,
  issues: [],
  eligibleSet: { count: 12, sample: [{ productId: "p9", sku: "SKU-9", name: "Cola 330ml" }] },
  conflicts: [],
  simulation: null,
};

/** The lifecycle writes: the state the mock moves the offer to. */
const MOVES: Record<string, string> = { publish: "active", pause: "paused", end: "ended" };

/** Plays Backend-Core's offers surface over the stateful mock. */
function answerOffers(
  b: Backend,
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
) {
  if (method === "POST" && path === "/api/v1/offers") {
    b.definition = (body as { definition: Record<string, unknown> }).definition;
    b.offer = offerOf(b, "draft");
    return json(b.offer, 201);
  }
  if (method === "GET" && path === "/api/v1/offers") return json(listBody(b));
  if (path.endsWith("/versions")) return json({ items: [], nextCursor: null });
  if (path.endsWith("/preview")) return json(PREVIEW);
  const move = MOVES[path.split("/").pop() ?? ""];
  if (move) {
    const reason = (body as { reason?: string } | undefined)?.reason;
    b.offer = offerOf(
      b,
      move,
      move === "paused" ? { pause: { pausedAt: NOW, pausedByUserId: "u1", reason } } : {},
    );
    return json(b.offer);
  }
  if (method === "GET" && b.offer) return json(b.offer);
  return json({ error: { code: "offer_not_found", message: "m" } }, 404);
}

async function mockBackend(page: Page, role = "owner", membership = {}): Promise<Backend> {
  const b: Backend = {
    brands: [],
    product: productDetail(null, "2026-11-01T08:00:00Z"),
    offer: null,
    definition: null,
    calls: [],
  };
  const record = (r: import("@playwright/test").Route) => {
    const req = r.request();
    let body: unknown;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    b.calls.push({
      method: req.method(),
      path: new URL(req.url()).pathname,
      body,
      key: req.headers()["idempotency-key"],
    });
    return body as Record<string, unknown> | undefined;
  };

  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(role, membership))));
  await page.route("**/api/v1/stores", (r) =>
    r.fulfill(
      json([
        { id: STORE_A, code: "MAA", name: "Maadi" },
        { id: STORE_B, code: "ZAM", name: "Zamalek" },
      ]),
    ),
  );
  await page.route("**/api/v1/catalog/categories", (r) =>
    r.fulfill(
      json({
        items: [{ categoryId: CATEGORY, name: "Beverages", description: null, updatedAt: NOW }],
      }),
    ),
  );
  await page.route("**/api/v1/catalog/brands**", (r) => {
    if (r.request().method() === "POST") {
      const body = record(r) as { name: string };
      const brand = { brandId: BRAND_NEW, name: body.name, updatedAt: NOW };
      b.brands = [brand];
      return r.fulfill(json(brand, 201));
    }
    return r.fulfill(json({ items: b.brands }));
  });
  await page.route("**/api/v1/catalog/products**", (r) => {
    const url = new URL(r.request().url());
    if (r.request().method() === "PATCH") {
      const body = record(r) as { brandId?: string | null };
      const brand = b.brands.find((x) => x.brandId === body.brandId);
      b.product = productDetail(
        brand ? { id: brand.brandId, name: brand.name } : null,
        "2026-11-12T09:00:00Z",
      );
      return r.fulfill(json(b.product));
    }
    if (url.pathname.endsWith(`/${PRODUCT}`)) return r.fulfill(json(b.product));
    return r.fulfill(json({ items: [b.product.summary], nextCursor: null }));
  });
  await page.route("**/api/v1/offers**", (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const body = (method === "GET" ? undefined : record(r)) as Record<string, unknown> | undefined;
    return r.fulfill(answerOffers(b, method, path, body));
  });
  return b;
}

async function evidence(page: Page, name: string, appLocale: string): Promise<void> {
  const dir = process.env.OFFERS_EVIDENCE;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${appLocale}.png`, fullPage: true });
}

test("J1: brand → product → offer with an exclusion → preview → publish → pause → end", async ({
  page,
  t,
  appLocale,
}) => {
  const b = await mockBackend(page);

  // 1. Create a brand.
  await page.goto("/catalog/brands");
  await expect(
    page.getByRole("heading", { name: t("brands.list.title"), exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: t("brands.list.create") })
    .first()
    .click();
  const brandDrawer = page.getByRole("dialog");
  await brandDrawer.getByLabel(t("brands.form.name")).fill("Nike");
  await brandDrawer.getByRole("button", { name: t("brands.form.saveCreate") }).click();
  await expect(page.getByRole("cell", { name: "Nike", exact: true })).toBeVisible();
  const created = b.calls.find((c) => c.method === "POST" && c.path === "/api/v1/catalog/brands");
  expect(created?.body).toEqual({ name: "Nike" });
  expect(created?.key).toMatch(/^[\x21-\x7E]{16,128}$/);
  await expectNoAxeViolations(page, "brands list");

  // 2. Assign it to a product.
  await page.goto(`/catalog/products/${PRODUCT}/edit`);
  await page.getByLabel(t("catalog.form.brand")).selectOption({ label: "Nike" });
  await page.getByRole("button", { name: t("catalog.edit.save") }).click();
  await expect(page.getByText("Nike", { exact: true }).first()).toBeVisible();
  const patch = b.calls.find((c) => c.method === "PATCH");
  expect(patch?.body).toEqual({ expectedUpdatedAt: "2026-11-01T08:00:00Z", brandId: BRAND_NEW });

  // 3. Create an offer that includes the brand and excludes a product.
  await page.goto("/offers/new");
  await page.getByLabel(t("offers.form.nameAr")).fill("اشترِ واحصل");
  await page.getByLabel(t("offers.form.starts")).fill("2026-11-20T09:00");
  const include = page.getByRole("group", { name: t("offers.rules.include.title"), exact: true });
  await include.getByLabel("Nike").check();
  const exclude = page.getByRole("group", { name: t("offers.rules.exclude.title"), exact: true });
  await exclude.getByRole("button", { name: t("offers.rules.exclude.addProduct") }).click();
  await exclude.getByRole("option", { name: /Mineral water 1.5L/ }).click();
  await expect(exclude.getByText("Mineral water 1.5L").first()).toBeVisible();
  await evidence(page, "offer-editor", appLocale);
  await expectNoAxeViolations(page, "offer editor");

  await page.getByRole("button", { name: t("offers.save.action") }).click();
  await expect(page).toHaveURL(new RegExp(`/offers/${OFFER_ID}$`));
  const saved = b.calls.find((c) => c.method === "POST" && c.path === "/api/v1/offers");
  expect(saved?.key).toMatch(/^[\x21-\x7E]{16,128}$/);
  expect(
    (
      saved?.body as {
        definition: { eligibility: unknown; parameters: { rewardSelection: string } };
      }
    ).definition,
  ).toMatchObject({
    eligibility: { include: { brandIds: [BRAND_NEW] }, exclude: { productIds: [PRODUCT] } },
    parameters: { rewardSelection: "cheapest" },
  });

  // 4. Preview: the server's eligible count; Publish only after it.
  await expect(page.getByRole("button", { name: t("offers.publish.action") })).toBeDisabled();
  await page.getByRole("button", { name: t("offers.preview.run") }).click();
  await expect(page.getByText(t("offers.preview.eligibleCount", { count: 12 }))).toBeVisible();
  await expect(page.getByText("Cola 330ml")).toBeVisible();
  await evidence(page, "offer-preview", appLocale);
  await expectNoAxeViolations(page, "offer preview");
  await page.getByRole("button", { name: t("offers.publish.action") }).click();
  await expect(page.getByText(t("offers.publish.done"))).toBeVisible();
  const publish = b.calls.find((c) => c.path.endsWith("/publish"));
  expect(publish?.body).toEqual({ expectedDraftRevision: 1 });
  await expect(page.locator(".badge", { hasText: t("offers.state.active") }).first()).toBeVisible();

  // 5. Pause with a required reason.
  await page.getByRole("button", { name: t("offers.pause.open") }).click();
  const drawer = page.getByRole("dialog", { name: t("offers.pause.title") });
  await drawer.getByRole("button", { name: t("offers.pause.confirm") }).click();
  await expect(drawer.getByText(t("offers.pause.error.reasonRequired")).first()).toBeVisible();
  expect(b.calls.some((c) => c.path.endsWith("/pause"))).toBe(false);
  await drawer.getByLabel(t("offers.pause.reason")).fill("Wrong price");
  await drawer.getByRole("button", { name: t("offers.pause.confirm") }).click();
  await expect(page.getByText(t("offers.pause.done"))).toBeVisible();
  expect(b.calls.find((c) => c.path.endsWith("/pause"))?.body).toEqual({ reason: "Wrong price" });
  await expect(page.getByText("Wrong price").first()).toBeVisible();

  // 6. End it, after a confirm.
  await page.getByRole("button", { name: t("offers.end.open") }).click();
  await expect(page.getByText(t("offers.end.prompt"))).toBeVisible();
  await page.getByRole("button", { name: t("offers.end.confirm") }).click();
  await expect(page.getByText(t("offers.end.done"))).toBeVisible();
  expect(b.calls.some((c) => c.path.endsWith("/end"))).toBe(true);
  await expect(page.locator(".badge", { hasText: t("offers.state.ended") }).first()).toBeVisible();

  // The list shows it ended.
  await page.goto("/offers");
  await expect(
    page.getByRole("cell", { name: t("offers.state.ended"), exact: true }),
  ).toBeVisible();
});

test("J2: a store_manager reads the offer and can only pause, in their own store", async ({
  page,
  t,
}) => {
  const b = await mockBackend(page, "store_manager", {
    store_access_kind: "specific",
    accessible_store_ids: [STORE_A],
  });
  b.definition = {
    nameAr: "اشترِ واحصل",
    type: "buy_x_get_y_percent",
    parameters: {
      buyQuantity: 1,
      getQuantity: 1,
      percentOff: "40",
      rewardSelection: "cheapest",
      maxApplicationsPerSale: null,
      priceBasis: "resolved_store_price",
    },
    eligibility: { include: { categoryIds: [CATEGORY] } },
    storeScope: { allStores: true },
    schedule: { timeBasis: "store_local", startsAt: "2026-11-20T09:00", endsAt: null },
    offlinePolicy: "allow_cached",
  };
  b.offer = offerOf(b, "active");

  await page.goto("/offers");
  await expect(page.getByRole("button", { name: t("offers.list.create") })).toHaveCount(0);
  await page.goto(`/offers/${OFFER_ID}`);
  await expect(page.getByRole("button", { name: t("offers.pause.open") })).toBeVisible();
  for (const key of ["offers.publish.action", "offers.end.open", "offers.save.action"] as const) {
    await expect(page.getByRole("button", { name: t(key) })).toHaveCount(0);
  }

  await page.getByRole("button", { name: t("offers.pause.open") }).click();
  const drawer = page.getByRole("dialog", { name: t("offers.pause.title") });
  await expect(drawer.getByLabel("Maadi")).toBeVisible();
  await expect(drawer.getByLabel("Zamalek")).toHaveCount(0);
  await drawer.getByLabel(t("offers.pause.reason")).fill("Shelf label wrong");
  await drawer.getByLabel("Maadi").check();
  await drawer.getByRole("button", { name: t("offers.pause.confirm") }).click();
  await expect(page.getByText(t("offers.pause.done"))).toBeVisible();
  expect(b.calls.find((c) => c.path.endsWith("/pause"))?.body).toEqual({
    reason: "Shelf label wrong",
    storeIds: [STORE_A],
  });
});
