import {
  __resetCatalogsForTests,
  __setCatalogLoaderForTests,
  hasCatalog,
  loadCatalog,
  registerCatalog,
} from "@/i18n/catalogs";
import { getLocale, saveLocale, setLocale } from "@/i18n/locale";
import { ar } from "@/i18n/messages/ar";
import { en } from "@/i18n/messages/en";
import { translate } from "@/i18n/translate";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * RT-962: only the active locale's catalog is loaded up front; the other one is
 * fetched with import() before the switch. The locale never flips to a
 * language whose catalog is missing.
 */

beforeEach(() => {
  __resetCatalogsForTests();
  registerCatalog("en", en);
  setLocale("en");
});

afterEach(() => {
  __resetCatalogsForTests();
  registerCatalog("ar", ar);
  registerCatalog("en", en);
});

describe("on-demand locale catalog (RT-962)", () => {
  test("the switch labels resolve for a locale whose catalog is not loaded", () => {
    expect(hasCatalog("ar")).toBe(false);
    expect(translate("ar", "locale.switch.name")).toBe(ar["locale.switch.name"]);
    expect(translate("ar", "locale.switch.action")).toBe(ar["locale.switch.action"]);
    expect(translate("en", "locale.switch.name")).toBe(en["locale.switch.name"]);
  });

  test("any other key of an unloaded locale returns the key instead of throwing", () => {
    expect(translate("ar", "app.title")).toBe("app.title");
  });

  test("switching waits for the catalog, then flips", async () => {
    saveLocale(undefined, "ar");
    expect(getLocale()).toBe("en");
    await loadCatalog("ar");
    expect(hasCatalog("ar")).toBe(true);
    expect(getLocale()).toBe("ar");
    expect(translate("ar", "app.title")).toBe(ar["app.title"]);
  });

  test("a loaded catalog switches at once", () => {
    registerCatalog("ar", ar);
    saveLocale(undefined, "ar");
    expect(getLocale()).toBe("ar");
  });

  test("a failed load keeps the current locale and can be retried", async () => {
    __setCatalogLoaderForTests("ar", () => Promise.reject(new Error("offline")));
    saveLocale(undefined, "ar");
    await expect(loadCatalog("ar")).rejects.toThrow("offline");
    expect(getLocale()).toBe("en");
    __setCatalogLoaderForTests("ar", () => Promise.resolve(ar));
    await loadCatalog("ar");
    expect(hasCatalog("ar")).toBe(true);
  });
});
