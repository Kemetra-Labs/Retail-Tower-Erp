import { expectNoAxeViolations } from "./axe";
import { type Page, expect, overviewHeading, test } from "./fixtures";

/**
 * RT-1312 (Phase 3(b) slices B and C) sale quarantine queue E2E against mocked Backend-Core (C-5).
 * S1 (happy path): owner → "Sales the till could not send" → the item row → the item page → Close
 * without recording → note → confirm → exactly one POST with an Idempotency-Key and the note → the
 * item reads as closed. Only Backend-Core console routes are requested, and the repair route is
 * not touched by a write-off.
 * S3: the same item → Record the sale → confirm → exactly one POST with an Idempotency-Key and no
 * body → the item reads as recorded, with a link to the sale.
 * S2: store_manager has no nav entry, no quarantine request, and the list URL reads as no access.
 * RT-399: runs in both locales; copy comes from the catalog (`t`).
 */
const CAIRO = "0190f000-0000-7000-8000-0000000007a1";
const DEVICE = "0190f000-0000-7000-8000-0000000009d1";
const ITEM = "0190f000-0000-7000-8000-0000000009a1";
const SYNC = "/api/v1/catalog/sale-sync-ops";

function ctx(role: string) {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: null,
    active_role_code: role,
    memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: role }],
  };
}

const store = {
  id: CAIRO,
  tenant_id: "t1",
  code: "CAI",
  name: "Cairo Festival",
  timezone: "Africa/Cairo",
  is_active: true,
};

const open = {
  quarantineRef: ITEM,
  storeId: CAIRO,
  deviceId: DEVICE,
  sourceSystem: "pos",
  externalId: "POS-CAI-0042",
  reasonKind: "refused",
  tillHttpStatus: 422,
  tillErrorCode: "sale_tender_mismatch",
  state: "open",
  receivedAt: "2026-11-19T10:31:00Z",
  tillRecordedAt: "2026-11-19T10:25:00Z",
  previousTerminalId: null,
  repairCount: 0,
  lastRepair: null,
  uploadConflictCount: 0,
  saleRef: null,
  summary: {
    occurredAt: "2026-11-19T10:24:00Z",
    posTotal: "1250.50",
    currencyCode: "EGP",
    lineCount: 3,
  },
  writeOff: null,
};

const NOTE = "Refunded in cash outside Retail Tower";

const closed = {
  ...open,
  state: "written-off",
  writeOff: { at: "2026-11-19T11:00:00Z", note: NOTE },
};

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

async function mockBase(page: Page, role: string): Promise<void> {
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(role))));
  await page.route("**/api/v1/stores", (r) => r.fulfill(json([store])));
  await page.route(`**/api/v1/stores/${CAIRO}`, (r) => r.fulfill(json(store)));
}

test("S1: owner → queue → item → confirmed write-off → closed", async ({ page: p, t }) => {
  await mockBase(p, "owner");
  let written = false;
  const writes: { key: string | null; method: string; body: unknown }[] = [];
  // The later routes win: the item and its write-off are registered after the list pattern.
  await p.route(`**${SYNC}/quarantined-sales**`, (r) =>
    r.fulfill(json({ items: [open], nextCursor: null })),
  );
  await p.route(`**${SYNC}/quarantined-sales/${ITEM}`, (r) =>
    r.fulfill(json(written ? closed : open)),
  );
  await p.route(`**${SYNC}/quarantined-sales/${ITEM}/write-off`, (r) => {
    writes.push({
      key: r.request().headers()["idempotency-key"] ?? null,
      method: r.request().method(),
      body: r.request().postDataJSON(),
    });
    written = true;
    return r.fulfill(json(closed));
  });

  await p.goto("/");
  await p.waitForLoadState("networkidle");
  const requested: URL[] = [];
  p.on("request", (r) => requested.push(new URL(r.url())));

  await p
    .getByRole("navigation", { name: t("shell.nav.label") })
    .getByRole("link", { name: t("saleQuarantine.nav.label") })
    .click();
  await expect(
    p.getByRole("heading", { level: 1, name: t("saleQuarantine.list.title") }),
  ).toBeVisible();
  await expect(p.getByText(t("saleQuarantine.list.note"))).toBeVisible();
  const row = p.getByRole("row").filter({ hasText: "POS-CAI-0042" });
  await expect(row).toContainText("Cairo Festival");
  await expectNoAxeViolations(p, "quarantine list");

  await row
    .getByRole("link", { name: t("saleQuarantine.list.openItem", { ref: "POS-CAI-0042" }) })
    .click();
  await expect(p).toHaveURL(new RegExp(`/quarantined-sales/${ITEM}$`));
  await expect(
    p
      .getByRole("region", { name: t("saleQuarantine.section.till") })
      .getByText("sale_tender_mismatch"),
  ).toBeVisible();
  await expectNoAxeViolations(p, "quarantine item");

  await p.getByRole("button", { name: t("saleQuarantine.writeOff.action") }).click();
  const dialog = p.getByRole("dialog", { name: t("saleQuarantine.writeOff.dialogTitle") });
  await expect(dialog).toContainText("POS-CAI-0042");
  const commit = dialog.getByRole("button", { name: t("saleQuarantine.writeOff.commit") });
  await expect(commit).toBeDisabled();
  await dialog.getByLabel(t("saleQuarantine.writeOff.note.label")).fill(NOTE);
  await expectNoAxeViolations(p, "quarantine write-off dialog");
  expect(writes).toHaveLength(0);
  await commit.click();

  await expect(dialog.getByText(t("saleQuarantine.writeOff.success"))).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].method).toBe("POST");
  expect(writes[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(writes[0].body).toEqual({ note: NOTE });
  await dialog.getByRole("button", { name: t("saleQuarantine.writeOff.done") }).click();
  await expect(dialog).toHaveCount(0);
  await expect(p.getByRole("button", { name: t("saleQuarantine.writeOff.action") })).toHaveCount(0);
  await expect(p.getByText(NOTE)).toBeVisible();

  // Only Backend-Core console routes on the app's own origin: no POS route, ERPNext, Frappe or
  // Connector request, and the repair route is not touched by a write-off.
  const origin = new URL(p.url()).origin;
  expect(requested.filter((url) => url.origin !== origin)).toEqual([]);
  const api = [
    ...new Set(requested.filter((u) => u.pathname.startsWith("/api/")).map((u) => u.pathname)),
  ];
  expect(api).toContain(`${SYNC}/quarantined-sales/${ITEM}/write-off`);
  for (const path of api) {
    expect(path).not.toMatch(/\/repair$/);
    expect(path).toMatch(/^\/api\/v1\/(stores|context|devices|catalog\/sale-sync-ops)(\/|$)/);
  }
});

