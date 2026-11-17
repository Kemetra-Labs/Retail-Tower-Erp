import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1441 (U2) E2E against mocked Backend-Core (C-5): the owner's guarded store deletion.
 *   S1 a clean store: the page reads nothing for the delete until the modal opens, then the preview,
 *      reason and password lead to the delete (re-auth first, then the delete with the grant and the
 *      preview's fingerprint), and the owner returns to the store list.
 *   S2 a store with an open shift is refused, with the link to the open shifts; and a 409 from the
 *      server at the confirm shows the same refusal. The server's verdicts are the only verdicts.
 *   S3 the dialog starts on Cancel, is axe-clean, keeps Tab inside, and works in both locales
 *      (Arabic is RTL).
 *   S4 hiding: no delete for a tenant_admin (the server answers 403 anyway).
 * RT-399: runs in both locales; copy comes from the catalog (`t`).
 */

const STORE = "0198a0c4-0000-7000-8000-000000000a01";
const SHIFT = "0198a0c4-0000-7000-8000-000000000b01";
const DEVICE = "0198a0c4-0000-7000-8000-000000000d01";
const FINGERPRINT = "3f0c8a5e1b7d4c2a9e6f0b1d8c7a5e4f2b3d9c6a1e8f7b0d5c4a3e2f1b9d8c7a";

function ctx(role: string) {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: null,
    active_role_code: role,
    support_session: null,
    memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: role }],
  };
}

const store = {
  id: STORE,
  tenant_id: "t1",
  code: "DXB",
  name: "Dubai Mall",
  timezone: "Asia/Dubai",
  is_active: true,
};

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

type Blocker = { code: string; count: number };

function previewBody(blockers: Blocker[]) {
  return {
    store: { storeId: STORE, code: "DXB", name: "Dubai Mall", isActive: true },
    openShifts: blockers.some((b) => b.code === "store_has_open_shift")
      ? [
          {
            shiftId: SHIFT,
            openedAt: "2026-11-16T08:00:00Z",
            terminalLabel: "till-A",
            forceCloseEligible: true,
          },
        ]
      : [],
    devices: [
      {
        deviceId: DEVICE,
        label: "till-A",
        trustState: "retired",
        lastSeenAt: "2026-11-16T09:00:00Z",
        queue: { pending: 0, deadLetter: 0, held: 0 },
      },
    ],
    openCountSessions: [],
    warehouseMappings: [{ warehouseRef: "WH-1" }],
    singleStoreMembers: [],
    offersRebuiltCount: 1,
    effects: {
      willChange: ["store_hidden_from_lists", "devices_refused_immediately"],
      willNotChange: ["sales_unchanged", "warehouse_mapping_kept"],
    },
    blockers,
    canDelete: blockers.length === 0,
    reversible: false,
    reversibleAlternative: "suspend_store",
    caveats: ["offline_facts_not_visible"],
    previewFingerprint: FINGERPRINT,
    evaluatedAt: "2026-11-17T10:00:00Z",
  };
}

interface Calls {
  previews: number;
  reauth: unknown[];
  deletes: { body: unknown; key: string | undefined }[];
  storeReads: number;
}

interface Options {
  blockers?: Blocker[];
  /** The delete answers 409 with this guard even though the preview was clean. */
  deleteConflict?: Blocker[];
}

