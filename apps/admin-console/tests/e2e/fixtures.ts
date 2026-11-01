import { test as base } from "@playwright/test";
import { registerCatalog } from "../../src/i18n/catalogs";
import type { Locale } from "../../src/i18n/locale";
import { ar } from "../../src/i18n/messages/ar";
import { en } from "../../src/i18n/messages/en";
import { roleKey } from "../../src/i18n/roles";
import { type MessageKey, type Params, translate } from "../../src/i18n/translate";

// RT-962: the app fetches catalogs on demand; the specs look up both locales.
registerCatalog("ar", ar);
registerCatalog("en", en);

/**
 * RT-399: every journey runs in both locales. Each Playwright project sets
 * `appLocale` (playwright.config.ts), and specs select by the same catalog
 * copy the app renders: `t("shell.nav.stores")` is «المتاجر» in the Arabic
 * project and "Stores" in the English one. Data from the mocked API (tenant
 * names, emails, IDs) stays as authored.
 *
 * Before any page script runs, the browser is seeded as one whose users have
 * all chosen `appLocale`: the last-choice mirror (read by the pre-paint script)
 * and any per-user key that is still unset answer `appLocale`. A choice made
 * during the test (the language switch) writes real keys, which then win, so
 * persistence across reloads is tested for real.
 */

export interface LocaleFixtures {
  /** The locale this project runs the journeys in. */
  appLocale: Locale;
  /** Catalog lookup in `appLocale`. */
  t: (key: MessageKey, params?: Params) => string;
  /** The localized label for a role code. */
  roleName: (code: string) => string;
}

function seedLocale(locale: string): void {
  try {
    const LAST = "rt.locale.v1:last";
    const USER = "rt.locale.v1:user:";
    if (window.localStorage.getItem(LAST) === null) window.localStorage.setItem(LAST, locale);
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (this: Storage, key: string): string | null {
      const value = getItem.call(this, key);
      return value === null && key.startsWith(USER) ? locale : value;
    };
  } catch {
    // Storage blocked: the app falls back to its own default.
  }
}

export const test = base.extend<LocaleFixtures>({
  appLocale: ["ar", { option: true }],
  t: async ({ appLocale }, use) => {
    await use((key, params) => translate(appLocale, key, params));
  },
  roleName: async ({ appLocale }, use) => {
    await use((code) => translate(appLocale, roleKey(code)));
  },
  page: async ({ page, appLocale }, use) => {
    await page.addInitScript(seedLocale, appLocale);
    await use(page);
  },
});

export { expect } from "@playwright/test";
export type { Page } from "@playwright/test";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * RT-993: the Overview's `<h1>` greets the user by name («مرحبًا، {name}») and
 * is the page name («نظرة عامة») only when the context has no display name.
 * Specs find the Overview by either, in the locale `t` speaks.
 */
export function overviewHeading(
  page: import("@playwright/test").Page,
  t: (key: MessageKey, params?: Params) => string,
) {
  const [before, after] = t("overview.greeting", { name: "\u0000" }).split("\u0000");
  const name = new RegExp(
    `^(${escapeRegExp(t("shell.overview.title"))}|${escapeRegExp(before)}.+${escapeRegExp(after)})$`,
  );
  return page.getByRole("heading", { level: 1, name });
}
