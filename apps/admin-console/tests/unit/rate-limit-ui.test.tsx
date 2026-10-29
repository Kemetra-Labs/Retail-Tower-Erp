import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-621 (RT-574 §5 issue 3) component/integration checks with a mocked 429:
 * exact request counts (no storm), no sign-out, a mutation not retried with its
 * input kept, the gated control disabled then re-enabled, and the banner's
 * live region. The wrapper mocks call `reportRateLimited` the way the
 * openapi-fetch middleware does on a real 429 (the middleware itself is
 * covered in rate-limit.test.ts).
 */
const consoleCreatePayerAccount = vi.fn();
const getActiveContext = vi.fn();
const refreshSession = vi.fn();
vi.mock("@/lib/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client")>();
  return {
    ...actual,
    consoleCreatePayerAccount: (...a: unknown[]) => consoleCreatePayerAccount(...a),
    getActiveContext: (...a: unknown[]) => getActiveContext(...a),
    refreshSession: (...a: unknown[]) => refreshSession(...a),
  };
});

import { CLAIM_GRACE_MS, RateLimitBanner } from "@/components/RateLimitBanner";
import { ActiveContextProvider } from "@/context/ActiveContextProvider";
import { createQueryClient } from "@/lib/query";
import { RateLimitError, reportRateLimited, resetRateLimit } from "@/lib/rate-limit";
import { PayerCreate } from "@/payers/PayerCreate";
import { ProtectedArea } from "@/shell/ProtectedArea";

function tooMany(seconds: number) {
  reportRateLimited(seconds);
  return {
    status: 429,
    data: undefined,
    error: { error: { code: "rate_limited", message: "Too many requests.", request_id: "r1" } },
    headers: new Headers({ "retry-after": String(seconds) }),
  };
}

function withClient(qc = createQueryClient()) {
  return function Tree({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  resetRateLimit();
  consoleCreatePayerAccount.mockReset();
  getActiveContext.mockReset();
  refreshSession.mockReset();
});
afterEach(() => {
  resetRateLimit();
});

describe("mutation on 429", () => {
  test("is not retried, keeps the input, and gates the submit with a countdown", async () => {
    consoleCreatePayerAccount.mockImplementation(async () => tooMany(1));
    const Tree = withClient();
    render(
      <Tree>
        <PayerCreate
          activeTenant={{ id: "t1", name: "Northstar Retail" }}
          stores={[]}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      </Tree>,
    );

    const name = screen.getByLabelText(/display name/i) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "MedCover Insurance" } });
    fireEvent.click(screen.getByRole("button", { name: /create payer/i }));

    const submit = await screen.findByRole("button", { name: /create payer.*wait 1s/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(name.value).toBe("MedCover Insurance");

    // The window ends: the control re-enables, and nothing was sent again.
    await waitFor(
      () =>
        expect(
          (screen.getByRole("button", { name: /^create payer$/i }) as HTMLButtonElement).disabled,
        ).toBe(false),
      { timeout: 2500 },
    );
    expect(consoleCreatePayerAccount).toHaveBeenCalledTimes(1);
    expect(name.value).toBe("MedCover Insurance");
  });
});

/**
 * RT-944: these run on a fake clock. The retry is timed by setTimeout and
 * measured by Date.now, and the wait it is checked against is real seconds; on
 * the real clock the outcome depended on how loaded the machine was. Faking
 * both (and TanStack's zero-delay notification timer) makes every step exact.
 */
