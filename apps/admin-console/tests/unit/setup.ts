import { registerCatalog } from "@/i18n/catalogs";
import { __setFallbackLocaleForTests, setLocale } from "@/i18n/locale";
import { ar } from "@/i18n/messages/ar";
import { en } from "@/i18n/messages/en";
import { beforeEach } from "vitest";

// RT-962: the app fetches catalogs on demand; the suites have both up front.
registerCatalog("ar", ar);
registerCatalog("en", en);

/**
 * RT-399: Arabic is the product default. The unit suites below were written
 * against the English copy, so they run in the English locale: English is
 * pinned as the fallback (a user with no stored choice) and as the active
 * locale before every test. The Arabic default itself is proven by
 * tests/unit/i18n-locale.test.tsx (which resets this) and by the Arabic e2e
 * project, where the whole journey suite runs in Arabic.
 */
beforeEach(() => {
  __setFallbackLocaleForTests("en");
  setLocale("en");
});
