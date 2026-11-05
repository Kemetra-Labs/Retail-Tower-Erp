import {
  type ChunkReloadDeps,
  RELOAD_GUARD_MS,
  RELOAD_STUCK_MS,
  reloadOnceOnChunkError,
} from "@/shell/chunkReload";
import { lazyPage } from "@/shell/lazyPage";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * RT-1247 (Sentry ADMIN-CONSOLE-J): after a deploy, an open tab asks for a page
 * chunk the new build no longer serves. Reload once to pick up the new build;
 * never loop.
 */

const chunkError = new TypeError(
  "Failed to fetch dynamically imported module: https://lab.kemetralabs.com/assets/StoreList-C93kq0MG.js",
);

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

function deps(over: Partial<ChunkReloadDeps> = {}): ChunkReloadDeps {
  return { storage: memoryStorage(), reload: vi.fn(), now: () => 1_000_000, ...over };
}

/** Settles to "pending" when the promise has neither resolved nor rejected yet. */
async function state(p: Promise<unknown>): Promise<"pending" | "resolved" | "rejected"> {
  const pending = Symbol("pending");
  const outcome = await Promise.race([
    p.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<symbol>((r) => setTimeout(() => r(pending), 0)),
  ]);
  return outcome === pending ? "pending" : (outcome as "resolved" | "rejected");
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reloadOnceOnChunkError (RT-1247)", () => {
  test("the first failure reloads once and never settles, so no error reaches the route", async () => {
    const d = deps();
    const p = reloadOnceOnChunkError(chunkError, d);
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(await state(p)).toBe("pending");
  });

  test("a second failure within the guard window rethrows the original error, without a reload", async () => {
    const storage = memoryStorage();
    let now = 1_000_000;
    const first = deps({ storage, now: () => now });
    reloadOnceOnChunkError(chunkError, first).catch(() => undefined);

    now += RELOAD_GUARD_MS - 1;
    const second = deps({ storage, now: () => now });
    await expect(reloadOnceOnChunkError(chunkError, second)).rejects.toBe(chunkError);
    expect(second.reload).not.toHaveBeenCalled();
  });

  test("a different chunk failing after the guard window reloads again (a later deploy)", async () => {
    const storage = memoryStorage();
    let now = 1_000_000;
    reloadOnceOnChunkError(chunkError, deps({ storage, now: () => now })).catch(() => undefined);

    now += RELOAD_GUARD_MS + 1;
    const later = deps({ storage, now: () => now });
    const nextDeploy = new TypeError(
      "Failed to fetch dynamically imported module: https://lab.kemetralabs.com/assets/StoreList-Next.js",
    );
    expect(await state(reloadOnceOnChunkError(nextDeploy, later))).toBe("pending");
    expect(later.reload).toHaveBeenCalledTimes(1);
  });

  test("the same chunk failing again after a slow reload rethrows, however long it took", async () => {
    const storage = memoryStorage();
    let now = 1_000_000;
    reloadOnceOnChunkError(chunkError, deps({ storage, now: () => now })).catch(() => undefined);

    now += RELOAD_GUARD_MS * 10;
    const again = deps({ storage, now: () => now });
    await expect(reloadOnceOnChunkError(chunkError, again)).rejects.toBe(chunkError);
    expect(again.reload).not.toHaveBeenCalled();
  });

  test("a reload that never happens (e.g. a cancelled leave prompt) rethrows after a timeout", async () => {
    vi.useFakeTimers();
    const d = deps();
    const p = reloadOnceOnChunkError(chunkError, d);
    const settled = expect(p).rejects.toBe(chunkError);
    await vi.advanceTimersByTimeAsync(RELOAD_STUCK_MS);
    await settled;
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["Chrome", new TypeError("Failed to fetch dynamically imported module: https://x.test/a.js")],
    ["Firefox", new TypeError("error loading dynamically imported module: https://x.test/a.js")],
    ["Safari", new TypeError("Importing a module script failed.")],
    ["Vite CSS preload", new Error("Unable to preload CSS for /assets/a.css")],
  ])("a %s chunk-load failure reloads", async (_browser, error) => {
    const d = deps();
    expect(await state(reloadOnceOnChunkError(error, d))).toBe("pending");
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  test("a module that loaded but threw while evaluating is a bug: rethrow, no reload", async () => {
    const d = deps();
    const bug = new ReferenceError("formatMoney is not defined");
    await expect(reloadOnceOnChunkError(bug, d)).rejects.toBe(bug);
    expect(d.reload).not.toHaveBeenCalled();
  });

  test("without storage it rethrows and never reloads (no guard, no reload)", async () => {
    const d = deps({ storage: null });
    await expect(reloadOnceOnChunkError(chunkError, d)).rejects.toBe(chunkError);
    expect(d.reload).not.toHaveBeenCalled();
  });

  test("when storage throws (blocked site data) it rethrows and never reloads", async () => {
    const blocked = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    };
    const d = deps({ storage: blocked });
    await expect(reloadOnceOnChunkError(chunkError, d)).rejects.toBe(chunkError);
    expect(d.reload).not.toHaveBeenCalled();
  });

  test("a corrupt stored record counts as no earlier reload", async () => {
    const storage = memoryStorage();
    storage.setItem("rtc.chunkReload", "not-json");
    const d = deps({ storage });
    expect(await state(reloadOnceOnChunkError(chunkError, d))).toBe("pending");
    expect(d.reload).toHaveBeenCalledTimes(1);
  });
});

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? <p>Route error</p> : this.props.children;
  }
}

describe("lazyPage chunk failure (RT-1247)", () => {
  test("while the reload is pending the loading state stays and no error shows", async () => {
    const Page = lazyPage(
      () => Promise.reject(chunkError) as Promise<{ Screen: () => React.JSX.Element }>,
      "Screen",
      () => new Promise<never>(() => undefined),
    );
    render(
      <Boundary>
        <Page />
      </Boundary>,
    );
    await act(async () => undefined);
    expect(screen.getByText("Loading items…")).toBeTruthy();
    expect(screen.queryByText("Route error")).toBeNull();
  });

  test("when recovery rethrows, the route error element shows", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Page = lazyPage(
      () => Promise.reject(chunkError) as Promise<{ Screen: () => React.JSX.Element }>,
      "Screen",
      (error) => Promise.reject(error),
    );
    render(
      <Boundary>
        <Page />
      </Boundary>,
    );
    expect(await screen.findByText("Route error")).toBeTruthy();
  });

  test("by default a failed chunk reloads the page (wired to reloadOnceOnChunkError)", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    window.sessionStorage.clear();
    const Page = lazyPage(
      () => Promise.reject(chunkError) as Promise<{ Screen: () => React.JSX.Element }>,
      "Screen",
    );
    render(
      <Boundary>
        <Page />
      </Boundary>,
    );
    await act(async () => undefined);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loading items…")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
