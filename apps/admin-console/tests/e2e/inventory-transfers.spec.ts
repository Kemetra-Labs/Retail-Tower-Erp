import { expectNoAxeViolations } from "./axe";
import { type LocaleFixtures, type Page, expect, test } from "./fixtures";

/**
 * RT-1515 (PR 1) shipment Transfers, read only, against mocked Backend-Core (C-5).
 * S1: owner → Inventory → the Transfers entry → the list (newest first, a state
 * filter, Load more follows the cursor) → a Transfer's drawer (labelled line
 * quantities, receipts, each ERP leg) → Escape keeps the list and its filter.
 * Every request is a GET on the app's own origin; nothing is written.
 * S2: the non-disclosing 404 while transfers are off reads as "not available".
 * S3 (RT-1515 PR 2): owner drafts a Transfer (source, destination, a product
 * with its source on-hand and unit, a quantity), approves it, dispatches it:
 * every write is one POST with an Idempotency-Key, and each answer is read back.
 * S4: a refused write shows code-keyed copy (never the server's message) and a
 * cancellation with a reason follows.
 * Runs in both locales; copy comes from the catalog (`t`).
 */
const CAIRO = "0190f000-0000-7000-8000-0000000007a1";
const ALEX = "0190f000-0000-7000-8000-0000000007a2";
const T1 = "0190f000-0000-7000-8000-00000000a001";
const T2 = "0190f000-0000-7000-8000-00000000a002";
const LINE = "0190f000-0000-7000-8000-00000000b001";
const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";
const ME = "0190f000-0000-7000-8000-000000000a01";
const TRANSFERS = "/api/inventory/v1/shipment-transfers";

const ctx = {
  user: { id: ME, email: "amal@northstar.eg", display_name: "Amal Saleh" },
  active_tenant: { id: "t1", name: "Northstar Retail" },
  active_store: null,
  active_role_code: "owner",
  memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: "owner" }],
};

const stores = [
  {
    id: CAIRO,
    tenant_id: "t1",
    code: "CAI",
    name: "Cairo Festival",
    timezone: "Africa/Cairo",
    is_active: true,
  },
  {
    id: ALEX,
    tenant_id: "t1",
    code: "ALX",
    name: "Alexandria",
    timezone: "Africa/Cairo",
    is_active: true,
  },
];

function transfer(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sourceStoreId: CAIRO,
    destinationStoreId: ALEX,
    state: "partially_received",
    lines: [
      {
        id: LINE,
        lineSeq: 1,
        tenantProductRef: PRODUCT,
        stockingUnit: "kg",
        trackingIdentityId: null,
        quantity: "10.0000",
        dispatchedQuantity: "10.0000",
        receivedQuantity: "4.0000",
        shortClosedQuantity: "0.0000",
        inTransitQuantity: "6.0000",
        dispatchMovementId: null,
      },
    ],
    reason: null,
    createdBy: ME,
    createdAt: "2026-11-20T08:00:00Z",
    approval: { by: ME, at: "2026-11-20T09:00:00Z" },
    reservation: null,
    dispatch: { by: ME, at: "2026-11-20T10:00:00Z" },
    dispatchIntegrationState: "confirmed",
    shortClose: null,
    closure: null,
    cancellation: null,
    receiptCount: 1,
    updatedAt: "2026-11-21T08:00:00Z",
    ...overrides,
  };
}

const receipts = {
  items: [
    {
      id: "0190f000-0000-7000-8000-00000000c001",
      transferId: T1,
      receivedBy: ME,
      receivedAt: "2026-11-21T08:00:00Z",
      note: null,
      integrationState: "pending",
      lines: [
        {
          transferLineId: LINE,
          quantity: "4.0000",
          inventoryStatus: "sellable",
          stockLocationId: "0190f000-0000-7000-8000-0000000007d1",
          movementId: "0190f000-0000-7000-8000-0000000007d2",
        },
      ],
    },
  ],
  nextCursor: null,
};

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

interface Seen {
  listQueries: URLSearchParams[];
  methods: string[];
}

