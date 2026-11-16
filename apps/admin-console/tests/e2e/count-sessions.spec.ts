import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1425 part 2: Count Session pages E2E against mocked Backend-Core (C-5).
 * S1: the store's counts page, owner: the sessions list, the activation panel (off, with the
 *     readiness boundaries by catalog copy), a refused switch-on that stays off, then a
 *     recorded switch-on that is re-read from the server. Axe on each state.
 * S2: a store manager reads the state, never gets a switch, and sends no write.
 * S3: a submitted session's variance review renders its flagged line; axe.
 * RT-399: runs in both locales; copy comes from the catalog (`t`).
 */
const CAIRO = "0190f000-0000-7000-8000-0000000007a1";
const SESSION = "0190f000-0000-7000-8000-0000000008a1";
const PRODUCT = "0190f000-0000-7000-8000-0000000009a1";
const OWNER = "0190f000-0000-7000-8000-000000000a01";
const INV = "/api/inventory/v1";

function ctx(role: string) {
  return {
    user: { id: OWNER, email: "amal@northstar.eg", display_name: "Amal Saleh" },
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

const session = (state: string) => ({
  id: SESSION,
  storeId: CAIRO,
  state,
  scope: { kind: "products", productIds: [PRODUCT] },
  note: null,
  cut: { watermark: "wm-0001", cutAt: "2026-11-16T08:15:00Z", takenBy: OWNER },
  openedBy: OWNER,
  openedAt: "2026-11-16T08:00:00Z",
  counterIds: [OWNER],
  submittedBy: OWNER,
  submittedAt: "2026-11-16T08:30:00Z",
  approval: null,
  cancellation: null,
  lateEventFindingCount: 0,
  updatedAt: "2026-11-16T08:30:00Z",
});

const varianceLine = {
  productId: PRODUCT,
  lineVersion: "1",
  stockingUnit: "kg",
  expectedQuantity: "10.0000",
  countedQuantity: "7.0000",
  varianceQuantity: "-3.0000",
  flags: ["divergence"],
  acknowledgementRequired: true,
  acknowledgement: null,
  refusal: null,
  observations: [],
};

const unmetReadiness = [
  { code: "connector_not_seen", storeId: null, message: "server words" },
  { code: "store_warehouse_unmapped", storeId: CAIRO, message: "server words" },
];

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

interface Seen {
  writes: { method: string; url: string; body: unknown }[];
}

type SettingBody = Record<string, unknown>;

async function mockBase(
  page: Page,
  role: string,
  setting: { current: SettingBody; onPut: (body: { enabled: boolean }) => ReturnType<typeof json> },
): Promise<Seen> {
  const seen: Seen = { writes: [] };
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(role))));
  await page.route("**/api/v1/stores", (r) => r.fulfill(json([store])));
  await page.route(`**${INV}/**`, (r) =>
    r.fulfill(json({ error: { code: "not_found", message: "Not found." } }, 404)),
  );
  await page.route(`**${INV}/stores/${CAIRO}/count-sessions**`, (r) =>
    r.fulfill(json({ items: [session("submitted")], nextCursor: null })),
  );
  await page.route(`**${INV}/stores/${CAIRO}/count-sessions/${SESSION}`, (r) =>
    r.fulfill(json(session("submitted"))),
  );
  await page.route(`**${INV}/stores/${CAIRO}/count-sessions/${SESSION}/variance-lines**`, (r) =>
    r.fulfill(json({ items: [varianceLine], nextCursor: null })),
  );
  await page.route(
    `**${INV}/stores/${CAIRO}/count-sessions/${SESSION}/late-event-findings**`,
    (r) => r.fulfill(json({ items: [], nextCursor: null })),
  );
  await page.route(`**${INV}/settings/count-self-approval`, (r) =>
    r.fulfill(json({ enabled: false, reason: null, changedAt: null, changedBy: null })),
  );
  await page.route(`**${INV}/settings/count-sessions`, (r) => {
    const request = r.request();
    if (request.method() === "GET") return r.fulfill(json(setting.current));
    const body = request.postDataJSON() as { enabled: boolean };
    seen.writes.push({ method: request.method(), url: request.url(), body });
    return r.fulfill(setting.onPut(body));
  });
  return seen;
}

