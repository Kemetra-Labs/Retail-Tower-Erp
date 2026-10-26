import type { Locator } from "@playwright/test";
import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-770 store overrides upsert / retire E2E against mocked Backend-Core (C-5), CAT-C2c.
 * O1: owner sets a new deviation for the store in scope: the drawer (axe light and dark),
 *     PUT with expectedUpdatedAt null, isActive false and the tax trimmed; the raw
 *     deviation section shows the server's answer.
 * O2: 422 override_empty explains and offers Remove; Remove asks first (Cancel focused),
 *     then POSTs the retire with the override's updatedAt.
 * O3: 409 price_override_present on Remove: the store price is kept; axe.
 * O4: 409 stale_write keeps what was chosen; Reload re-reads; axe.
 * O5: store_manager: availability only, no Remove on a deviation with a tax category,
 *     and the PUT carries no taxCategory key; axe.
 * O6: Escape closes the drawer and returns focus to its opener; nothing is written.
 * RT-399: runs in both locales; copy comes from the catalog (`t`).
 */
const CAIRO = "0190f000-0000-7000-8000-0000000007a1";
const P1 = "0190f000-0000-7000-8000-0000000007b1";
const CATEGORY = "0190f000-0000-7000-8000-0000000007c1";
const LOADED_AT = "2026-10-07T10:30:00Z";
const SEEN_AT = "2026-10-05T09:00:00Z";
const LATER = "2026-10-09T11:00:00Z";
const STORE = { id: CAIRO, name: "Cairo Festival" };

function ctx(role: string) {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: STORE,
    active_role_code: role,
    memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: role }],
  };
}

function override(over: Record<string, unknown> = {}) {
  return {
    storeId: CAIRO,
    price: null,
    isActive: false,
    taxCategory: null,
    updatedAt: SEEN_AT,
    ...over,
  };
}

function detail(storeOverrides: unknown[] = []) {
  return {
    summary: {
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
      updatedAt: LOADED_AT,
    },
    description: "Still spring water, 1.5 litre bottle.",
    expiryRequired: false,
    sourceGlobalProductId: null,
    createdAt: "2026-09-01T08:00:00Z",
    identifiers: [],
    storeOverrides,
  };
}

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

const failure = (code: string, requestId = "r-o") => ({
  error: { code, message: "m", request_id: requestId },
});

interface Recorded {
  puts: unknown[];
  retires: unknown[];
  gets: number;
}

/** The product read, the override upsert and its retire; every write is recorded. */
async function mock(
  p: Page,
  role: string,
  answers: {
    get?: () => unknown;
    put?: () => { status: number; body: unknown };
    retire?: () => { status: number; body: unknown };
  },
): Promise<Recorded> {
  const recorded: Recorded = { puts: [], retires: [], gets: 0 };
  await p.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await p.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(role))));
  await p.route("**/api/v1/stores", (r) =>
    r.fulfill(json([{ id: CAIRO, code: "CAI", name: "Cairo Festival" }])),
  );
  await p.route(`**/api/v1/catalog/products/${P1}`, (r) => {
    recorded.gets += 1;
    return r.fulfill(json(answers.get?.() ?? detail()));
  });
  await p.route(`**/api/v1/catalog/products/${P1}/store-overrides/${CAIRO}`, (r) => {
    recorded.puts.push({ method: r.request().method(), body: r.request().postDataJSON() });
    const out = answers.put?.() ?? { status: 200, body: detail([override()]) };
    return r.fulfill(json(out.body, out.status));
  });
  await p.route(`**/api/v1/catalog/products/${P1}/store-overrides/${CAIRO}/retire`, (r) => {
    recorded.retires.push({ method: r.request().method(), body: r.request().postDataJSON() });
    const out = answers.retire?.() ?? { status: 200, body: detail() };
    return r.fulfill(json(out.body, out.status));
  });
  return recorded;
}

/** Banners and errors settle in over 150ms (opacity): axe must not measure a half-faded colour. */
async function checkAxe(p: Page, label: string): Promise<void> {
  await p.waitForFunction(() => document.getAnimations().length === 0);
  await expectNoAxeViolations(p, label);
}

async function setTheme(p: Page, theme: "dark" | "light"): Promise<void> {
  await p.evaluate(
    (value) =>
      value === "dark"
        ? document.documentElement.setAttribute("data-theme", "dark")
        : document.documentElement.removeAttribute("data-theme"),
    theme,
  );
  await p.waitForFunction(() => document.getAnimations().length === 0);
}

