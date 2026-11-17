import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_1, DUBAI_STORE, SHIFT_OPEN, detail } from "../unit/device-fixtures";
import { impact, openShift } from "../unit/device-lifecycle-fixtures";
import { type Page, test } from "../e2e/fixtures";

/**
 * RT-1440 (U1): evidence captures of the owner's force close of a stuck shift, taken in CI only
 * (owner rule: no browser on the owner's laptop), through the `admin-captures` workflow with
 * Backend-Core mocked. Saved in the locale project that runs it (Arabic and English):
 *   open-shifts        the store's open shifts with the server's verdict as text
 *   dialog-eligible    the close-without-a-count dialog with the preview, the reason and the acknowledgement
 *   dialog-blocked     a live drawer: the server's blocker as persistent text, no commit
 *   dialog-done        after the close
 *   force-closed-list  the read-only audit-backed list
 *   device-next-step   the device impact panel's next step for a blocked retire
 * It records what it shows; it fails only if the page crashes.
 */

const OUT = process.env.CAPTURE_DIR ?? "playwright-report/captures";
const TICKET = "RT-1440";
mkdirSync(OUT, { recursive: true });

const FINGERPRINT = "3f0c8a5e1b7d4c2a9e6f0b1d8c7a5e4f2b3d9c6a1e8f7b0d5c4a3e2f1b9d8c7a";
const TERMINAL = String(detail().label);
const CASHIER = "0190f000-0000-7000-8000-0000000000c1";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function shot(page: Page, name: string, locale: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${TICKET}__${name}__${locale}.png`), fullPage: true });
}

function shift(eligible: boolean, id = SHIFT_OPEN) {
  return {
    shiftId: id,
    storeId: DUBAI_STORE,
    source: "cash_up",
    lifecycleState: "open",
    openedAt: "2026-10-17T07:30:00Z",
    ageMinutes: 880,
    cashier: { userId: CASHIER, displayName: eligible ? null : "Jane Smith" },
    terminal: {
      deviceId: DEVICE_1,
      label: eligible ? TERMINAL : "Till 3",
      lastSeenAt: "2026-10-17T07:50:00Z",
      trustState: "active",
    },
    verdict: {
      eligible,
      stale: true,
      liveOperatorSession: !eligible,
      liveCashierAdmission: false,
      blockers: eligible ? [] : ["live_operator_session"],
    },
  };
}

function preview(eligible: boolean) {
  return {
    shift: shift(eligible),
    recorded: {
      currencyCode: "EGP",
      openingFloat: "500.00",
      cashMovementCount: 3,
      lastCashMovementReceivedAt: "2026-10-17T09:40:00Z",
      saleCount: 41,
      refundExecutionCount: 1,
    },
    effects: {
      willChange: [
        "shift_closed_not_counted",
        "no_cash_up_recorded",
        "terminal_may_open_new_shift",
        "device_retire_replace_move_unblocked",
      ],
      willNotChange: ["sales_unchanged", "refunds_unchanged", "cash_movements_unchanged", "stock_unchanged", "erp_documents_unchanged"],
    },
    reversible: false,
    drawerCashUnaccounted: true,
    caveats: ["offline_facts_not_visible", "terminal_not_notified"],
    previewFingerprint: FINGERPRINT,
    evaluatedAt: "2026-10-17T10:00:00Z",
  };
}

async function mock(page: Page): Promise<void> {
  const store = { id: DUBAI_STORE, tenant_id: "t1", code: "DXB", name: "Dubai Mall", timezone: "Asia/Dubai", is_active: true };
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/device-health**", (r) => r.fulfill({ status: 404 }));
  await page.route("**/api/v1/context/me", (r) =>
    r.fulfill(
      json({
        user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
        active_tenant: { id: "t1", name: "Northstar Retail" },
        active_store: null,
        active_role_code: "owner",
        support_session: null,
        memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: "owner" }],
      }),
    ),
  );
  await page.route("**/api/v1/stores", (r) => r.fulfill(json([store])));
  await page.route(`**/api/v1/stores/${DUBAI_STORE}`, (r) => r.fulfill(json(store)));
  await page.route(`**/api/v1/devices/${DEVICE_1}`, (r) => r.fulfill(json(detail())));
  await page.route("**/api/v1/pairing-codes?**", (r) => r.fulfill(json({ items: [], nextCursor: null })));
  await page.route(`**/api/v1/devices/${DEVICE_1}/impact?**`, (r) =>
    r.fulfill(
      json(
        impact({
          action: "retire",
          revokeReason: "retired",
          verdict: "blocked",
          blockCode: "unresolved_cash_session",
          openShift: openShift(),
        }),
      ),
    ),
  );
  await page.route(`**/api/v1/stores/${DUBAI_STORE}/open-shifts`, (r) =>
    r.fulfill(
      json({
        storeId: DUBAI_STORE,
        evaluatedAt: "2026-10-17T10:00:00Z",
        staleThresholdMinutes: 15,
        items: [shift(true), shift(false, "0190f000-0000-7000-8000-0000000000b8")],
      }),
    ),
  );
  await page.route(`**/api/v1/shifts/${SHIFT_OPEN}/force-close-preview`, (r) => r.fulfill(json(preview(true))));
  await page.route("**/api/v1/shifts/0190f000-0000-7000-8000-0000000000b8/force-close-preview", (r) =>
    r.fulfill(json(preview(false))),
  );
  await page.route(`**/api/v1/shifts/${SHIFT_OPEN}/force-close`, (r) => r.fulfill(json({ shiftId: SHIFT_OPEN, status: "force_closed" }, 201)));
  await page.route("**/api/v1/audit/events**", (r) =>
    r.fulfill(
      json({
        items: [
          {
            id: "0190f000-0000-7000-8000-0000000000f1",
            occurred_at: "2026-10-17T10:01:00Z",
            actor_user_id: "u1",
            tenant_id: "t1",
            store_id: DUBAI_STORE,
            action: "shift.force_closed",
            kind: "change",
            target_type: "shift",
            target_id: SHIFT_OPEN,
            metadata: { shift_id: SHIFT_OPEN, channel: "console", actor_role: "owner", shift_age_minutes: 880 },
          },
          {
            id: "0190f000-0000-7000-8000-0000000000f2",
            occurred_at: "2026-10-12T15:20:00Z",
            actor_user_id: null,
            tenant_id: "t1",
            store_id: DUBAI_STORE,
            action: "shift.force_closed",
            kind: "change",
            target_type: "shift",
            target_id: "0190f000-0000-7000-8000-0000000000b7",
            metadata: { shift_id: "0190f000-0000-7000-8000-0000000000b7", channel: "pos", actor_role: "store_manager", shift_age_minutes: 1500 },
          },
        ],
        next_cursor: null,
      }),
    ),
  );
}

test("RT-1440 open shifts and the close-without-a-count dialog", async ({ page, t, appLocale }) => {
  await mock(page);
  await page.goto(`/stores/${DUBAI_STORE}/open-shifts`);
  await page.getByText(t("forceActions.openShifts.verdict.eligible")).waitFor();
  await shot(page, "open-shifts", appLocale);

  await page.getByRole("button", { name: t("forceActions.openShifts.openLabel", { terminal: TERMINAL }) }).click();
  const dialog = page.getByRole("dialog", { name: t("forceActions.close.title") });
  await dialog.getByText(t("forceActions.close.drawerUnaccounted")).waitFor();
  await dialog.getByLabel(t("forceActions.close.reason.label")).fill("Till died with the shift open");
  await dialog.getByRole("checkbox", { name: t("forceActions.close.acknowledge") }).check();
  await shot(page, "dialog-eligible", appLocale);

  await dialog.getByRole("button", { name: t("forceActions.close.commit") }).click();
  await dialog.getByText(t("forceActions.close.success")).waitFor();
  await shot(page, "dialog-done", appLocale);
});

test("RT-1440 a live drawer is blocked with its reason", async ({ page, t, appLocale }) => {
  await mock(page);
  await page.route(`**/api/v1/stores/${DUBAI_STORE}/open-shifts`, (r) =>
    r.fulfill(
      json({
        storeId: DUBAI_STORE,
        evaluatedAt: "2026-10-17T10:00:00Z",
        staleThresholdMinutes: 15,
        items: [shift(false)],
      }),
    ),
  );
  await page.route(`**/api/v1/shifts/${SHIFT_OPEN}/force-close-preview`, (r) => r.fulfill(json(preview(false))));
  await page.goto(`/stores/${DUBAI_STORE}/open-shifts`);
  await page.getByText(t("forceActions.openShifts.verdict.blocked")).waitFor();
  await shot(page, "open-shifts-blocked", appLocale);
});

test("RT-1440 the force-closed list and the device next step", async ({ page, t, appLocale }) => {
  await mock(page);
  await page.goto("/shifts/force-closed");
  await page.getByText(t("forceActions.closed.channel.console")).first().waitFor();
  await shot(page, "force-closed-list", appLocale);

  await page.goto(`/devices/${DEVICE_1}`);
  await page.getByRole("button", { name: t("devices.actions.retire") }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel(t("devices.retire.reason")).fill("End of life");
  await drawer.getByRole("button", { name: t("devices.flow.review") }).click();
  await drawer.getByRole("link", { name: t("forceActions.deviceLink") }).waitFor();
  await shot(page, "device-next-step", appLocale);
});
