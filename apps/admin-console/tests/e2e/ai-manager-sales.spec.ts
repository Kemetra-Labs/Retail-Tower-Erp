import { join } from "node:path";
import type { MessageKey } from "../../src/i18n/translate";
import {
  answerBody,
  apiError,
  refusalBody,
  unavailableBody,
} from "../unit/ai-manager-sales-fixtures";
import { expectNoAxeViolations } from "./axe";
import { type LocaleFixtures, type Page, expect, test } from "./fixtures";
import { type BuiltHarness, HARNESS_BASE, buildHarness } from "./harness/build";

/**
 * RT-1541 (W8 P-08) against a harness page that mounts the real Manager Sales panel with a MOCKED
 * Backend-Core (Playwright routes; C-5, no live API): the answer, a partial/stale answer, a
 * non-disclosing 404, an entitlement-unavailable state, the disabled (kill switch) state, a
 * refusal, the keyboard and live-region behaviour, and no WCAG 2.1 A/AA axe violation in light,
 * dark and forced colours. Runs once per locale (RT-399); copy comes from the catalog (`t`).
 * Set RT1541_SHOTS_DIR to also write 2x screenshots of the states.
 */
const PAGE = `${HARNESS_BASE}ai-manager-sales.html`;
const EXPLAIN = "**/api/v1/ai/manager-sales/explain";

test.use({ deviceScaleFactor: 2 });

let harness: BuiltHarness;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  harness = await buildHarness("ai-manager-sales.html");
});

test.afterAll(async () => {
  await harness?.dispose();
});

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function open(page: Page, role = "owner"): Promise<void> {
  await harness.serve(page);
  await page.goto(`${PAGE}?role=${role}`);
  await expect(page.getByRole("button", { name: /.+/ }).first()).toBeVisible();
}

async function ask(page: Page, t: LocaleFixtures["t"], chipKey: MessageKey): Promise<void> {
  await page.getByRole("button", { name: t(chipKey), exact: true }).click();
  await page.getByRole("button", { name: t("aiManagerSales.ask") }).click();
}

async function shot(page: Page, name: string, appLocale: string): Promise<void> {
  const dir = process.env.RT1541_SHOTS_DIR;
  if (!dir) return;
  await page.screenshot({ path: join(dir, `${name}-${appLocale}.png`), fullPage: true });
}

test("answer: restated scope, a semantic table of the server's figures, sources, axe in every mode", async ({
  page,
  t,
  appLocale,
}) => {
  await page.route(EXPLAIN, (r) => r.fulfill(json(answerBody())));
  await open(page);
  await ask(page, t, "aiManagerSales.chip.T04");
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveCount(4);
  await expect(table.getByText("1,250.50 EGP")).toBeVisible();
  await expect(table.getByText("0.6250")).toBeVisible();
  await expect(page.getByText(t("aiManagerSales.notice.receivedOnly"))).toBeVisible();
  await shot(page, "answer", appLocale);

  await expectNoAxeViolations(page, `answer ${appLocale} light`);
  await page.locator("details.ams-sources summary").click();
  await expectNoAxeViolations(page, `answer ${appLocale} light, sources open`);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expectNoAxeViolations(page, `answer ${appLocale} dark`);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.emulateMedia({ forcedColors: "active" });
  await expectNoAxeViolations(page, `answer ${appLocale} forced colours`);
});

test("partial and stale: the day in progress, received-only, a decline and the gaps", async ({
  page,
  t,
  appLocale,
}) => {
  await page.route(EXPLAIN, (r) =>
    r.fulfill(
      json(
        answerBody({
          notices: ["received_only", "day_in_progress", "scope_relative_ratio"],
          declined: ["partial_data_not_conclusive"],
          gaps: ["G-5"],
        }),
      ),
    ),
  );
  await open(page);
  await ask(page, t, "aiManagerSales.chip.T10");
  await expect(page.getByText(t("aiManagerSales.notice.receivedOnly"))).toBeVisible();
  await expect(page.getByText(t("aiManagerSales.notice.scopeRelativeRatio"))).toBeVisible();
  await expect(page.getByText(t("aiManagerSales.gap.g5"))).toBeVisible();
  await expect(
    page.getByText(
      t("aiManagerSales.decline.conclusive", { reason: t("aiManagerSales.reason.dayInProgress") }),
    ),
  ).toBeVisible();
  await shot(page, "partial", appLocale);
  await expectNoAxeViolations(page, `partial ${appLocale}`);
});