test("S2: store_manager has no entry and the list is no access", async ({ page: p, t }) => {
  await mockBase(p, "store_manager");
  const syncCalls: string[] = [];
  await p.route(`**${SYNC}/**`, (r) => {
    syncCalls.push(r.request().url());
    return r.fulfill(json({ error: { code: "not_found", message: "Not found." } }, 404));
  });

  await p.goto("/");
  await expect(overviewHeading(p, t)).toBeVisible();
  await expect(p.getByRole("link", { name: t("saleQuarantine.nav.label") })).toHaveCount(0);

  await p.goto("/quarantined-sales");
  await expect(
    p.getByRole("heading", { level: 1, name: t("saleQuarantine.list.title") }),
  ).toHaveCount(0);
  expect(syncCalls).toEqual([]);
});

test("S3: owner → item → confirmed repair → recorded", async ({ page: p, t }) => {
  await mockBase(p, "owner");
  const SALE = "0190f000-0000-7000-8000-0000000009b1";
  const recorded = {
    ...open,
    state: "captured",
    saleRef: SALE,
    repairCount: 1,
    lastRepair: {
      at: "2026-11-19T11:00:00Z",
      outcome: "captured",
      httpStatus: null,
      errorCode: null,
    },
  };
  let repaired = false;
  const writes: { key: string | null; method: string; body: string | null }[] = [];
  await p.route(`**${SYNC}/quarantined-sales/${ITEM}`, (r) =>
    r.fulfill(json(repaired ? recorded : open)),
  );
  await p.route(`**${SYNC}/quarantined-sales/${ITEM}/repair`, (r) => {
    writes.push({
      key: r.request().headers()["idempotency-key"] ?? null,
      method: r.request().method(),
      body: r.request().postData(),
    });
    repaired = true;
    return r.fulfill(json(recorded));
  });

  await p.goto(`/quarantined-sales/${ITEM}`);
  await p.getByRole("button", { name: t("saleQuarantine.repair.action") }).click();
  const dialog = p.getByRole("dialog", { name: t("saleQuarantine.repair.dialogTitle") });
  await expect(dialog).toContainText("POS-CAI-0042");
  await expectNoAxeViolations(p, "quarantine repair dialog");
  expect(writes).toHaveLength(0);
  await dialog.getByRole("button", { name: t("saleQuarantine.repair.commit") }).click();

  await expect(dialog.getByText(t("saleQuarantine.repair.success.captured"))).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].method).toBe("POST");
  expect(writes[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(writes[0].body).toBeNull();
  await dialog.getByRole("button", { name: t("saleQuarantine.repair.done") }).click();
  await expect(dialog).toHaveCount(0);
  await expect(p.getByRole("button", { name: t("saleQuarantine.repair.action") })).toHaveCount(0);
  await expect(p.getByRole("link", { name: t("saleQuarantine.value.openSale") })).toHaveAttribute(
    "href",
    `/sales/${SALE}`,
  );
});
