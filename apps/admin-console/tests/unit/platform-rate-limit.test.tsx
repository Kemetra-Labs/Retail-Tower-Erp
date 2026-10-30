import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-931 (RT-777 as-built P2-1): one rate-limit message per failure on
 * `/platform`. The surface that owns a 429 (the directory load, the start
 * drawer's submit) says it once and carries the one retry control; the shell's
 * shared banner stays out of its way for that same 429, and comes back for any
 * later one (the session bar's renew and end are shell-only).
 *
 * The stubbed reads call `reportRateLimited` as the real middleware does on a
 * 429 (src/lib/rate-limit.ts), so the shared clock and the shell banner run as
 * they do in the app. A three-second Retry-After keeps the countdown real and leaves slack on a slow runner.
 */
const getActiveContext = vi.fn();
const listTenants = vi.fn();
const openSupportSession = vi.fn();
vi.mock("@/lib/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client")>();
  return {
    ...actual,
    getActiveContext: (...a: unknown[]) => getActiveContext(...a),
    switchActiveTenant: vi.fn(),
    refreshSession: vi.fn(),
    signOut: vi.fn(),
  };
});
vi.mock("@/lib/rf2-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rf2-queries")>();
  return { ...actual, listTenants: (...a: unknown[]) => listTenants(...a) };
});
vi.mock("@/lib/support-session-queries", () => ({
  openSupportSession: (...a: unknown[]) => openSupportSession(...a),
  renewSupportSession: vi.fn(),
  endSupportSession: vi.fn(),
}));

import { CLAIM_GRACE_MS } from "@/components/RateLimitBanner";
import { ActiveContextProvider } from "@/context/ActiveContextProvider";
import { createQueryClient } from "@/lib/query";
import { reportRateLimited, resetRateLimit } from "@/lib/rate-limit";
import { resetSupportSessionExpiry } from "@/lib/support-session-expiry";
import { ProtectedArea } from "@/shell/ProtectedArea";
import { platformRoutes } from "@/shell/platformRoutes";

const admin = { id: "u1", email: "ops@kemetra.test", display_name: "Ops", is_platform_admin: true };
const DELTA = "0190f000-0000-7000-8000-0000000000d1";
const TENANTS = [{ id: DELTA, slug: "delta-markets", name: "Delta Markets" }];

const context = {
  user: admin,
  active_tenant: null,
  active_store: null,
  memberships: [],
  support_session: null,
};

const ok = (data: unknown) => ({ status: 200, data, error: undefined });
/** What the middleware plus the wrapper make of a 429: the clock moves, then the refusal returns. */
const limited = async (retryAfterSeconds = 1) => {
  const rateLimitSeq = reportRateLimited(retryAfterSeconds);
  return {
    status: 429,
    data: undefined,
    error: { error: { code: "rate_limited", message: "x", request_id: "req-9" } },
    rateLimitSeq,
  };
};