async function mockBase(page: Page, enabled: boolean): Promise<Seen> {
  const seen: Seen = { listQueries: [], methods: [] };
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx)));
  await page.route("**/api/v1/stores", (r) => r.fulfill(json(stores)));
  await page.route(`**${TRANSFERS}**`, (r) => {
    seen.methods.push(r.request().method());
    const url = new URL(r.request().url());
    if (!enabled)
      return r.fulfill(json({ error: { code: "not_found", message: "Not Found" } }, 404));
    if (url.pathname === TRANSFERS) {
      seen.listQueries.push(url.searchParams);
      const body =
        url.searchParams.get("cursor") === "cursor-2"
          ? { items: [transfer(T2, { state: "received", receiptCount: 0 })], nextCursor: null }
          : { items: [transfer(T1)], nextCursor: "cursor-2" };
      return r.fulfill(json(body));
    }
    if (url.pathname === `${TRANSFERS}/${T1}`) return r.fulfill(json(transfer(T1)));
    if (url.pathname === `${TRANSFERS}/${T1}/receipts`) return r.fulfill(json(receipts));
    return r.fulfill(json({ error: { code: "not_found", message: "Not Found" } }, 404));
  });
  return seen;
}

test("S1: owner reads the transfers and one Transfer's drawer, read-only", async ({
  page: p,
  t,
}) => {
  const seen = await mockBase(p, true);
  await p.goto("/inventory");
  const requested: URL[] = [];
  p.on("request", (r) => requested.push(new URL(r.url())));

  await p.getByRole("link", { name: t("transfers.entry") }).click();
  await expect(p).toHaveURL(/\/inventory\/transfers$/);
  await expect(p.getByRole("heading", { level: 1, name: t("transfers.title") })).toBeVisible();
  const list = p.getByRole("table", { name: t("transfers.list.caption") });
  await expect(list).toContainText("Cairo Festival");
  await expect(list).toContainText(t("transfers.state.partially_received"));
  await expectNoAxeViolations(p, "transfers list");

  await p.getByRole("button", { name: t("transfers.list.loadMore") }).click();
  await expect(list).toContainText(t("transfers.state.received"));
  await expect(p.getByRole("button", { name: t("transfers.list.loadMore") })).toHaveCount(0);
  expect(seen.listQueries.map((q) => q.get("cursor"))).toEqual([null, "cursor-2"]);

  await p
    .getByLabel(t("transfers.filter.state"), { exact: true })
    .selectOption("partially_received");
  await expect(p).toHaveURL(/state=partially_received/);
  await expect.poll(() => seen.listQueries.at(-1)?.get("state")).toBe("partially_received");

  await list
    .getByRole("button", { name: t("transfers.list.openHint") })
    .first()
    .click();
  const drawer = p.getByRole("dialog", { name: t("transfers.detail.title") });
  const lines = drawer.getByRole("table", { name: t("transfers.lines.caption") });
  await expect(
    lines.getByRole("columnheader", { name: t("transfers.lines.col.inTransit") }),
  ).toBeVisible();
  await expect(lines).toContainText("6.0000");
  await expect(drawer.getByRole("table", { name: t("transfers.receipts.caption") })).toContainText(
    t("transfers.leg.pending"),
  );
  await expect(drawer).toContainText(t("transfers.leg.confirmed"));
  await expectNoAxeViolations(p, "transfer drawer");

  await p.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(p).toHaveURL(/state=partially_received/);

  expect(seen.methods.every((m) => m === "GET")).toBe(true);
  const origin = new URL(p.url()).origin;
  expect(requested.filter((url) => url.origin !== origin)).toEqual([]);
});

test("S2: while transfers are off the list reads as not available", async ({ page: p, t }) => {
  await mockBase(p, false);
  await p.goto("/inventory/transfers");
  await expect(p.getByText(t("transfers.notAvailable"))).toBeVisible();
  await expect(p.getByText(t("transfers.list.empty"))).toHaveCount(0);
  await expectNoAxeViolations(p, "transfers not available");
});

// --- RT-1515 PR 2: the writes ------------------------------------------------------------------

const OIL = "0190f000-0000-7000-8000-0000000007c9";
const T_NEW = "0190f000-0000-7000-8000-00000000a0ff";
const REQUEST_ID = "0190f000-0000-7000-8000-0000000007e1";
const KEY_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Write {
  method: string;
  path: string;
  key: string | undefined;
  body: Record<string, unknown>;
}

type LocaleT = LocaleFixtures["t"];

interface WriteMock {
  writes: Write[];
  /** The next approve answers this refusal once (code), then goes on as normal. */
  refuseApproveOnce: { code: string } | null;
}

