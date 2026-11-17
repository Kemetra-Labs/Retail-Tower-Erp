import { DEVICE_1, DUBAI_STORE, SHIFT_OPEN, detail } from "../unit/device-fixtures";
import { impact, openShift } from "../unit/device-lifecycle-fixtures";
import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1440 (U1) E2E against mocked Backend-Core (C-5): the owner's way out of a dead till.
 *   S1 the journey: device page -> the retire is blocked by the open shift -> the next-step link ->
 *      the store's open shifts -> «close without a count» (reason + acknowledgement) -> the retire is
 *      allowed. The server's verdicts are the only verdicts; the console never computes one.
 *   S2 the dialog starts on Cancel, is axe-clean, and works in both locales (Arabic is RTL).
 *   S3 hiding: the action is absent for a store_manager and inside a support session.
 * RT-399: runs in both locales; copy comes from the catalog (`t`).
 */

const FINGERPRINT = "3f0c8a5e1b7d4c2a9e6f0b1d8c7a5e4f2b3d9c6a1e8f7b0d5c4a3e2f1b9d8c7a";
const TERMINAL = String(detail().label);

function ctx(role: string, supportSession: unknown = null) {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: null,
    active_role_code: role,
    support_session: supportSession,
    memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: role }],
  };
}

const store = {
  id: DUBAI_STORE,
  tenant_id: "t1",
  code: "DXB",
  name: "Dubai Mall",
  timezone: "Asia/Dubai",
  is_active: true,
};

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

function stuckShift() {
  return {
    shiftId: SHIFT_OPEN,
    storeId: DUBAI_STORE,
    source: "cash_up",
    lifecycleState: "open",
    openedAt: "2026-10-17T07:30:00Z",
    ageMinutes: 880,
    cashier: { userId: "0190f000-0000-7000-8000-0000000000c1", displayName: null },
    terminal: { deviceId: DEVICE_1, label: TERMINAL, lastSeenAt: "2026-10-17T07:50:00Z", trustState: "active" },
    verdict: { eligible: true, stale: true, liveOperatorSession: false, liveCashierAdmission: false, blockers: [] },
  };
}

function previewBody() {
  return {
    shift: stuckShift(),
    recorded: {
      currencyCode: "EGP",
      openingFloat: "500.00",
      cashMovementCount: 3,
      lastCashMovementReceivedAt: "2026-10-17T09:40:00Z",
      saleCount: 41,
      refundExecutionCount: 1,
    },
    effects: {
      willChange: ["shift_closed_not_counted", "device_retire_replace_move_unblocked"],
      willNotChange: ["sales_unchanged", "erp_documents_unchanged"],
    },
    reversible: false,
    drawerCashUnaccounted: true,
    caveats: ["offline_facts_not_visible", "terminal_not_notified"],
    previewFingerprint: FINGERPRINT,
    evaluatedAt: "2026-10-17T10:00:00Z",
  };
}

interface Calls {
  close: { body: unknown; key: string | undefined }[];
}

/** Mocked Backend-Core: a device whose retire is blocked until the shift is closed from the Console. */
async function mockStuckTill(page: Page, role: string, supportSession: unknown = null): Promise<Calls> {
  const calls: Calls = { close: [] };
  let closed = false;
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/device-health**", (r) => r.fulfill({ status: 404 }));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(role, supportSession))));
  await page.route("**/api/v1/stores", (r) => r.fulfill(json([store])));
  await page.route(`**/api/v1/stores/${DUBAI_STORE}`, (r) => r.fulfill(json(store)));
  await page.route(`**/api/v1/devices/${DEVICE_1}`, (r) => r.fulfill(json(detail())));
  await page.route("**/api/v1/pairing-codes?**", (r) => r.fulfill(json({ items: [], nextCursor: null })));
  await page.route(`**/api/v1/devices/${DEVICE_1}/impact?**`, (r) =>
    r.fulfill(
      json(
        closed
          ? impact({ action: "retire", revokeReason: "retired" })
          : impact({
              action: "retire",
              revokeReason: "retired",
              verdict: "blocked",
              blockCode: "unresolved_cash_session",
              openShift: openShift(),
            }),
      ),
    ),
  );
  const asOwner = role === "owner" || role === "tenant_admin";
  await page.route(`**/api/v1/stores/${DUBAI_STORE}/open-shifts`, (r) =>
    asOwner
      ? r.fulfill(
          json({
            storeId: DUBAI_STORE,
            evaluatedAt: "2026-10-17T10:00:00Z",
            staleThresholdMinutes: 15,
            items: closed ? [] : [stuckShift()],
          }),
        )
      : r.fulfill(json({ error: { code: "store_not_found", message: "Not found", request_id: "req-404" } }, 404)),
  );
  await page.route(`**/api/v1/shifts/${SHIFT_OPEN}/force-close-preview`, (r) => r.fulfill(json(previewBody())));
  await page.route(`**/api/v1/shifts/${SHIFT_OPEN}/force-close`, async (r) => {
    calls.close.push({ body: r.request().postDataJSON(), key: r.request().headers()["idempotency-key"] });
    closed = true;
    return r.fulfill(
      json(
        {
          shiftId: SHIFT_OPEN,
          status: "force_closed",
          currencyCode: "EGP",
          openingFloat: "500.00",
          openedAt: "2026-10-17T07:30:00Z",
          openingUserId: "0190f000-0000-7000-8000-0000000000c1",
          receivedAt: "2026-10-17T07:30:02Z",
          forcedClose: {
            closedByUserId: "u1",
            closedAt: "2026-10-17T10:01:00Z",
            closedVia: "console",
            closedFromTerminalLabel: null,
            openedOnTerminalLabel: TERMINAL,
            forcedReason: "Till died with the shift open",
            cashCount: "not_counted",
          },
        },
        201,
      ),
    );
  });
  return calls;
}