describe("read on 429", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Advance the fake clock and let the query's promises and notifications settle. */
  const elapse = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  test("is retried exactly once, after Retry-After, never after the 1 s default", async () => {
    const calls: number[] = [];
    const queryFn = vi.fn(async () => {
      calls.push(Date.now());
      if (calls.length === 1) {
        reportRateLimited(2);
        throw new RateLimitError(2);
      }
      throw new RateLimitError(2);
    });
    const { result } = renderHook(() => useQuery({ queryKey: ["r"], queryFn }), {
      wrapper: withClient(),
    });

    // The 1 s default backoff would have retried by now; the 2 s Retry-After has not ended.
    await elapse(1999);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(result.current.isError).toBe(false);

    // Retry-After plus the largest jitter (under 1 s): the one retry has run and failed.
    await elapse(1000);
    expect(result.current.isError).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(1900);

    // Nothing is retried after that.
    await elapse(60_000);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  test("a read with retry:false is sent once", async () => {
    const queryFn = vi.fn(async () => {
      reportRateLimited(1);
      throw new RateLimitError(1);
    });
    const { result } = renderHook(() => useQuery({ queryKey: ["r2"], queryFn, retry: false }), {
      wrapper: withClient(),
    });
    await elapse(0);
    expect(result.current.isError).toBe(true);
    await elapse(1200);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});

describe("RateLimitBanner", () => {
  test("announces once in a polite live region, counts down, then offers a retry", async () => {
    const Tree = withClient();
    render(
      <Tree>
        <RateLimitBanner />
      </Tree>,
    );
    const live = screen.getByRole("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("");
    expect(screen.queryByText("Too many requests")).toBeNull();

    act(() => reportRateLimited(1));

    expect(screen.getByText("Too many requests")).toBeDefined();
    expect(live.textContent).toBe("You can try again in 1 second.");
    const retry = screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);

    await waitFor(() => expect(live.textContent).toBe("You can try again now."), {
      timeout: 2500,
    });
    expect((screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("is dismissible and re-opens on the next 429", () => {
    const Tree = withClient();
    render(
      <Tree>
        <RateLimitBanner />
      </Tree>,
    );
    act(() => reportRateLimited(30));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Too many requests")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");

    act(() => reportRateLimited(30));
    expect(screen.getByText("Too many requests")).toBeDefined();
  });

  test("hiddenThroughSeq (RT-931) skips the 429s a surface owns, keeps its live region, and shows a later one", async () => {
    const Tree = withClient();
    const view = render(
      <Tree>
        <RateLimitBanner hiddenThroughSeq={1} />
      </Tree>,
    );
    act(() => reportRateLimited(30));
    expect(screen.queryByText("Too many requests")).toBeNull();
    // The polite live region stays mounted, and silent, so a later banner is announced.
    expect(screen.getByRole("status").textContent).toBe("");

    // A later 429 is shown after the grace that lets a surface claim it first.
    act(() => reportRateLimited(30));
    expect(screen.queryByText("Too many requests")).toBeNull();
    expect(await screen.findByText("Too many requests")).toBeDefined();
    expect(screen.getByRole("status").textContent).not.toBe("");

    // A banner already showing never blanks while the next 429 waits for a claim, and
    // says nothing about it: a 429 the surface then claims is never announced.
    const spoken = screen.getByRole("status").textContent;
    act(() => reportRateLimited(30));
    expect(screen.getByText("Too many requests")).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe(spoken);
    view.rerender(
      <Tree>
        <RateLimitBanner hiddenThroughSeq={3} />
      </Tree>,
    );
    expect(screen.queryByText("Too many requests")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
    await new Promise((r) => setTimeout(r, CLAIM_GRACE_MS + 100));
    expect(screen.queryByText("Too many requests")).toBeNull();
  });

  test("the manual retry re-reads the failed queries once and closes the banner", async () => {
    const qc = createQueryClient();
    const queryFn = vi.fn(async () => {
      throw new Error("refused");
    });
    function Failing() {
      useQuery({ queryKey: ["failing"], queryFn, retry: false });
      return null;
    }
    const Tree = withClient(qc);
    render(
      <Tree>
        <Failing />
        <RateLimitBanner />
      </Tree>,
    );
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    act(() => reportRateLimited(1));
    const retry = screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
    await waitFor(() => expect(retry.disabled).toBe(false), { timeout: 2500 });

    fireEvent.click(retry);

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Too many requests")).toBeNull();
  });
});

describe("a 429 never reaches the sign-in page", () => {
  function Where(): React.JSX.Element {
    return <output aria-label="location">{useLocation().pathname}</output>;
  }

  function renderProtected(): void {
    const qc = createQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/"]}>
          <ActiveContextProvider>
            <Routes>
              <Route path="/signin" element={<h1>Sign in</h1>} />
              <Route path="/" element={<ProtectedArea />}>
                <Route index element={<h1>Home</h1>} />
              </Route>
            </Routes>
            <Where />
          </ActiveContextProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  test("context read refused with 429: rate-limit banner, no redirect, no refresh", async () => {
    getActiveContext.mockImplementation(async () => tooMany(120));
    renderProtected();

    expect(await screen.findByText("Too many requests")).toBeDefined();
    expect(screen.getByRole("status", { name: "location" }).textContent).toBe("/");
    expect(screen.queryByText("Sign in")).toBeNull();
    expect(refreshSession).not.toHaveBeenCalled();
    // A 120 s wait is not auto-retried: exactly one request.
    expect(getActiveContext).toHaveBeenCalledTimes(1);
  });

  test("the full-page rate-limit state cannot be dismissed into a blank page", async () => {
    getActiveContext.mockImplementation(async () => tooMany(120));
    renderProtected();

    expect(await screen.findByText("Too many requests")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });

  test("a 401 whose refresh is refused with 429 (through the interceptor): no redirect", async () => {
    getActiveContext.mockResolvedValue({ status: 401 });
    refreshSession.mockImplementation(async () => tooMany(120));
    renderProtected();

    expect(await screen.findByText("Too many requests")).toBeDefined();
    expect(screen.getByRole("status", { name: "location" }).textContent).toBe("/");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(getActiveContext).toHaveBeenCalledTimes(1);
  });
});
