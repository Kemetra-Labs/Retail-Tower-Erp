/**
 * RT-1247 (Sentry ADMIN-CONSOLE-J): after a deploy, a tab still running the
 * old build asks for a page chunk the new build no longer serves, so the lazy
 * import fails. Reloading picks up the new build; the operator stays on the
 * same URL.
 *
 * One reload only. A second failure within `RELOAD_GUARD_MS` is a real outage
 * (or a broken chunk), so the error goes on to the route's error element and
 * Sentry. Without working sessionStorage there is no guard, so there is no
 * reload either: a loop is worse than the error screen.
 *
 * Vite's `vite:preloadError` event is not used: preventing it makes the import
 * resolve to `undefined`, and the page would then fail anyway.
 */

/** A second chunk failure within this window does not reload again. */
export const RELOAD_GUARD_MS = 60_000;

const RELOADED_AT_KEY = "rtc.chunkReloadAt";

export interface ChunkReloadDeps {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  reload: () => void;
  now: () => number;
}

function browserDeps(): ChunkReloadDeps {
  let storage: ChunkReloadDeps["storage"] = null;
  try {
    storage = window.sessionStorage;
  } catch {
    // Blocked site data: no guard, so no reload.
  }
  return { storage, reload: () => window.location.reload(), now: () => Date.now() };
}

/**
 * Reloads once and returns a promise that never settles, so the page keeps its
 * loading state until the reload. Otherwise rejects with `error` unchanged.
 */
export function reloadOnceOnChunkError<T = never>(
  error: unknown,
  deps: ChunkReloadDeps = browserDeps(),
): Promise<T> {
  const { storage, reload, now } = deps;
  if (storage === null) return Promise.reject(error);
  try {
    const last = Number(storage.getItem(RELOADED_AT_KEY));
    const at = now();
    if (Number.isFinite(last) && last > 0 && at - last < RELOAD_GUARD_MS) {
      return Promise.reject(error);
    }
    storage.setItem(RELOADED_AT_KEY, String(at));
  } catch {
    return Promise.reject(error);
  }
  reload();
  return new Promise<T>(() => undefined);
}
