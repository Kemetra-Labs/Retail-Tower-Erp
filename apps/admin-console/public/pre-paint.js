// RT-398 / RT-399 / RT-1299: restore the stored dark theme and English locale
// before first paint. index.html loads this file as a classic blocking script in
// <head>, ahead of the app bundle. It is a same-origin file (not inline) so it
// runs under the hosted CSP `default-src 'self'` without 'unsafe-inline'.
// The keys must match THEME_LAST_KEY in src/theme/theme.ts and LOCALE_LAST_KEY
// in src/i18n/locale.ts (tests/unit/theme.test.tsx, i18n-locale.test.tsx).
try {
  if (localStorage.getItem("rt.theme.v1:last") === "dark") {
    document.documentElement.dataset.theme = "dark";
  }
  if (localStorage.getItem("rt.locale.v1:last") === "en") {
    document.documentElement.lang = "en";
    document.documentElement.dir = "ltr";
    document.title = "Retail Tower Console";
  }
} catch {
  // Storage can be blocked (private mode, site-data policy). Nothing to
  // recover: the page keeps its Arabic, light-theme defaults.
}
