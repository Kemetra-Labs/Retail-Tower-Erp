import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1074 per-product stock-level editor E2E against mocked Backend-Core (C-5),
 * over `catalog/stock-levels.yaml` (RT-1064 TH-2 to TH-4).
 * L1: owner sets the tenant level: the drawer (axe light and dark), PUT with the
 *     exact strings, the precondition and an Idempotency-Key; the section shows
 *     the server's answer.
 * L2: critical above reorder is stopped on the field; the server's 422
 *     critical_above_reorder lands there too; axe.
 * L3: 409 stale_write reloads and says so; the typed change is kept, nothing is
 *     overwritten; axe.
 * L4: store_manager: no tenant control; sets the store level (null precondition),
 *     then removes it after a confirmation whose Cancel has focus; axe.
 * L5: a 404 on remove reads as already gone and the levels are read again.
 * RT-399: runs in both locales; copy comes from the catalog (`t`).
 */
const CAIRO = "0190f000-0000-7000-8000-0000000007a1";
const P1 = "0190f000-0000-7000-8000-0000000007b1";
const CATEGORY = "0190f000-0000-7000-8000-0000000007c1";
const SEEN_AT = "2026-11-01T09:00:00.000Z";
const LATER = "2026-11-02T10:00:00.000Z";
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

function detail() {
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
      updatedAt: "2026-10-07T10:30:00Z",
    },
    description: "Still spring water, 1.5 litre bottle.",
    expiryRequired: false,
    sourceGlobalProductId: null,
    createdAt: "2026-09-01T08:00:00Z",
    identifiers: [],
    storeOverrides: [],
  };
}

function levels(tenantLevel: unknown = null, storeLevels: unknown[] = []) {
  return { productId: P1, tenantLevel, storeLevels };
}

const tenantLevel = (over: Record<string, unknown> = {}) => ({
  reorderLevel: "12.5000",
  criticalLevel: "3",
  updatedAt: SEEN_AT,
  ...over,
});

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

const failure = (code: string, requestId = "r-l") => ({
  error: { code, message: "m", request_id: requestId },
});

interface Write {
  method: string;
  body: unknown;
  hasIntentHeader: boolean;
}

interface Recorded {
  tenantSets: Write[];
  tenantRetires: Write[];
  storeSets: Write[];
  storeRetires: Write[];
  gets: number;
}

type Answer = () => { status: number; body: unknown };

/** The product read, the stock-levels read and its four writes; every write is recorded. */
async function mock(
  p: Page,
  role: string,
  answers: {
    get: () => unknown;
    tenantSet?: Answer;
    tenantRetire?: Answer;
    storeSet?: Answer;
    storeRetire?: Answer;
  },
): Promise<Recorded> {
  const recorded: Recorded = {
    tenantSets: [],
    tenantRetires: [],
    storeSets: [],
    storeRetires: [],
    gets: 0,
  };
  const write =
    (list: Write[], answer: Answer | undefined) =>
    (r: Parameters<Parameters<Page["route"]>[1]>[0]) => {
      const req = r.request();
      list.push({
        method: req.method(),
        body: req.postDataJSON(),
        hasIntentHeader: /^[\x21-\x7E]{16,128}$/.test(req.headers()["idempotency-key"] ?? ""),
      });
      const out = answer?.() ?? { status: 500, body: failure("internal") };
      return r.fulfill(json(out.body, out.status));
    };
  await p.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await p.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(role))));
  await p.route("**/api/v1/stores", (r) =>
    r.fulfill(json([{ id: CAIRO, code: "CAI", name: "Cairo Festival" }])),
  );
  await p.route(`**/api/v1/catalog/products/${P1}`, (r) => r.fulfill(json(detail())));
  await p.route(`**/api/v1/catalog/products/${P1}/stock-levels`, (r) => {
    if (r.request().method() === "PUT") {
      return write(recorded.tenantSets, answers.tenantSet)(r);
    }
    recorded.gets += 1;
    return r.fulfill(json(answers.get()));
  });
  await p.route(
    `**/api/v1/catalog/products/${P1}/stock-levels/retire`,
    write(recorded.tenantRetires, answers.tenantRetire),
  );
  await p.route(
    `**/api/v1/catalog/products/${P1}/stock-levels/stores/${CAIRO}`,
    write(recorded.storeSets, answers.storeSet),
  );
  await p.route(
    `**/api/v1/catalog/products/${P1}/stock-levels/stores/${CAIRO}/retire`,
    write(recorded.storeRetires, answers.storeRetire),
  );
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

