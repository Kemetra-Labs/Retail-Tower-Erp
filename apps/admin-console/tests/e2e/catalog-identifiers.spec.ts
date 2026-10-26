import type { Locator } from "@playwright/test";
import { expectNoAxeViolations } from "./axe";
import { type LocaleFixtures, type Page, expect, test } from "./fixtures";

/**
 * RT-769 identifiers add / retire E2E against mocked Backend-Core (C-5),
 * CAT-C2b. Runs in both locales (RT-399): copy comes from the catalog (`t`).
 * I1: add drawer: the value is LTR and sent byte for byte; the item's list shows
 *     the server's answer; axe on the drawer in light and dark.
 * I2: a blocked submit: the error is inline on the value and focused, no summary;
 *     the D6 Arabic-digit warning does not block; axe on both.
 * I3: 409 alias_conflict: an error on the value that names no other item; axe.
 * I4: external POS id: scope hidden, source system required.
 * I5: retire drawer names the identifier, sends its full key; axe light and dark.
 * I6: store_manager and a retired item: no identifier control.
 */
const CAIRO = "0190f000-0000-7000-8000-0000000007a1";
const P1 = "0190f000-0000-7000-8000-0000000007b1";
const CATEGORY = "0190f000-0000-7000-8000-0000000007c1";
const LOADED_AT = "2026-10-07T10:30:00Z";

function ctx(role: string) {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: null,
    active_role_code: role,
    memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: role }],
  };
}

function ident(over: Record<string, unknown> = {}) {
  return {
    identifierType: "barcode",
    value: "0012345678905",
    storeId: null,
    sourceSystem: null,
    createdAt: "2026-10-01T08:00:00Z",
    ...over,
  };
}

function detail(identifiers: unknown[] = [ident()], sum: Record<string, unknown> = {}) {
  return {
    summary: {
      productId: P1,
      name: "Mineral water 1.5L",
      status: "active",
      categoryId: CATEGORY,
      categoryName: "Beverages",
      primarySku: null,
      primaryBarcode: "0012345678905",
      defaultPrice: { amount: "10.5000", currencyCode: "EGP" },
      taxCategory: "standard",
      trackingMode: "none",
      updatedAt: LOADED_AT,
      ...sum,
    },
    description: null,
    expiryRequired: false,
    sourceGlobalProductId: null,
    createdAt: "2026-09-01T08:00:00Z",
    identifiers,
    storeOverrides: [],
  };
}

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

const failure = (code: string, requestId = "r-w") => ({
  error: { code, message: "m", request_id: requestId },
});

interface Recorded {
  adds: unknown[];
  retires: unknown[];
}

async function mock(
  p: Page,
  role: string,
  answers: {
    get?: () => unknown;
    add?: (body: { value: string }) => { status: number; body: unknown };
    retire?: () => { status: number; body: unknown };
  } = {},
): Promise<Recorded> {
  const recorded: Recorded = { adds: [], retires: [] };
  await p.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await p.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(role))));
  await p.route("**/api/v1/stores", (r) =>
    r.fulfill(json([{ id: CAIRO, code: "CAI", name: "Cairo Festival" }])),
  );
  await p.route(`**/api/v1/catalog/products/${P1}`, (r) =>
    r.fulfill(json(answers.get?.() ?? detail())),
  );
  await p.route(`**/api/v1/catalog/products/${P1}/identifiers`, (r) => {
    const body = r.request().postDataJSON();
    recorded.adds.push(body);
    const out = answers.add?.(body) ?? { status: 201, body: detail([ident(), ident(body)]) };
    return r.fulfill(json(out.body, out.status));
  });
  await p.route(`**/api/v1/catalog/products/${P1}/identifiers/retire`, (r) => {
    recorded.retires.push(r.request().postDataJSON());
    const out = answers.retire?.() ?? { status: 200, body: detail([]) };
    return r.fulfill(json(out.body, out.status));
  });
  return recorded;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const field = (scope: Page | Locator, label: string): Locator =>
  scope.getByLabel(new RegExp(`^\\s*${escapeRegExp(label)}`));

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

