import {
  CatalogReloadRequiredError,
  __resetCatalogsForTests,
  __setCatalogLoaderForTests,
  hasCatalog,
  loadCatalog,
  registerCatalog,
} from "@/i18n/catalogs";
import {
  LOCALE_LAST_KEY,
  __setReloadPageForTests,
  adoptUserLocale,
  getLocale,
  localeUserKey,
  saveLocale,
  setLocale,
} from "@/i18n/locale";
import { ar } from "@/i18n/messages/ar";
import { en } from "@/i18n/messages/en";
import type { Messages } from "@/i18n/messages/types";
import { translate } from "@/i18n/translate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
  window.localStorage.clear();
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

function deferred() {
  let resolve!: (m: Messages) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Messages>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("latest switch request wins (RT-979)", () => {
  test("a pending saveLocale(A) does not apply or persist after adoptUserLocale(B)", async () => {
    window.localStorage.setItem(localeUserKey("B"), "en");
    const slow = deferred();
    __setCatalogLoaderForTests("ar", () => slow.promise);
    saveLocale("A", "ar"); // pending: the ar catalog is not loaded
    adoptUserLocale("B"); // B's locale (en) is loaded and resolves first
    expect(getLocale()).toBe("en");
    expect(window.localStorage.getItem(LOCALE_LAST_KEY)).toBe("en");
    slow.resolve(ar);
    await flush();
    expect(hasCatalog("ar")).toBe(true);
    expect(getLocale()).toBe("en");
    expect(window.localStorage.getItem(localeUserKey("A"))).toBeNull();
    expect(window.localStorage.getItem(LOCALE_LAST_KEY)).toBe("en");
  });

  test("out-of-order resolution: the older request finishing last does not win", async () => {
    const firstAr = deferred();
    const secondEn = deferred();
    registerCatalog("ar", ar);
    __resetCatalogsForTests();
    __setCatalogLoaderForTests("ar", () => firstAr.promise);
    __setCatalogLoaderForTests("en", () => secondEn.promise);
    setLocale("en");
    saveLocale("u", "ar");
    saveLocale("u", "en"); // newer request, en catalog not loaded either
    secondEn.resolve(en);
    await flush();
    firstAr.resolve(ar);
    await flush();
    expect(getLocale()).toBe("en");
    expect(window.localStorage.getItem(localeUserKey("u"))).toBe("en");
    expect(window.localStorage.getItem(LOCALE_LAST_KEY)).toBe("en");
  });

  test("a failed adoptUserLocale load leaves the mirror and the screen unchanged", async () => {
    window.localStorage.setItem(LOCALE_LAST_KEY, "en");
    window.localStorage.setItem(localeUserKey("B"), "ar");
    __setCatalogLoaderForTests("ar", () => Promise.reject(new Error("offline")));
    adoptUserLocale("B");
    await flush();
    expect(window.localStorage.getItem(LOCALE_LAST_KEY)).toBe("en");
    expect(getLocale()).toBe("en");
  });

  test("a successful adoptUserLocale writes the mirror only after the catalog loaded", async () => {
    window.localStorage.setItem(LOCALE_LAST_KEY, "en");
    window.localStorage.setItem(localeUserKey("B"), "ar");
    const slow = deferred();
    __setCatalogLoaderForTests("ar", () => slow.promise);
    adoptUserLocale("B");
    expect(window.localStorage.getItem(LOCALE_LAST_KEY)).toBe("en");
    slow.resolve(ar);
    await flush();
    expect(window.localStorage.getItem(LOCALE_LAST_KEY)).toBe("ar");
    expect(getLocale()).toBe("ar");
  });
});

describe("a failed catalog load can be retried (RT-979)", () => {
  test("failing then succeeding loader: the later switch works", async () => {
    const loader = vi
      .fn<() => Promise<Messages>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(ar);
    __setCatalogLoaderForTests("ar", loader);
    saveLocale("u", "ar");
    await flush();
    expect(getLocale()).toBe("en");
    saveLocale("u", "ar");
    await flush();
    expect(getLocale()).toBe("ar");
    expect(window.localStorage.getItem(LOCALE_LAST_KEY)).toBe("ar");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test("failing twice tells the operator to reload: choice stored, page reloaded", async () => {
    const reload = vi.fn();
    __setReloadPageForTests(reload);
    __setCatalogLoaderForTests("ar", () => Promise.reject(new Error("cached failure")));
    saveLocale("u", "ar");
    await flush();
    expect(reload).not.toHaveBeenCalled();
    saveLocale("u", "ar");
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(getLocale()).toBe("en");
    expect(window.localStorage.getItem(localeUserKey("u"))).toBe("ar");
    await expect(loadCatalog("ar")).rejects.toBeInstanceOf(CatalogReloadRequiredError);
  });

  test("concurrent callers still share one fetch per locale", async () => {
    const slow = deferred();
    const loader = vi.fn(() => slow.promise);
    __setCatalogLoaderForTests("ar", loader);
    const a = loadCatalog("ar");
    const b = loadCatalog("ar");
    slow.resolve(ar);
    await Promise.all([a, b]);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