test("404 is one non-disclosing message and the panel stays usable", async ({
  page,
  t,
  appLocale,
}) => {
  await page.route(EXPLAIN, (r) => r.fulfill(json(apiError("not_found"), 404)));
  await open(page);
  await ask(page, t, "aiManagerSales.chip.T01");
  const result = page.locator(".ams-result");
  await expect(result.getByText(t("aiManagerSales.denied"))).toBeVisible();
  await expect(result.getByText(t("aiManagerSales.deniedHint"))).toBeVisible();
  await expect(result).not.toContainText(/exist|not found|outside|لا يوجد|غير موجود/i);
  await expect(page.getByRole("button", { name: t("aiManagerSales.ask") })).toBeEnabled();
  await shot(page, "denied-404", appLocale);
  await expectNoAxeViolations(page, `denied ${appLocale}`);
});

test("entitlement unavailable: a store_manager sees no plan detail; the kill switch says reports work", async ({
  page,
  t,
  appLocale,
}) => {
  await page.route(EXPLAIN, (r) => r.fulfill(json(unavailableBody("not_entitled"))));
  await open(page, "store_manager");
  await ask(page, t, "aiManagerSales.chip.T01");
  await expect(page.getByText(t("aiManagerSales.unavailable.generic"))).toBeVisible();
  await shot(page, "unavailable", appLocale);
  await expectNoAxeViolations(page, `unavailable ${appLocale}`);

  await page.unroute(EXPLAIN);
  await page.route(EXPLAIN, (r) => r.fulfill(json(unavailableBody("feature_disabled_system"))));
  await page.getByRole("button", { name: t("aiManagerSales.ask") }).click();
  await expect(page.getByText(t("aiManagerSales.unavailable.system"))).toBeVisible();
  await shot(page, "disabled", appLocale);
  await expectNoAxeViolations(page, `disabled ${appLocale}`);
});

test("refusal: persistent text, no table", async ({ page, t, appLocale }) => {
  await page.route(EXPLAIN, (r) => r.fulfill(json(refusalBody("finance_source_absent"))));
  await open(page);
  await ask(page, t, "aiManagerSales.chip.T01");
  await expect(page.getByText(t("aiManagerSales.refusal.finance"))).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await shot(page, "refusal", appLocale);
  await expectNoAxeViolations(page, `refusal ${appLocale}`);
});

test("keyboard: chips by Space, Ask by Enter, focus stays, the live region announces", async ({
  page,
  t,
}) => {
  const keys: string[] = [];
  await page.route(EXPLAIN, (r) => {
    keys.push(r.request().headers()["idempotency-key"] ?? "");
    return r.fulfill(json(answerBody()));
  });
  await open(page);
  const chip = page.getByRole("button", { name: t("aiManagerSales.chip.T04"), exact: true });
  await chip.focus();
  await page.keyboard.press("Space");
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  const askButton = page.getByRole("button", { name: t("aiManagerSales.ask") });
  await askButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("table")).toBeVisible();
  // Focus is not stolen by the result; the polite live region says it is ready.
  await expect(askButton).toBeFocused();
  await expect(page.locator("output[aria-live='polite']")).toHaveText(
    t("aiManagerSales.announce.answer"),
  );
  await page.keyboard.press("Enter");
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[0]).toMatch(/^[\x21-\x7E]{16,128}$/);
  expect(keys[0]).not.toBe(keys[1]);
});

test("client-side: a period over 31 days is refused before any request", async ({ page, t }) => {
  let calls = 0;
  await page.route(EXPLAIN, (r) => {
    calls += 1;
    return r.fulfill(json(answerBody()));
  });
  await open(page);
  await page.getByLabel(t("sales.filter.from")).fill("2026-09-01");
  await page.getByLabel(t("sales.filter.to")).fill("2026-11-01");
  await ask(page, t, "aiManagerSales.chip.T01");
  await expect(page.getByText(t("sales.filter.spanTooWide"))).toBeVisible();
  expect(calls).toBe(0);
});
