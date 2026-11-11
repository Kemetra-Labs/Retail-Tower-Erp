import { expectNoAxeViolations } from "./axe";
import { type LocaleFixtures, type Page, expect, test } from "./fixtures";

type Tr = LocaleFixtures["t"];

/**
 * RT-1329: the Platform Console "POS pilot" page against the built SPA with a
 * mocked Backend-Core (no live lab run, no live activation). Runs in both locale
 * projects. The two reads are the RT-1328 shape (`{ items }` of PilotRelease /
 * PilotTenant); the writes answer with the statuses and codes of
 * `pos-pilot-releases.openapi.yaml`.
 */

const admin = {
  id: "u1",
  email: "ops@kemetra.test",
  display_name: "Ops Admin",
  is_platform_admin: true,
};
const ctx = (user: unknown, over: Record<string, unknown> = {}) => ({
  user,
  active_tenant: null,
  active_store: null,
  memberships: [],
  support_session: null,
  ...over,
});

const DELTA = "0190f000-0000-7000-8000-0000000000d1";
const NILE = "0190f000-0000-7000-8000-0000000000d2";
const FAJR = "0190f000-0000-7000-8000-0000000000d3";
const tenants = [
  { id: DELTA, slug: "delta-markets", name: "أسواق الدلتا" },
  { id: NILE, slug: "nile-pharma", name: "Nile Pharma" },
  { id: FAJR, slug: "fajr-supermarket", name: "سوبرماركت الفجر" },
];

const R013 = "0190f000-0000-7000-8000-00000000a013";
const release = (id: string, version: string, over: Record<string, unknown> = {}) => ({
  releaseId: id,
  version,
  sha256: "abcdef012345".padEnd(64, "0"),
  sizeBytes: 104_857_600,
  publisher: "CN=Kemetra Pilot",
  signingClass: "pilot",
  attestationRef: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/attestations/42",
  sourceSha: "c".repeat(40),
  approved: true,
  approvedBy: "kemetra-owner",
  approvedAt: "2026-11-10T10:00:00Z",
  promotionRunUrl: "https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/123",
  artifactVersionId: "v1",
  registeredAt: "2026-11-10T10:05:00Z",
  withdrawnAt: null,
  withdrawnBy: null,
  activatedAt: null,
  activatedByUserId: null,
  ...over,
});
const releases = [
  release(R013, "0.1.3"),
  release("0190f000-0000-7000-8000-00000000a012", "0.1.2", {
    activatedAt: "2026-10-20T09:00:00Z",
    withdrawnAt: "2026-10-30T09:00:00Z",
    withdrawnBy: "kemetra-owner",
  }),
];
const pilot = (tenantId: string) => ({
  tenantId,
  addedAt: "2026-11-11T08:00:00Z",
  addedByUserId: "0190f000-0000-7000-8000-0000000000aa",
});

/** The page isolates versions (LRI) and names (FSI) inside messages, as FilterBar does. */
const LTR = (v: string) => `⁦${v}⁩`;
const FSI = (v: string) => `⁨${v}⁩`;

const json = (status: number, body?: unknown) => ({
  status,
  contentType: "application/json",
  body: body === undefined ? "" : JSON.stringify(body),
});
const refusal = (code: string) => ({
  error: { code, message: "refused", request_id: "0190f000-0000-7000-8000-00000000ffff" },
});

interface Server {
  allowlist: string[];
  activations: string[];
  adds: string[];
  removes: string[];
  activateReply: { status: number; body?: unknown };
  reads: string[];
}

async function mock(page: Page, context: unknown): Promise<Server> {
  const server: Server = {
    allowlist: [NILE],
    activations: [],
    adds: [],
    removes: [],
    activateReply: { status: 200, body: release(R013, "0.1.3") },
    reads: [],
  };
  await page.route("**/api/v1/**", (r) => r.fulfill(json(200, [])));
  await page.route("**/api/v1/tenants", (r) => r.fulfill(json(200, tenants)));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(200, context)));
  await page.route("**/api/v1/platform/pos-pilot-releases", (r) => {
    server.reads.push("releases");
    return r.fulfill(json(200, { items: releases }));
  });
  await page.route("**/api/v1/platform/pos-pilot-releases/*/activate", (r) => {
    server.activations.push(r.request().url());
    return r.fulfill(json(server.activateReply.status, server.activateReply.body));
  });
  await page.route("**/api/v1/platform/pos-pilot-tenants", (r) => {
    server.reads.push("tenants");
    return r.fulfill(json(200, { items: server.allowlist.map(pilot) }));
  });
  await page.route("**/api/v1/platform/pos-pilot-tenants/*", (r) => {
    const id = r.request().url().split("/").pop() ?? "";
    if (r.request().method() === "PUT") {
      server.adds.push(id);
      const known = server.allowlist.includes(id);
      if (!known) server.allowlist.push(id);
      return r.fulfill(json(known ? 200 : 201, pilot(id)));
    }
    server.removes.push(id);
    server.allowlist = server.allowlist.filter((x) => x !== id);
    return r.fulfill({ status: 204, body: "" });
  });
  return server;
}

async function darkTheme(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem("rt.theme.v1:user:u1", "dark");
    localStorage.setItem("rt.theme.v1:last", "dark");
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
}