async function axeBothThemes(p: Page, label: string): Promise<void> {
  await p.waitForFunction(() => document.getAnimations().length === 0);
  await expectNoAxeViolations(p, `${label}, light`);
  await setTheme(p, "dark");
  await expectNoAxeViolations(p, `${label}, dark`);
  await setTheme(p, "light");
}

async function openAdd(p: Page, t: LocaleFixtures["t"]): Promise<Locator> {
  await p.goto(`/catalog/products/${P1}`);
  await expect(p.getByRole("heading", { level: 1, name: "Mineral water 1.5L" })).toBeVisible();
  await p.getByRole("button", { name: t("catalog.identifier.add.start") }).click();
  const drawer = p.getByRole("dialog", { name: t("catalog.identifier.add.title") });
  await expect(drawer).toBeVisible();
  return drawer;
}

test("I1: add sends the value byte for byte, and the item shows the server's answer", async ({
  page: p,
  t,
}) => {
  const recorded = await mock(p, "owner");
  const drawer = await openAdd(p, t);
  const value = field(drawer, t("catalog.identifier.field.value"));
  await expect(value).toHaveAttribute("dir", "ltr");
  await expect(value).toHaveAttribute("spellcheck", "false");
  await expect(field(drawer, t("catalog.identifier.field.scope"))).toBeVisible();
  await axeBothThemes(p, "identifier add drawer");

  // Leading zeros and inner spaces survive; the scanner's Enter submits (the value is last).
  await value.fill("00 622300 017");
  await value.press("Enter");
  await expect(drawer).toHaveCount(0);
  expect(recorded.adds).toEqual([
    { identifierType: "barcode", value: "00 622300 017", storeId: null, sourceSystem: null },
  ]);
  const section = p.getByRole("region", { name: t("catalog.detail.identifiers.title") });
  await expect(section.getByText("00 622300 017")).toBeVisible();
  await expect(section.getByText(t("catalog.identifier.added"))).toBeVisible();
  await expect(p.getByRole("button", { name: t("catalog.identifier.add.start") })).toBeFocused();
});

test("I2: a blocked submit is inline and focused (no summary); Arabic digits only warn", async ({
  page: p,
  t,
}) => {
  const recorded = await mock(p, "tenant_admin");
  const drawer = await openAdd(p, t);
  const value = field(drawer, t("catalog.identifier.field.value"));

  await value.fill("123 ");
  await drawer.getByRole("button", { name: t("catalog.identifier.add.submit") }).click();
  await expect(value).toBeFocused();
  await expect(value).toHaveAttribute("aria-invalid", "true");
  await expect(drawer.getByText(t("catalog.identifier.error.valueEdgeSpace"))).toBeVisible();
  await expect(value).toHaveValue("123 ");
  await expect(p.locator(".form-error-summary")).toHaveCount(0);
  expect(recorded.adds).toEqual([]);
  await axeBothThemes(p, "identifier add drawer, inline error");

  // D6: Arabic-Indic digits warn without blocking, and are sent unconverted.
  await value.fill("٦٢٢٣٠٠٠");
  await expect(value).not.toHaveAttribute("aria-invalid", "true");
  await expect(drawer.getByText(t("catalog.identifier.warning.arabicDigits"))).toBeVisible();
  await axeBothThemes(p, "identifier add drawer, Arabic-digit warning");
  await drawer.getByRole("button", { name: t("catalog.identifier.add.submit") }).click();
  await expect(drawer).toHaveCount(0);
  expect(recorded.adds).toEqual([
    { identifierType: "barcode", value: "٦٢٢٣٠٠٠", storeId: null, sourceSystem: null },
  ]);
});

test("I3: 409 alias_conflict is an error on the value that names no other item", async ({
  page: p,
  t,
}) => {
  const recorded = await mock(p, "owner", {
    add: () => ({ status: 409, body: failure("alias_conflict", "r-alias") }),
  });
  const drawer = await openAdd(p, t);
  const value = field(drawer, t("catalog.identifier.field.value"));
  await value.fill("6223000000017");
  await drawer.getByRole("button", { name: t("catalog.identifier.add.submit") }).click();
  await expect(drawer.getByText(t("catalog.identifier.error.aliasConflict"))).toBeVisible();
  await expect(value).toBeFocused();
  await expect(value).toHaveAttribute("aria-invalid", "true");
  await expect(drawer.getByText("r-alias")).toHaveCount(0);
  expect(recorded.adds).toHaveLength(1);
  await axeBothThemes(p, "identifier add drawer, alias conflict");
});