/** Mocked Backend-Core: the store, its preview, the re-authentication and the delete. */
async function mockStore(page: Page, role: string, opts: Options = {}): Promise<Calls> {
  const calls: Calls = { previews: 0, reauth: [], deletes: [], storeReads: 0 };
  let deleted = false;
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(role))));
  await page.route("**/api/v1/stores", (r) => r.fulfill(json(deleted ? [] : [store])));
  await page.route(`**/api/v1/stores/${STORE}`, (r) => {
    calls.storeReads += 1;
    return r.fulfill(deleted ? json({}, 404) : json(store));
  });
  await page.route(`**/api/v1/stores/${STORE}/deletion-preview`, (r) => {
    calls.previews += 1;
    return r.fulfill(json(previewBody(opts.blockers ?? [])));
  });
  await page.route("**/api/v1/auth/reauth", (r) => {
    calls.reauth.push(r.request().postDataJSON());
    return r.fulfill(
      json({
        reauthToken: "grant-1",
        purpose: "store_deletion",
        storeId: STORE,
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    );
  });
  await page.route(`**/api/v1/stores/${STORE}/deletion`, (r) => {
    calls.deletes.push({
      body: r.request().postDataJSON(),
      key: r.request().headers()["idempotency-key"],
    });
    if (opts.deleteConflict) {
      return r.fulfill(
        json(
          {
            error: {
              code: opts.deleteConflict[0].code,
              message: "Refused",
              request_id: "req-409",
              details: { blockers: opts.deleteConflict },
            },
          },
          409,
        ),
      );
    }
    deleted = true;
    return r.fulfill(json({ storeId: STORE, deletedAt: "2026-11-17T10:05:00Z" }));
  });
  return calls;
}

test("S1: a clean store is deleted after the preview, the reason and the password, and the owner returns to the list", async ({
  page,
  t,
}) => {
  const calls = await mockStore(page, "owner");
  await page.goto(`/stores/${STORE}`);

  // The zone offers the reversible alternative first, then the delete; nothing was read for it yet.
  const zone = page.getByRole("region", { name: t("storeDeletion.zone.title") });
  await expect(zone.getByText(t("storeDeletion.zone.suspendInstead"))).toBeVisible();
  const buttons = zone.getByRole("button");
  await expect(buttons.nth(0)).toHaveText(t("stores.status.suspend"));
  await expect(buttons.nth(1)).toHaveText(t("storeDeletion.zone.delete"));
  await page.waitForLoadState("networkidle");
  expect(calls.previews).toBe(0);

  await buttons.nth(1).click();
  const dialog = page.getByRole("dialog", { name: t("storeDeletion.title") });
  await expect(dialog.getByText(t("storeDeletion.irreversible"))).toBeVisible();
  await expect(
    dialog.getByText(t("storeDeletion.effect.willChange.store_hidden_from_lists")),
  ).toBeVisible();
  expect(calls.previews).toBe(1);
  await expect(dialog.getByRole("button", { name: t("storeDeletion.cancel") })).toBeFocused();
  await expect(dialog.getByRole("button", { name: t("storeDeletion.commit") })).toBeDisabled();

  await dialog.getByLabel(t("storeDeletion.reason.label")).fill("Closed for good");
  await dialog.getByLabel(t("storeDeletion.password.label")).fill("correct horse");
  await dialog.getByRole("button", { name: t("storeDeletion.commit") }).click();
  await expect(dialog.getByText(t("storeDeletion.success"))).toBeVisible();

  expect(calls.reauth).toEqual([
    { purpose: "store_deletion", storeId: STORE, password: "correct horse" },
  ]);
  expect(calls.deletes).toHaveLength(1);
  expect(calls.deletes[0].body).toEqual({
    reason: "Closed for good",
    previewFingerprint: FINGERPRINT,
    reauthToken: "grant-1",
  });
  expect(calls.deletes[0].key).toBeTruthy();

  const readsBefore = calls.storeReads;
  await dialog.getByRole("button", { name: t("storeDeletion.backToList") }).click();
  await expect(page).toHaveURL(/\/stores$/);
  // The deleted store was not read again (that would be a 404 behind the list).
  expect(calls.storeReads).toBe(readsBefore);
});

test("S2: a store with an open shift is refused, with the link to its open shifts", async ({
  page,
  t,
}) => {
  const calls = await mockStore(page, "owner", {
    blockers: [{ code: "store_has_open_shift", count: 1 }],
  });
  await page.goto(`/stores/${STORE}`);
  await page.getByRole("button", { name: t("storeDeletion.zone.delete") }).click();
  const dialog = page.getByRole("dialog", { name: t("storeDeletion.title") });

  await expect(dialog.getByText(t("storeDeletion.blockedIntro"))).toBeVisible();
  await expect(
    dialog.getByText(t("storeDeletion.blocker.store_has_open_shift", { count: 1 })),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: t("storeDeletion.commit") })).toHaveCount(0);
  await expect(dialog.getByLabel(t("storeDeletion.password.label"))).toHaveCount(0);
  expect(calls.deletes).toHaveLength(0);

  const link = dialog.getByRole("link", { name: t("forceActions.storeLink") });
  await expect(link).toHaveAttribute("href", `/stores/${STORE}/open-shifts`);
});

test("S2b: a guard the server raises at the confirm shows the same refusal and deletes nothing", async ({
  page,
  t,
}) => {
  const calls = await mockStore(page, "owner", {
    deleteConflict: [{ code: "store_has_open_shift", count: 1 }],
  });
  await page.goto(`/stores/${STORE}`);
  await page.getByRole("button", { name: t("storeDeletion.zone.delete") }).click();
  const dialog = page.getByRole("dialog", { name: t("storeDeletion.title") });
  await dialog.getByLabel(t("storeDeletion.reason.label")).fill("Closed for good");
  await dialog.getByLabel(t("storeDeletion.password.label")).fill("pw");
  await dialog.getByRole("button", { name: t("storeDeletion.commit") }).click();

  await expect(dialog.getByText(t("storeDeletion.blockedIntro"))).toBeVisible();
  await expect(dialog.getByRole("button", { name: t("storeDeletion.commit") })).toHaveCount(0);
  expect(calls.deletes).toHaveLength(1);
});

test("S3: the dialog has no serious accessibility violation, keeps Tab inside, and is RTL in Arabic", async ({
  page,
  t,
  appLocale,
}) => {
  await mockStore(page, "owner");
  await page.goto(`/stores/${STORE}`);
  await page.getByRole("button", { name: t("storeDeletion.zone.delete") }).click();
  const dialog = page.getByRole("dialog", { name: t("storeDeletion.title") });
  await expect(dialog.getByText(t("storeDeletion.irreversible"))).toBeVisible();
  await expect(
    dialog.getByText(t("storeDeletion.effect.willChange.store_hidden_from_lists")),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", appLocale === "ar" ? "rtl" : "ltr");
  await expectNoAxeViolations(page, "store deletion dialog");

  // Tab wraps inside the modal; Escape cancels it and focus returns to the opener.
  await dialog.getByLabel(t("storeDeletion.reason.label")).fill("x");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: t("storeDeletion.zone.delete") })).toBeFocused();
});

test("S3b: the danger zone itself has no serious accessibility violation", async ({ page, t }) => {
  await mockStore(page, "owner");
  await page.goto(`/stores/${STORE}`);
  await expect(page.getByRole("region", { name: t("storeDeletion.zone.title") })).toBeVisible();
  await expectNoAxeViolations(page, "store detail with the danger zone");
});

test("S4: a tenant_admin sees no delete, and the delete preview is never read", async ({
  page,
  t,
}) => {
  const calls = await mockStore(page, "tenant_admin");
  await page.goto(`/stores/${STORE}`);
  await expect(page.getByRole("heading", { name: "Dubai Mall", level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: t("storeDeletion.zone.delete") })).toHaveCount(0);
  await expect(page.getByRole("region", { name: t("storeDeletion.zone.title") })).toHaveCount(0);
  expect(calls.previews).toBe(0);
});