test("L1: owner sets the tenant level with exact strings, the precondition and a key", async ({
  page: p,
  t,
}) => {
  let current = levels(tenantLevel());
  const recorded = await mock(p, "owner", {
    get: () => current,
    tenantSet: () => {
      current = levels(
        tenantLevel({ reorderLevel: "20.25", criticalLevel: null, updatedAt: LATER }),
      );
      return { status: 200, body: current };
    },
  });
  await openDetail(p);
  const section = p.getByRole("region", { name: t("catalog.stockLevels.title") });
  await expect(section).toContainText("12.5000");
  await checkAxe(p, "stock levels section");

  await section.getByRole("button", { name: t("catalog.stockLevels.action.changeTenant") }).click();
  const drawer = p.getByRole("dialog", { name: t("catalog.stockLevels.drawer.tenantTitle") });
  await expect(drawer).toBeVisible();
  const reorder = drawer.getByRole("textbox", { name: t("catalog.stockLevels.field.reorder") });
  const critical = drawer.getByRole("textbox", { name: t("catalog.stockLevels.field.critical") });
  await expect(reorder).toHaveValue("12.5000");
  await expect(reorder).toHaveAttribute("dir", "ltr");
  await checkAxe(p, "stock level drawer, light");
  await setTheme(p, "dark");
  await checkAxe(p, "stock level drawer, dark");
  await setTheme(p, "light");

  await reorder.fill(" 20.25 ");
  await critical.fill("");
  await drawer.getByRole("button", { name: t("catalog.stockLevels.save") }).click();

  await expect(p.getByText(t("catalog.stockLevels.tenantSaved"))).toBeVisible();
  await expect(drawer).toHaveCount(0);
  expect(recorded.tenantSets).toEqual([
    {
      method: "PUT",
      body: { expectedUpdatedAt: SEEN_AT, reorderLevel: "20.25", criticalLevel: null },
      hasIntentHeader: true,
    },
  ]);
  await expect(section).toContainText("20.25");
  await expect(section).toContainText(t("catalog.stockLevels.value.noCritical"));
  await checkAxe(p, "tenant level saved");
});

test("L2: critical above reorder is stopped on the field; the server's 422 lands there too", async ({
  page: p,
  t,
}) => {
  const recorded = await mock(p, "tenant_admin", {
    get: () => levels(tenantLevel()),
    tenantSet: () => ({ status: 422, body: failure("critical_above_reorder", "r-422") }),
  });
  await openDetail(p);
  await p.getByRole("button", { name: t("catalog.stockLevels.action.changeTenant") }).click();
  const drawer = p.getByRole("dialog");
  const critical = drawer.getByRole("textbox", { name: t("catalog.stockLevels.field.critical") });
  await critical.fill("12.5001");
  await drawer.getByRole("button", { name: t("catalog.stockLevels.save") }).click();
  await expect(drawer.getByText(t("catalog.stockLevels.error.criticalAboveReorder"))).toBeVisible();
  await expect(critical).toBeFocused();
  await expect(critical).toHaveAttribute("aria-invalid", "true");
  expect(recorded.tenantSets).toEqual([]);
  await checkAxe(p, "critical above reorder");

  // The server is still the judge: its 422 maps to the same field.
  await critical.fill("4");
  await drawer.getByRole("button", { name: t("catalog.stockLevels.save") }).click();
  await expect(drawer.getByText(t("catalog.stockLevels.error.criticalAboveReorder"))).toBeVisible();
  await expect(critical).toBeFocused();
  expect(recorded.tenantSets).toHaveLength(1);
});

test("L3: 409 stale_write reloads and says so; the typed change is kept, nothing overwritten", async ({
  page: p,
  t,
}) => {
  let current = levels(tenantLevel());
  const recorded = await mock(p, "owner", {
    get: () => current,
    tenantSet: () => {
      current = levels(tenantLevel({ reorderLevel: "30", criticalLevel: "9", updatedAt: LATER }));
      return { status: 409, body: failure("stale_write", "r-stale") };
    },
  });
  await openDetail(p);
  await p.getByRole("button", { name: t("catalog.stockLevels.action.changeTenant") }).click();
  const drawer = p.getByRole("dialog");
  const reorder = drawer.getByRole("textbox", { name: t("catalog.stockLevels.field.reorder") });
  const critical = drawer.getByRole("textbox", { name: t("catalog.stockLevels.field.critical") });
  await reorder.fill("15");
  await drawer.getByRole("button", { name: t("catalog.stockLevels.save") }).click();
  await expect(drawer.getByText(t("catalog.stockLevels.error.stale"))).toBeVisible();
  await expect(drawer.getByText("r-stale")).toBeVisible();
  await expect(reorder).toHaveValue("15");
  await expect(critical).toHaveValue("9");
  expect(recorded.tenantSets).toHaveLength(1);
  expect(recorded.gets).toBeGreaterThanOrEqual(2);
  await checkAxe(p, "stale write reloaded");
});

