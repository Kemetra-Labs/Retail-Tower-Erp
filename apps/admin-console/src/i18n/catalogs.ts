/**
 * RT-962 message catalogs, loaded on demand. The entry carries no catalog: the
 * active locale's is fetched with import() before the first render (main.tsx),
 * and the other one before a switch (locale.ts), so each is its own same-origin
 * chunk. A locale whose catalog is not here yet is never made active.
 *
 * Node-side callers (the unit and e2e suites) register both catalogs up front.
 */
import type { Locale } from "./locale";
import type { Messages } from "./messages/types";

const loaded: Partial<Record<Locale, Messages>> = {};
const pending = new Map<Locale, Promise<void>>();
/** Locales whose import() failed at least once on this page (RT-979). */
const failedOnce = new Set<Locale>();

/**
 * RT-979: a browser caches a failed module fetch for the page's lifetime, so
 * a second failure for the same locale will not heal in-page. The caller
 * should reload the page instead of retrying again.
 */
export class CatalogReloadRequiredError extends Error {
  constructor(
    readonly locale: Locale,
    options?: { cause?: unknown },
  ) {
    super(`Catalog "${locale}" failed to load twice; reload the page.`, options);
    this.name = "CatalogReloadRequiredError";
  }
}

const defaultLoaders: Record<Locale, () => Promise<Messages>> = {
  ar: () => import("./messages/ar").then((m) => m.ar),
  en: () => import("./messages/en").then((m) => m.en),
};
let loaders = { ...defaultLoaders };

export function catalogFor(locale: Locale): Messages | undefined {
  return loaded[locale];
}

export function hasCatalog(locale: Locale): boolean {
  return loaded[locale] !== undefined;
}

export function registerCatalog(locale: Locale, messages: Messages): void {
  loaded[locale] = messages;
}

/**
 * Fetch `locale`'s catalog once (concurrent callers share one fetch). A failed
 * fetch is retried by the next call; if that retry fails too, the rejection is
 * a CatalogReloadRequiredError (RT-979).
 */
export function loadCatalog(locale: Locale): Promise<void> {
  if (hasCatalog(locale)) return Promise.resolve();
  let load = pending.get(locale);
  if (!load) {
    load = loaders[locale]().then(
      (messages) => {
        registerCatalog(locale, messages);
        pending.delete(locale);
        failedOnce.delete(locale);
      },
      (error: unknown) => {
        pending.delete(locale);
        const retried = failedOnce.has(locale);
        failedOnce.add(locale);
        throw retried ? new CatalogReloadRequiredError(locale, { cause: error }) : error;
      },
    );
    pending.set(locale, load);
  }
  return load;
}

/** Test seam only: forget every catalog and restore the real loaders. */
export function __resetCatalogsForTests(): void {
  for (const locale of Object.keys(loaded) as Locale[]) delete loaded[locale];
  pending.clear();
  failedOnce.clear();
  loaders = { ...defaultLoaders };
}

/** Test seam only: replace one locale's loader (a failing network, say). */
export function __setCatalogLoaderForTests(locale: Locale, load: () => Promise<Messages>): void {
  loaders = { ...loaders, [locale]: load };
}