async function openDetail(p: Page): Promise<void> {
  await p.goto(`/catalog/products/${P1}`);
  await expect(p.getByRole("heading", { level: 1, name: "Mineral water 1.5L" })).toBeVisible();
}

test("O1: owner sets a new deviation for the store in scope; the section shows the server's answer", async ({
  page: p,
  t,
}) => {
  let current = detail();
  const recorded = await mock(p, "owner", {
    get: () => current,
    put: () => {
      current = detail([override({ isActive: false, taxCategory: "zero", updatedAt: LATER })]);
      return { status: 200, body: current };
    },
  });
  await openDetail(p);
  await p
    .getByRole("button", { name: t("catalog.override.add", { store: "Cairo Festival" }) })
    .click();
  const drawer = p.getByRole("dialog", {
    name: t("catalog.override.drawer.title", { store: "Cairo Festival" }),
  });
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("radio", { name: t("catalog.override.availability.inherit"), exact: true }),
  ).toBeChecked();
  const tax = drawer.getByRole("textbox", { name: t("catalog.override.taxCategory") });
  await expect(tax).toHaveValue("");
  await expect(tax).toHaveAttribute("dir", "ltr");
  await checkAxe(p, "override drawer, light");
  await setTheme(p, "dark");
  await checkAxe(p, "override drawer, dark");
  await setTheme(p, "light");

  await drawer
    .getByRole("radio", { name: t("catalog.override.availability.unavailable"), exact: true })
    .check();
  await tax.fill("  zero ");
  await drawer.getByRole("button", { name: t("catalog.override.save") }).click();

  await expect(p.getByText(t("catalog.override.saved", { store: "Cairo Festival" }))).toBeVisible();
  await expect(drawer).toHaveCount(0);
  expect(recorded.puts).toEqual([
    { method: "PUT", body: { expectedUpdatedAt: null, isActive: false, taxCategory: "zero" } },
  ]);
  const section = p.getByRole("region", { name: t("catalog.detail.overrides.title") });
  await expect(section).toContainText("zero");
  await expect(section).toContainText(t("catalog.availability.no"));
  await checkAxe(p, "override saved");
});

test("O2: 422 override_empty explains and offers Remove; Remove asks first, then retires", async ({
  page: p,
  t,
}) => {
  let current = detail([override()]);
  const recorded = await mock(p, "tenant_admin", {
    get: () => current,
    put: () => ({ status: 422, body: failure("override_empty", "r-empty") }),
    retire: () => {
      current = detail();
      return { status: 200, body: current };
    },
  });
  await openDetail(p);
  await p
    .getByRole("button", { name: t("catalog.override.change", { store: "Cairo Festival" }) })
    .click();
  const drawer = p.getByRole("dialog");
  await drawer
    .getByRole("radio", { name: t("catalog.override.availability.inherit"), exact: true })
    .check();
  await drawer.getByRole("button", { name: t("catalog.override.save") }).click();

  await expect(drawer.getByText(t("catalog.override.error.empty"))).toBeVisible();
  await expect(drawer.getByText("r-empty")).toBeVisible();
  expect(recorded.puts).toEqual([
    { method: "PUT", body: { expectedUpdatedAt: SEEN_AT, isActive: null } },
  ]);
  await checkAxe(p, "override_empty banner");

  await drawer
    .getByRole("button", { name: t("catalog.override.error.emptyAction"), exact: true })
    .click();
  const confirm = drawer.getByRole("region", { name: t("catalog.override.retire.confirmLabel") });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: t("common.cancel") })).toBeFocused();
  await checkAxe(p, "remove confirmation");
  expect(recorded.retires).toEqual([]);

  await confirm.getByRole("button", { name: t("catalog.override.retire.confirm") }).click();
  await expect(
    p.getByText(t("catalog.override.removed", { store: "Cairo Festival" })),
  ).toBeVisible();
  expect(recorded.retires).toEqual([{ method: "POST", body: { expectedUpdatedAt: SEEN_AT } }]);
  await expect(p.getByText(t("catalog.detail.overrides.empty"))).toBeVisible();
});