test("L4: store_manager sets the store level, then removes it after a confirmation", async ({
  page: p,
  t,
}) => {
  const storeLevel = { storeId: CAIRO, reorderLevel: "4", criticalLevel: "1.5", updatedAt: LATER };
  let current = levels(null, []);
  const recorded = await mock(p, "store_manager", {
    get: () => current,
    storeSet: () => {
      current = levels(null, [storeLevel]);
      return { status: 200, body: current };
    },
    storeRetire: () => {
      current = levels(null, []);
      return { status: 200, body: current };
    },
  });
  await openDetail(p);
  const section = p.getByRole("region", { name: t("catalog.stockLevels.title") });
  await expect(section.getByText(t("catalog.stockLevels.tenant.none"))).toBeVisible();
  await expect(
    section.getByRole("button", { name: t("catalog.stockLevels.action.setTenant") }),
  ).toHaveCount(0);

  await section
    .getByRole("button", {
      name: t("catalog.stockLevels.action.setStore", { store: "Cairo Festival" }),
    })
    .click();
  const drawer = p.getByRole("dialog", {
    name: t("catalog.stockLevels.drawer.storeTitle", { store: "Cairo Festival" }),
  });
  await drawer.getByRole("textbox", { name: t("catalog.stockLevels.field.reorder") }).fill("4");
  await drawer.getByRole("textbox", { name: t("catalog.stockLevels.field.critical") }).fill("1.5");
  await drawer.getByRole("button", { name: t("catalog.stockLevels.save") }).click();
  await expect(
    p.getByText(t("catalog.stockLevels.storeSaved", { store: "Cairo Festival" })),
  ).toBeVisible();
  expect(recorded.storeSets).toEqual([
    {
      method: "PUT",
      body: { expectedUpdatedAt: null, reorderLevel: "4", criticalLevel: "1.5" },
      hasIntentHeader: true,
    },
  ]);
  await expect(section).toContainText("1.5");

  await section
    .getByRole("button", {
      name: t("catalog.stockLevels.action.changeStore", { store: "Cairo Festival" }),
    })
    .click();
  await drawer.getByRole("button", { name: t("catalog.stockLevels.retire.start") }).click();
  const confirm = drawer.getByRole("region", {
    name: t("catalog.stockLevels.retire.confirmLabel"),
  });
  await expect(confirm.getByRole("button", { name: t("common.cancel") })).toBeFocused();
  await checkAxe(p, "remove confirmation");
  expect(recorded.storeRetires).toEqual([]);
  await confirm.getByRole("button", { name: t("catalog.stockLevels.retire.confirm") }).click();
  await expect(
    p.getByText(t("catalog.stockLevels.storeRemoved", { store: "Cairo Festival" })),
  ).toBeVisible();
  expect(recorded.storeRetires).toEqual([
    { method: "POST", body: { expectedUpdatedAt: LATER }, hasIntentHeader: false },
  ]);
  await expect(section.getByText(t("catalog.stockLevels.stores.empty"))).toBeVisible();
});

test("L5: a 404 on remove reads as already gone; the levels are read again", async ({
  page: p,
  t,
}) => {
  let current = levels(tenantLevel());
  const recorded = await mock(p, "owner", {
    get: () => current,
    tenantRetire: () => {
      current = levels(null, []);
      return { status: 404, body: failure("not_found") };
    },
  });
  await openDetail(p);
  await p.getByRole("button", { name: t("catalog.stockLevels.action.changeTenant") }).click();
  const drawer = p.getByRole("dialog");
  await drawer.getByRole("button", { name: t("catalog.stockLevels.retire.start") }).click();
  await drawer.getByRole("button", { name: t("catalog.stockLevels.retire.confirm") }).click();
  await expect(p.getByText(t("catalog.stockLevels.gone"))).toBeVisible();
  await expect(p.getByText(t("catalog.stockLevels.tenant.none"))).toBeVisible();
  expect(recorded.tenantRetires).toHaveLength(1);
  await checkAxe(p, "already gone");
});