async function openPage(page: Page, t: Tr): Promise<void> {
  await page.goto("/platform/pos-pilot");
  await expect(page.getByRole("heading", { level: 1, name: t("posPilot.title") })).toBeVisible();
  await expect(page.getByRole("table", { name: t("posPilot.releases.caption") })).toBeVisible();
  await expect(page.getByRole("table", { name: t("posPilot.allowlist.caption") })).toBeVisible();
}

for (const width of [1280, 390]) {
  test(`page at ${width}px: both lists, no Withdraw; axe light and dark`, async ({ page, t }) => {
    await page.setViewportSize({ width, height: 900 });
    await mock(page, ctx(admin));
    await openPage(page, t);
    await expect(
      page.getByRole("button", { name: t("posPilot.releases.activateFor", { version: "0.1.3" }) }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /withdraw|سحب/i })).toHaveCount(0);
    await expect(page.getByText("Nile Pharma")).toBeVisible();
    await expectNoAxeViolations(page, `pos pilot light ${width}`);
    await darkTheme(page);
    await openPage(page, t);
    await expectNoAxeViolations(page, `pos pilot dark ${width}`);
  });
}

test("the Platform nav reaches the page", async ({ page, t }) => {
  await mock(page, ctx(admin));
  await page.goto("/platform/tenants");
  await page
    .getByRole("link", { name: t("platform.nav.posPilot") })
    .first()
    .click();
  await expect(page).toHaveURL(/\/platform\/pos-pilot$/);
  await expect(page.getByRole("heading", { level: 1, name: t("posPilot.title") })).toBeVisible();
});

test("activate: confirm step, one call, the success message; axe on the confirm", async ({
  page,
  t,
}) => {
  const server = await mock(page, ctx(admin));
  await openPage(page, t);
  await page
    .getByRole("button", { name: t("posPilot.releases.activateFor", { version: "0.1.3" }) })
    .click();
  const confirm = page.getByRole("region", { name: t("posPilot.activate.label") });
  await expect(confirm).toBeVisible();
  await expectNoAxeViolations(page, "activate confirm");
  expect(server.activations).toHaveLength(0);
  await confirm.getByRole("button", { name: t("posPilot.activate.confirm") }).click();
  await expect(
    page.getByText(t("posPilot.activate.done", { version: LTR("0.1.3") })),
  ).toBeVisible();
  expect(server.activations).toEqual([
    expect.stringContaining(`/api/v1/platform/pos-pilot-releases/${R013}/activate`),
  ]);
});

for (const code of ["release_current_exists", "release_withdrawn"] as const) {
  test(`activate 409 ${code}: its own message; axe`, async ({ page, t }) => {
    const server = await mock(page, ctx(admin));
    server.activateReply = { status: 409, body: refusal(code) };
    await openPage(page, t);
    await page
      .getByRole("button", { name: t("posPilot.releases.activateFor", { version: "0.1.3" }) })
      .click();
    await page.getByRole("button", { name: t("posPilot.activate.confirm") }).click();
    const key =
      code === "release_current_exists"
        ? "posPilot.activate.currentExists"
        : "posPilot.activate.withdrawn";
    await expect(page.getByText(t(key, { version: LTR("0.1.3") }))).toBeVisible();
    expect(server.activations).toHaveLength(1);
    await expectNoAxeViolations(page, `activate ${code}`);
  });
}

test("add from the tenant list, then remove behind a confirm", async ({ page, t }) => {
  const server = await mock(page, ctx(admin));
  await openPage(page, t);
  await page.getByLabel(t("posPilot.add.label")).selectOption(FAJR);
  await page.getByRole("button", { name: t("posPilot.add.submit") }).click();
  await expect(
    page.getByText(t("posPilot.add.done", { name: FSI("سوبرماركت الفجر") })),
  ).toBeVisible();
  expect(server.adds).toEqual([FAJR]);
  const allowlist = page.getByRole("table", { name: t("posPilot.allowlist.caption") });
  await expect(allowlist.getByText("سوبرماركت الفجر")).toBeVisible();

  await page
    .getByRole("button", { name: t("posPilot.allowlist.removeFor", { name: "Nile Pharma" }) })
    .click();
  const confirm = page.getByRole("region", { name: t("posPilot.remove.label") });
  await expectNoAxeViolations(page, "remove confirm");
  await confirm.getByRole("button", { name: t("posPilot.remove.confirm") }).click();
  await expect(
    page.getByText(t("posPilot.remove.done", { name: FSI("Nile Pharma") })),
  ).toBeVisible();
  expect(server.removes).toEqual([NILE]);
  await expect(allowlist.getByText("Nile Pharma")).toHaveCount(0);
});

for (const role of ["owner", "tenant_admin", "store_manager"]) {
  test(`a tenant user (${role}) cannot reach the page and no pilot read is sent`, async ({
    page,
    t,
  }) => {
    const server = await mock(
      page,
      ctx(
        { ...admin, is_platform_admin: false },
        {
          active_tenant: { id: DELTA, name: "أسواق الدلتا" },
          active_role_code: role,
          memberships: [{ tenant_id: DELTA, tenant_name: "أسواق الدلتا", role_code: role }],
        },
      ),
    );
    await page.goto("/platform/pos-pilot");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: t("posPilot.title") })).toHaveCount(0);
    expect(server.reads).toEqual([]);
  });
}