function mount(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/platform/tenants"]}>
        <ActiveContextProvider>
          <Routes>
            {platformRoutes}
            <Route path="/" element={<ProtectedArea />} />
          </Routes>
        </ActiveContextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The shell's shared banner, its title, and every "Try again" control on the page. */
const shellAlert = () => document.querySelector(".rate-limit-banner .rtc-alert");
const tryAgainButtons = () => screen.queryAllByRole("button", { name: /^Try again/ });
const submitButton = (drawer: HTMLElement) =>
  within(drawer).getByRole("button", { name: /^Start support session/ }) as HTMLButtonElement;

/** Records every DOM change that puts the shared banner, or its spoken text, on screen. */
function watchSharedBanner(): { stop: () => string[] } {
  const seen: string[] = [];
  const watch = new MutationObserver(() => {
    const alert = shellAlert();
    const spoken = document.querySelector(".rate-limit-banner output")?.textContent ?? "";
    if (alert || spoken) seen.push(`${alert ? "alert" : ""}|${spoken}`);
  });
  watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  return {
    stop: () => {
      watch.disconnect();
      return seen;
    },
  };
}

beforeEach(() => {
  resetRateLimit();
  resetSupportSessionExpiry();
  for (const m of [getActiveContext, listTenants, openSupportSession]) m.mockReset();
  getActiveContext.mockResolvedValue({ status: 200, data: context });
  listTenants.mockResolvedValue(ok(TENANTS));
});
afterEach(() => cleanup());

describe("directory load 429", () => {
  test("the shared banner is never on screen for the claimed 429, not even for one commit", async () => {
    const seen = watchSharedBanner();
    listTenants.mockImplementation(() => limited(30));
    mount();
    await screen.findByText(/because of too many requests/);
    await new Promise((r) => setTimeout(r, CLAIM_GRACE_MS + 150));
    expect(seen.stop()).toEqual([]);
  });

  test("one message and one retry control, disabled until the Retry-After countdown ends", async () => {
    listTenants.mockImplementation(() => limited(3));
    mount();

    expect(await screen.findByText(/because of too many requests/)).toBeDefined();
    // One message: the surface's own. The shell's shared banner is not a second one.
    expect(screen.queryByText("Too many requests")).toBeNull();
    expect(shellAlert()).toBeNull();
    // At most one retry control, gated by the countdown.
    const [retry, ...others] = tryAgainButtons();
    expect(others).toHaveLength(0);
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(retry.textContent).toMatch(/Wait \d+s/);

    await waitFor(() => expect((tryAgainButtons()[0] as HTMLButtonElement).disabled).toBe(false), {
      timeout: 6000,
    });
    expect(shellAlert()).toBeNull();
    expect(tryAgainButtons()).toHaveLength(1);
    expect(listTenants).toHaveBeenCalledTimes(1);

    // The one control reads the directory again.
    listTenants.mockResolvedValue(ok(TENANTS));
    fireEvent.click(tryAgainButtons()[0]);
    expect(await screen.findByRole("table", { name: "Organizations list" })).toBeDefined();
    expect(listTenants).toHaveBeenCalledTimes(2);
  }, 10_000);

  test("a later 429 the surface did not report brings the shell banner back (the session bar's renew and end)", async () => {
    listTenants.mockImplementation(() => limited(3));
    mount();
    await screen.findByText(/because of too many requests/);
    expect(shellAlert()).toBeNull();

    // A renew or end answered 429 while the directory error is still on screen.
    act(() => reportRateLimited(30));

    const banner = await waitFor(() => {
      const el = shellAlert();
      expect(el).not.toBeNull();
      return el as Element;
    });
    expect(within(banner as HTMLElement).getByText("Too many requests")).toBeDefined();
  });

  test("a 429 on some other read, with the directory loaded, still shows the shell banner", async () => {
    mount();
    expect(await screen.findByRole("table", { name: "Organizations list" })).toBeDefined();
    expect(shellAlert()).toBeNull();

    act(() => reportRateLimited(30));

    expect(await screen.findByText("Too many requests")).toBeDefined();
  });
});

/**
 * RT-940: two 429s can land before the first one's wrapper returns (the session
 * bar's renew or end while the drawer's submit or the directory read is
 * answered). Each surface claims the 429 its own response carried, never the
 * clock's newest count, so the overlapping one is still the shell banner's.
 */
describe("overlapping 429s", () => {
  /** A 429 the surface owns, with a session-bar 429 landing before its wrapper returns. */
  const limitedThenBarLimited = async () => {
    const own = await limited(30);
    reportRateLimited(30);
    return own;
  };

  test("start drawer: the drawer's 429 stays the drawer's, the bar's overlapping 429 reaches the shell banner", async () => {
    openSupportSession.mockImplementation(limitedThenBarLimited);
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Start support session: Delta Markets" }),
    );
    const drawer = await screen.findByRole("dialog");
    fireEvent.change(within(drawer).getByLabelText(/Purpose/), { target: { value: "incident" } });
    fireEvent.click(submitButton(drawer));

    // The drawer says its own 429 once, with the one gated control.
    expect(await within(drawer).findByText(/Too many requests, and no session/)).toBeDefined();
    expect(within(drawer).getAllByText(/Too many requests/)).toHaveLength(1);
    expect(submitButton(drawer).textContent).toMatch(/Wait \d+s/);
    // RT-944: the drawer's own controls. The shell banner's retry for the bar's
    // 429 may already be up (CLAIM_GRACE_MS is real time); it is counted below.
    expect(within(drawer).queryAllByRole("button", { name: /^Try again/ })).toHaveLength(0);

    // The bar's 429 was not the drawer's to claim: the shell banner shows it, once.
    const banner = await waitFor(() => {
      const el = shellAlert();
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(within(banner).getByText("Too many requests")).toBeDefined();
    expect(tryAgainButtons()).toHaveLength(1);
  });

  test("directory: the directory's 429 stays the directory's, the bar's overlapping 429 reaches the shell banner", async () => {
    listTenants.mockImplementation(limitedThenBarLimited);
    mount();
    expect(await screen.findByText(/because of too many requests/)).toBeDefined();

    const banner = await waitFor(() => {
      const el = shellAlert();
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(within(banner).getByText("Too many requests")).toBeDefined();
    expect(screen.getAllByText(/because of too many requests/)).toHaveLength(1);
  });
});

describe("start drawer 429", () => {
  test("the shared banner is never on screen for the drawer's 429 either", async () => {
    openSupportSession.mockImplementation(() => limited(30));
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Start support session: Delta Markets" }),
    );
    const drawer = await screen.findByRole("dialog");
    fireEvent.change(within(drawer).getByLabelText(/Purpose/), { target: { value: "incident" } });
    const seen = watchSharedBanner();
    fireEvent.click(submitButton(drawer));
    await within(drawer).findByText(/Too many requests, and no session/);
    await new Promise((r) => setTimeout(r, CLAIM_GRACE_MS + 150));
    expect(seen.stop()).toEqual([]);
  });

  test("one message and the one gated control, disabled until the countdown ends", async () => {
    openSupportSession.mockImplementation(() => limited(3));
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Start support session: Delta Markets" }),
    );
    const drawer = await screen.findByRole("dialog");
    fireEvent.change(within(drawer).getByLabelText(/Purpose/), { target: { value: "incident" } });
    fireEvent.click(submitButton(drawer));

    expect(await within(drawer).findByText(/Too many requests, and no session/)).toBeDefined();
    // One message: the drawer's own. No shared banner behind it saying the same.
    expect(screen.queryByText("Too many requests")).toBeNull();
    expect(shellAlert()).toBeNull();
    // The one control is the submit, gated with the countdown, and no second retry.
    expect(tryAgainButtons()).toHaveLength(0);
    expect(submitButton(drawer).disabled).toBe(true);
    expect(submitButton(drawer).textContent).toMatch(/Wait \d+s/);

    await waitFor(() => expect(submitButton(drawer).disabled).toBe(false), { timeout: 6000 });
    expect(shellAlert()).toBeNull();
    expect(openSupportSession).toHaveBeenCalledTimes(1);
  }, 10_000);
});
