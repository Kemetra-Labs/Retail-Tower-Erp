/**
 * RT-1247 (Sentry ADMIN-CONSOLE-J): after a deploy, a tab still running the
 * old build asks for a page chunk the new build no longer serves, so the lazy
 * import fails. Reloading picks up the new build; the operator stays on the
 * same URL.
 *
 * One reload per failure. The same error again (whenever it happens: a slow
 * reload can take longer than the window), or any failure within
 * `RELOAD_GUARD_MS`, is a real outage or a broken chunk, so the error goes on to
 * the route's error element and Sentry. Without working sessionStorage there is
 * no guard, so there is no reload either: a loop is worse than the error screen.
 * If the reload does not happen (a cancelled "Leave site?" prompt), the error
 * goes on after `RELOAD_STUCK_MS` instead of leaving the page loading forever.
 *
 * Vite's `vite:preloadError` event is not used: preventing it makes the import
 * resolve to `undefined`, and the page would then fail anyway.
 */

/** A second chunk failure within this window does not reload again. */
export const RELOAD_GUARD_MS = 60_000;

/** If the page is still here this long after `reload()`, show the error. */
export const RELOAD_STUCK_MS = 10_000;

const RELOAD_KEY = "rtc.chunkReload";

/**
 * How browsers (Chrome, Firefox, Safari) and Vite's CSS preload word a chunk
 * that could not be fetched. Anything else, e.g. a module that loaded but threw
 * while evaluating, is a bug and goes straight to the error element.
 */
const CHUNK_LOAD_ERROR =
  /dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_LOAD_ERROR.test(error.message);
}

export interface ChunkReloadDeps {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  reload: () => void;
  now: () => number;
}

interface ReloadRecord {
  at: number;
  error: string;
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

/** The failure's identity: the message names the missing chunk. Kept in this tab only. */
function errorKey(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function readRecord(raw: string | null): ReloadRecord | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { at, error } = value as Partial<ReloadRecord>;
    return typeof at === "number" && typeof error === "string" ? { at, error } : null;
  } catch {
    return null;
  }
}

/**
 * For a chunk-load failure, reloads once and returns a promise that stays pending, so the page keeps its
 * loading state until the reload (it rejects with `error` after
 * `RELOAD_STUCK_MS` if the page is still there). Otherwise rejects with `error`
 * unchanged.
 */
export function reloadOnceOnChunkError<T = never>(
  error: unknown,
  deps: ChunkReloadDeps = browserDeps(),
): Promise<T> {
  const { storage, reload, now } = deps;
  if (storage === null || !isChunkLoadError(error)) return Promise.reject(error);
  const key = errorKey(error);
  try {
    const last = readRecord(storage.getItem(RELOAD_KEY));
    const at = now();
    if (last !== null && (last.error === key || at - last.at < RELOAD_GUARD_MS)) {
      return Promise.reject(error);
    }
    storage.setItem(RELOAD_KEY, JSON.stringify({ at, error: key } satisfies ReloadRecord));
  } catch {
    return Promise.reject(error);
  }
  reload();
  return new Promise<T>((_resolve, reject) => {
    setTimeout(() => reject(error), RELOAD_STUCK_MS);
  });
}