function oil() {
  return {
    productId: OIL,
    name: "Olive oil",
    status: "active",
    categoryId: null,
    categoryName: null,
    brandId: null,
    brandName: null,
    primarySku: "OIL-1",
    primaryBarcode: null,
    defaultPrice: null,
    taxCategory: "standard",
    trackingMode: "none",
    updatedAt: "2026-11-01T08:00:00Z",
  };
}

async function mockWrites(page: Page): Promise<WriteMock> {
  const mock: WriteMock = { writes: [], refuseApproveOnce: null };
  let current = transfer(T_NEW, {
    state: "draft",
    approval: null,
    dispatch: null,
    dispatchIntegrationState: null,
    receiptCount: 0,
    lines: [
      {
        id: LINE,
        lineSeq: 1,
        tenantProductRef: OIL,
        stockingUnit: "kg",
        trackingIdentityId: null,
        quantity: "2.5",
        dispatchedQuantity: "0.0000",
        receivedQuantity: "0.0000",
        shortClosedQuantity: "0.0000",
        inTransitQuantity: "0.0000",
        dispatchMovementId: null,
      },
    ],
  });
  let created = false;
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx)));
  await page.route("**/api/v1/stores", (r) => r.fulfill(json(stores)));
  await page.route("**/api/v1/catalog/products?**", (r) =>
    r.fulfill(json({ items: [oil()], nextCursor: null })),
  );
  await page.route("**/api/inventory/v1/on-hand/**", (r) =>
    r.fulfill(
      json({
        storeId: CAIRO,
        productId: OIL,
        quantity: "10.0000",
        stockingUnit: "kg",
        negativeBalance: false,
        sellableQuantity: "8.0000",
        statusQuantities: [],
      }),
    ),
  );
  const read = (url: URL) => {
    if (url.pathname === TRANSFERS) return { items: created ? [current] : [], nextCursor: null };
    if (url.pathname.endsWith("/receipts")) return { items: [], nextCursor: null };
    return current;
  };
  const write = (url: URL, action: string | undefined) => {
    if (url.pathname === TRANSFERS) {
      created = true;
      return json(current, 201);
    }
    if (action === "approve" && mock.refuseApproveOnce) {
      const { code } = mock.refuseApproveOnce;
      mock.refuseApproveOnce = null;
      return json({ error: { code, message: "SERVER WORDS", request_id: REQUEST_ID } }, 409);
    }
    const next = { approve: "approved", dispatch: "in_transit", cancel: "cancelled" }[action ?? ""];
    current = { ...current, state: next as string };
    return json(current);
  };
  await page.route(`**${TRANSFERS}**`, (r) => {
    const req = r.request();
    const url = new URL(req.url());
    if (req.method() === "GET") return r.fulfill(json(read(url)));
    mock.writes.push({
      method: req.method(),
      path: url.pathname,
      key: req.headers()["idempotency-key"],
      body: JSON.parse(req.postData() ?? "{}") as Record<string, unknown>,
    });
    return r.fulfill(write(url, url.pathname.split("/").at(-1)));
  });
  return mock;
}

async function draftOne(p: Page, t: LocaleT) {
  await p.goto("/inventory/transfers");
  await p.getByRole("button", { name: t("transfers.create.open"), exact: true }).click();
  const form = p.getByRole("dialog", { name: t("transfers.create.title") });
  const source = form.getByLabel(t("transfers.create.source"), { exact: true });
  await expect(source.locator("option", { hasText: "Cairo Festival" })).toHaveCount(1);
  await source.selectOption(CAIRO);
  await form.getByLabel(t("transfers.create.destination"), { exact: true }).selectOption(ALEX);
  await form.getByRole("option", { name: /Olive oil/ }).click();
  await expect(form.getByText("10.0000")).toBeVisible();
  await expect(form.getByText(t("transfers.create.stock.physical"))).toBeVisible();
  await expect(form.getByText(t("transfers.create.stock.sellable"))).toBeVisible();
  await form.getByLabel(t("transfers.create.quantity")).fill("2.5");
  return form;
}