test("I4: an external POS id hides the scope and requires its source system", async ({
  page: p,
  t,
}) => {
  const recorded = await mock(p, "owner");
  const drawer = await openAdd(p, t);
  await field(drawer, t("catalog.identifier.field.type")).selectOption("external_pos_id");
  await expect(field(drawer, t("catalog.identifier.field.scope"))).toHaveCount(0);
  const source = field(drawer, t("catalog.identifier.field.source"));
  await field(drawer, t("catalog.identifier.field.value")).fill("ext-1");
  await drawer.getByRole("button", { name: t("catalog.identifier.add.submit") }).click();
  await expect(source).toBeFocused();
  await expect(drawer.getByText(t("catalog.identifier.error.sourceRequired"))).toBeVisible();
  expect(recorded.adds).toEqual([]);
  await source.fill("Legacy POS");
  await drawer.getByRole("button", { name: t("catalog.identifier.add.submit") }).click();
  await expect(drawer).toHaveCount(0);
  expect(recorded.adds).toEqual([
    {
      identifierType: "external_pos_id",
      value: "ext-1",
      storeId: null,
      sourceSystem: "Legacy POS",
    },
  ]);
});

test("I5: Retire names the identifier, then sends its full key; the row is gone", async ({
  page: p,
  t,
}) => {
  const scoped = ident({ identifierType: "sku", value: "SKU-0042", storeId: CAIRO });
  const recorded = await mock(p, "owner", { get: () => detail([scoped]) });
  await p.goto(`/catalog/products/${P1}`);
  const name = t("catalog.identifier.retire.rowLabel", {
    type: t("catalog.detail.identifierType.sku"),
    value: "SKU-0042",
  });
  await p.getByRole("button", { name }).click();
  const drawer = p.getByRole("dialog", { name: t("catalog.identifier.retire.title") });
  await expect(drawer.getByText("SKU-0042")).toBeVisible();
  await expect(drawer.getByText("Cairo Festival")).toBeVisible();
  await expect(drawer.getByText(t("catalog.identifier.retire.consequence"))).toBeVisible();
  await axeBothThemes(p, "identifier retire drawer");
  expect(recorded.retires).toEqual([]);

  await drawer.getByRole("button", { name: t("catalog.identifier.retire.confirm") }).click();
  await expect(drawer).toHaveCount(0);
  expect(recorded.retires).toEqual([
    { identifierType: "sku", value: "SKU-0042", storeId: CAIRO, sourceSystem: null },
  ]);
  await expect(p.getByText(t("catalog.detail.identifiers.empty"))).toBeVisible();
  await expect(p.getByText(t("catalog.identifier.retiredDone"))).toBeVisible();
  await expect(p.getByRole("button", { name: t("catalog.identifier.add.start") })).toBeFocused();
  await expectNoAxeViolations(p, "identifiers after retire");
});

test("I6: store_manager and a retired item get no identifier control", async ({ page: p, t }) => {
  await mock(p, "store_manager");
  await p.goto(`/catalog/products/${P1}`);
  await expect(p.getByText("0012345678905")).toBeVisible();
  await expect(p.getByRole("button", { name: t("catalog.identifier.add.start") })).toHaveCount(0);
  await expect(p.getByRole("main").getByRole("button")).toHaveCount(0);

  await p.unrouteAll({ behavior: "ignoreErrors" });
  await mock(p, "owner", { get: () => detail([ident()], { status: "retired" }) });
  await p.goto(`/catalog/products/${P1}`);
  await expect(p.getByText("0012345678905")).toBeVisible();
  await expect(p.getByRole("button", { name: t("catalog.identifier.add.start") })).toHaveCount(0);
  await expect(
    p.getByRole("button", { name: t("catalog.identifier.retire.start"), exact: false }),
  ).toHaveCount(0);
});