test("S1: a blocked retire leads to the open shifts, the close without a count, and then the retire is allowed", async ({
  page,
  t,
}) => {
  const calls = await mockStuckTill(page, "owner");
  await page.goto(`/devices/${DEVICE_1}`);

  // The retire is blocked by the open shift, and the panel offers the one next step.
  await page.getByRole("button", { name: t("devices.actions.retire") }).click();
  let drawer = page.getByRole("dialog");
  await drawer.getByLabel(t("devices.retire.reason")).fill("End of life");
  await drawer.getByRole("button", { name: t("devices.flow.review") }).click();
  await expect(drawer.getByText(t("devices.impact.blocked.cashSessionRetire"))).toBeVisible();
  await drawer.getByRole("link", { name: t("forceActions.deviceLink") }).click();
  // The retire form holds typed work, so leaving it asks first (RT-268): the operator discards it.
  await page.getByRole("button", { name: t("shell.leave.discard") }).click();

  // The store's open shifts, with the server's verdict as text.
  await expect(page).toHaveURL(new RegExp(`/stores/${DUBAI_STORE}/open-shifts$`));
  await expect(page.getByText(t("forceActions.openShifts.verdict.eligible"))).toBeVisible();
  await page
    .getByRole("button", { name: t("forceActions.openShifts.openLabel", { terminal: TERMINAL }) })
    .click();

  // The dialog starts on Cancel and shows the preview.
  const dialog = page.getByRole("dialog", { name: t("forceActions.close.title") });
  await expect(dialog.getByText(t("forceActions.close.drawerUnaccounted"))).toBeVisible();
  await expect(dialog.getByRole("button", { name: t("forceActions.close.cancel") })).toBeFocused();
  await expect(dialog.getByRole("button", { name: t("forceActions.close.commit") })).toBeDisabled();

  await dialog.getByLabel(t("forceActions.close.reason.label")).fill("Till died with the shift open");
  await dialog.getByRole("checkbox", { name: t("forceActions.close.acknowledge") }).check();
  await dialog.getByRole("button", { name: t("forceActions.close.commit") }).click();
  await expect(dialog.getByText(t("forceActions.close.success"))).toBeVisible();

  expect(calls.close).toHaveLength(1);
  expect(calls.close[0].body).toEqual({
    forcedReason: "Till died with the shift open",
    previewFingerprint: FINGERPRINT,
  });
  expect(calls.close[0].key).toBeTruthy();

  await dialog.getByRole("button", { name: t("forceActions.close.done") }).click();
  await expect(page.getByText(t("forceActions.openShifts.empty"))).toBeVisible();

  // Back on the device, the server now allows the retire.
  await page.goto(`/devices/${DEVICE_1}`);
  await page.getByRole("button", { name: t("devices.actions.retire") }).click();
  drawer = page.getByRole("dialog");
  await drawer.getByLabel(t("devices.retire.reason")).fill("End of life");
  await drawer.getByRole("button", { name: t("devices.flow.review") }).click();
  await expect(drawer.getByText(t("devices.impact.verdict.allowed"))).toBeVisible();
});

test("S2: the dialog has no serious accessibility violation and keeps Tab inside, in both locales", async ({
  page,
  t,
  appLocale,
}) => {
  await mockStuckTill(page, "owner");
  await page.goto(`/stores/${DUBAI_STORE}/open-shifts`);
  await page
    .getByRole("button", { name: t("forceActions.openShifts.openLabel", { terminal: TERMINAL }) })
    .click();
  const dialog = page.getByRole("dialog", { name: t("forceActions.close.title") });
  await expect(dialog.getByText(t("forceActions.close.drawerUnaccounted"))).toBeVisible();
  // Arabic is right-to-left: the document direction is what the dialog inherits.
  await expect(page.locator("html")).toHaveAttribute("dir", appLocale === "ar" ? "rtl" : "ltr");
  await expectNoAxeViolations(page, "force-close dialog");

  // Tab wraps inside the modal; Escape cancels it.
  await dialog.getByLabel(t("forceActions.close.reason.label")).fill("x");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("S3: a store_manager sees neither the device next step nor the close action", async ({ page, t }) => {
  await mockStuckTill(page, "store_manager");
  await page.goto(`/devices/${DEVICE_1}`);
  await page.getByRole("button", { name: t("devices.actions.retire") }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel(t("devices.retire.reason")).fill("End of life");
  await drawer.getByRole("button", { name: t("devices.flow.review") }).click();
  await expect(drawer.getByText(t("devices.impact.blocked.cashSessionRetire"))).toBeVisible();
  await expect(drawer.getByRole("link", { name: t("forceActions.deviceLink") })).toHaveCount(0);

  // The page itself reads as not available (the server's uniform 404), with no action.
  await page.goto(`/stores/${DUBAI_STORE}/open-shifts`);
  await expect(page.getByText(t("forceActions.openShifts.notAvailable"))).toBeVisible();
  await expect(page.getByRole("button", { name: t("forceActions.openShifts.open") })).toHaveCount(0);
});

test("S3b: inside a support session the close action is not offered", async ({ page, t }) => {
  await mockStuckTill(page, "owner", { id: "ss-1", expires_at: "2099-01-01T00:00:00Z" });
  await page.goto(`/stores/${DUBAI_STORE}/open-shifts`);
  await page.waitForLoadState("networkidle");
  // The tenant surface is not shown in a support session (RT-781); either way no close control exists.
  await expect(
    page.getByRole("button", { name: t("forceActions.openShifts.openLabel", { terminal: TERMINAL }) }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: t("forceActions.close.title") })).toHaveCount(0);
});