test("S3: owner drafts, approves and dispatches a Transfer; each write is one keyed POST", async ({
  page: p,
  t,
}) => {
  const mock = await mockWrites(p);
  const form = await draftOne(p, t);
  await expectNoAxeViolations(p, "transfer create form");
  await form.getByRole("button", { name: t("transfers.create.submit"), exact: true }).click();

  const drawer = p.getByRole("dialog", { name: t("transfers.detail.title") });
  await expect(drawer.getByText(t("transfers.state.draft"))).toBeVisible();
  await drawer.getByRole("button", { name: t("transfers.approve.open"), exact: true }).click();
  await expect(drawer.getByText(t("transfers.approve.intro"))).toBeVisible();
  await drawer.getByRole("button", { name: t("transfers.approve.submit"), exact: true }).click();
  await expect(drawer.getByText(t("transfers.recorded.approve"))).toBeVisible();
  await expect(
    drawer.getByText(t("transfers.state.approved"), { exact: true }).first(),
  ).toBeVisible();

  await drawer.getByRole("button", { name: t("transfers.dispatch.open"), exact: true }).click();
  await expect(drawer.getByText(t("transfers.dispatch.confirm"))).toBeVisible();
  await drawer.getByRole("button", { name: t("transfers.dispatch.submit"), exact: true }).click();
  await expect(drawer.getByText(t("transfers.recorded.dispatch"))).toBeVisible();
  await expect(
    drawer.getByText(t("transfers.state.in_transit"), { exact: true }).first(),
  ).toBeVisible();
  // An in-transit Transfer offers no write action.
  await expect(drawer.getByRole("heading", { name: t("transfers.actions.title") })).toHaveCount(0);

  expect(mock.writes.map((w) => `${w.method} ${w.path.replace(T_NEW, "{id}")}`)).toEqual([
    `POST ${TRANSFERS}`,
    `POST ${TRANSFERS}/{id}/approve`,
    `POST ${TRANSFERS}/{id}/dispatch`,
  ]);
  const keys = mock.writes.map((w) => w.key);
  for (const key of keys) expect(key).toMatch(KEY_SHAPE);
  expect(new Set(keys).size).toBe(3);
  expect(mock.writes[0]?.body).toMatchObject({
    sourceStoreId: CAIRO,
    destinationStoreId: ALEX,
    lines: [
      { tenantProductRef: OIL, quantity: "2.5", stockingUnit: "kg", trackingIdentityId: null },
    ],
  });
  const expiry = new Date(String(mock.writes[1]?.body.reservationExpiresAt)).getTime();
  expect(expiry).toBeGreaterThan(Date.now());
  await expectNoAxeViolations(p, "transfer drawer with actions");
});

test("S4: a refused write shows code-keyed copy, then a cancellation with a reason", async ({
  page: p,
  t,
}) => {
  const mock = await mockWrites(p);
  mock.refuseApproveOnce = { code: "transfer_warehouse_unmapped" };
  const form = await draftOne(p, t);
  await form.getByRole("button", { name: t("transfers.create.submit"), exact: true }).click();

  const drawer = p.getByRole("dialog", { name: t("transfers.detail.title") });
  await drawer.getByRole("button", { name: t("transfers.approve.open"), exact: true }).click();
  await drawer.getByRole("button", { name: t("transfers.approve.submit"), exact: true }).click();
  await expect(drawer.getByText(t("transfers.write.error.warehouseUnmapped"))).toBeVisible();
  await expect(drawer.getByText(REQUEST_ID)).toBeVisible();
  await expect(drawer.getByText("SERVER WORDS")).toHaveCount(0);
  await expect(drawer.getByText(t("transfers.recorded.approve"))).toHaveCount(0);

  await drawer.getByRole("button", { name: t("transfers.cancel.open"), exact: true }).click();
  await drawer.getByRole("button", { name: t("transfers.cancel.submit"), exact: true }).click();
  await expect(drawer.getByText(t("transfers.cancel.error.reason"))).toBeVisible();
  await drawer.getByLabel(t("transfers.cancel.reason")).fill("Wrong store");
  await drawer.getByRole("button", { name: t("transfers.cancel.submit"), exact: true }).click();
  await expect(drawer.getByText(t("transfers.recorded.cancel"))).toBeVisible();
  await expect(
    drawer.getByText(t("transfers.state.cancelled"), { exact: true }).first(),
  ).toBeVisible();

  const cancel = mock.writes.at(-1);
  expect(cancel?.path).toBe(`${TRANSFERS}/${T_NEW}/cancel`);
  expect(cancel?.body).toEqual({ reason: "Wrong store" });
  expect(cancel?.key).toMatch(KEY_SHAPE);
});