const off = (): SettingBody => ({
  enabled: false,
  changedAt: null,
  changedBy: null,
  readinessMet: false,
  unmetReadiness,
});

test("S1: owner reads the off state, a refused switch-on stays off, a recorded one reads on", async ({
  page: p,
  t,
}) => {
  const setting = {
    current: off(),
    onPut: (_body: { enabled: boolean }) =>
      json(
        {
          error: {
            code: "count_sessions_readiness_unmet",
            message: "server words",
            details: { boundary: "connector_not_seen", storeId: null, unmet: unmetReadiness },
          },
        },
        409,
      ),
  };
  const seen = await mockBase(p, "owner", setting);
  await p.goto(`/inventory/stores/${CAIRO}/counts`);

  await expect(p.getByRole("heading", { name: t("counts.activation.title") })).toBeVisible();
  const state = p.getByTestId("count-activation-state");
  await expect(state).toContainText(t("counts.activation.off"));
  await expect(p.getByTestId("count-activation-unmet")).toContainText(
    t("counts.boundary.connector_not_seen"),
  );
  await expect(p.getByTestId("count-activation-unmet")).not.toContainText("server words");
  await expectNoAxeViolations(p, "counts page, activation off");

  await p.getByRole("button", { name: t("counts.activation.turnOn") }).click();
  await expect(p.getByTestId("count-outcome")).toContainText("count_sessions_readiness_unmet");
  await expect(p.getByTestId("count-outcome")).toContainText(
    t("counts.boundary.store_warehouse_unmapped"),
  );
  await expect(state).toContainText(t("counts.activation.off"));
  await expectNoAxeViolations(p, "counts page, activation refused");
  expect(seen.writes).toEqual([
    {
      method: "PUT",
      url: expect.stringContaining("/settings/count-sessions"),
      body: { enabled: true },
    },
  ]);

  // The server accepts the next attempt: the panel reads on from the re-read, not a guess.
  setting.onPut = () => {
    setting.current = {
      enabled: true,
      changedAt: "2026-11-16T10:00:00Z",
      changedBy: OWNER,
      readinessMet: true,
      unmetReadiness: [],
    };
    return json(setting.current);
  };
  await p.getByRole("button", { name: t("counts.activation.turnOn") }).click();
  await expect(p.getByTestId("count-activation-state")).toContainText(t("counts.activation.on"));
  await expect(p.getByRole("button", { name: t("counts.activation.turnOff") })).toBeVisible();
  await expectNoAxeViolations(p, "counts page, activation on");
});

test("S2: a store manager reads the state and never gets a switch", async ({ page: p, t }) => {
  const seen = await mockBase(p, "store_manager", {
    current: {
      enabled: true,
      changedAt: null,
      changedBy: null,
      readinessMet: null,
      unmetReadiness: null,
    },
    onPut: () => json({}, 500),
  });
  await p.goto(`/inventory/stores/${CAIRO}/counts`);
  await expect(p.getByTestId("count-activation-state")).toContainText(t("counts.activation.on"));
  await expect(p.getByText(t("counts.activation.readOnly"))).toBeVisible();
  await expect(
    p.getByRole("button", {
      name: new RegExp(`${t("counts.activation.turnOn")}|${t("counts.activation.turnOff")}`),
    }),
  ).toHaveCount(0);
  await expectNoAxeViolations(p, "counts page, store manager");
  expect(seen.writes).toEqual([]);
});

test("S3: a submitted session shows its variance review with the flagged line", async ({
  page: p,
  t,
}) => {
  await mockBase(p, "owner", { current: off(), onPut: () => json({}, 500) });
  await p.goto(`/inventory/stores/${CAIRO}/counts/${SESSION}`);
  await expect(p.getByRole("heading", { name: t("counts.review.title") })).toBeVisible();
  const row = p.getByTestId("count-line");
  await expect(row).toContainText("10.0000");
  await expect(row).toContainText("7.0000");
  await expect(p.getByTestId("count-variance")).toHaveText("-3.0000");
  await expectNoAxeViolations(p, "count session review");
});