test("O3: 409 price_override_present on Remove: the store price is kept, the drawer stays", async ({
  page: p,
  t,
}) => {
  const recorded = await mock(p, "owner", {
    get: () => detail([override({ price: { amount: "12.0000", currencyCode: "EGP" } })]),
    retire: () => ({ status: 409, body: failure("price_override_present", "r-price") }),
  });
  await openDetail(p);
  await p
    .getByRole("button", { name: t("catalog.override.change", { store: "Cairo Festival" }) })
    .click();
  const drawer = p.getByRole("dialog");
  await expect(drawer.getByText(t("catalog.override.priceKept"))).toBeVisible();
  await drawer
    .getByRole("button", { name: t("catalog.override.retire.start"), exact: true })
    .click();
  await drawer.getByRole("button", { name: t("catalog.override.retire.confirm") }).click();
  await expect(drawer.getByText(t("catalog.override.error.pricePresent"))).toBeVisible();
  await expect(drawer.getByText("r-price")).toBeVisible();
  expect(recorded.retires).toHaveLength(1);
  await checkAxe(p, "price_override_present banner");
});

test("O4: 409 stale_write keeps what was chosen; Reload re-reads", async ({ page: p, t }) => {
  let current = detail([override()]);
  const recorded = await mock(p, "owner", {
    get: () => current,
    put: () => ({ status: 409, body: failure("stale_write", "r-stale") }),
  });
  await openDetail(p);
  await p
    .getByRole("button", { name: t("catalog.override.change", { store: "Cairo Festival" }) })
    .click();
  const drawer = p.getByRole("dialog");
  await drawer
    .getByRole("radio", { name: t("catalog.override.availability.available"), exact: true })
    .check();
  const tax = drawer.getByRole("textbox", { name: t("catalog.override.taxCategory") });
  await tax.fill("mine");
  await drawer.getByRole("button", { name: t("catalog.override.save") }).click();

  await expect(drawer.getByText(t("catalog.override.error.stale"))).toBeVisible();
  await expect(drawer.getByText("r-stale")).toBeVisible();
  await expect(
    drawer.getByRole("radio", { name: t("catalog.override.availability.available"), exact: true }),
  ).toBeChecked();
  await expect(tax).toHaveValue("mine");
  await checkAxe(p, "override stale banner");

  current = detail([override({ taxCategory: "theirs", updatedAt: LATER })]);
  await drawer.getByRole("button", { name: t("catalog.edit.reload") }).click();
  await expect(drawer.getByText(t("catalog.override.reloaded"))).toBeVisible();
  await expect(tax).toHaveValue("mine");
  expect(recorded.gets).toBeGreaterThanOrEqual(2);
});

test("O5: store_manager sets availability only; no Remove on a deviation with a tax category", async ({
  page: p,
  t,
}) => {
  const recorded = await mock(p, "store_manager", {
    get: () => detail([override({ taxCategory: "zero" })]),
    put: () => ({ status: 200, body: detail([override({ isActive: true, taxCategory: "zero" })]) }),
  });
  await openDetail(p);
  await expect(p.getByRole("link", { name: t("catalog.detail.edit") })).toHaveCount(0);
  await p
    .getByRole("button", { name: t("catalog.override.change", { store: "Cairo Festival" }) })
    .click();
  const drawer = p.getByRole("dialog");
  await expect(drawer.getByRole("radio")).toHaveCount(3);
  await expect(drawer.getByRole("textbox")).toHaveCount(0);
  await expect(
    drawer.getByRole("button", { name: t("catalog.override.retire.start"), exact: true }),
  ).toHaveCount(0);
  await checkAxe(p, "override drawer, store_manager");

  await drawer
    .getByRole("radio", { name: t("catalog.override.availability.available"), exact: true })
    .check();
  await drawer.getByRole("button", { name: t("catalog.override.save") }).click();
  await expect(p.getByText(t("catalog.override.saved", { store: "Cairo Festival" }))).toBeVisible();
  expect(recorded.puts).toEqual([
    { method: "PUT", body: { expectedUpdatedAt: SEEN_AT, isActive: true } },
  ]);
});

test("O6: Escape closes the drawer and returns focus to its opener; nothing is written", async ({
  page: p,
  t,
}) => {
  const recorded = await mock(p, "owner", { get: () => detail([override()]) });
  await openDetail(p);
  const opener: Locator = p.getByRole("button", {
    name: t("catalog.override.change", { store: "Cairo Festival" }),
  });
  await opener.click();
  await expect(p.getByRole("dialog")).toBeVisible();
  await p.keyboard.press("Escape");
  await expect(p.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(recorded.puts).toEqual([]);
  expect(recorded.retires).toEqual([]);
});
