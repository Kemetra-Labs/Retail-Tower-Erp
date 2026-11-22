import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1515 (PR 1) shipment Transfers, read only, against mocked Backend-Core (C-5).
 * S1: owner → Inventory → the Transfers entry → the list (newest first, a state
 * filter, Load more follows the cursor) → a Transfer's drawer (labelled line
 * quantities, receipts, each ERP leg) → Escape keeps the list and its filter.
 * Every request is a GET on the app's own origin; nothing is written.
 * S2: the non-disclosing 404 while transfers are off reads as "not available".
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
