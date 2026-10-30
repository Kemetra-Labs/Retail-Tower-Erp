import { setLocale } from "@/i18n/locale";
import { RouteErrorFallback } from "@/observability/RouteErrorFallback";
import { ShellRouteErrorFallback } from "@/observability/ShellRouteErrorFallback";
import { reportError } from "@/observability/report";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { Link, Outlet, RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-958: a route render error stays inside the protected shell. The shell's
 * outlet carries its own `errorElement`, so the navigation and the scope header
 * stay mounted and another page opens without a reload. The root fallback
 * (RT-633) still catches errors in the shell itself. Sentry hears of each error
 * once, and the reference is shown only when an event really left.
 */
const EVENT_ID = "0123456789abcdef0123456789abcdef";
const captureException = vi.fn((..._args: unknown[]) => EVENT_ID);
let sentryClient: object | undefined;
vi.mock("@sentry/react", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  getClient: () => sentryClient,
}));

const SECRET = "boom a@b.test eyJhbGciOi.eyJzdWIiOiIx.c2ln";

function Thrower(): React.JSX.Element {
  throw new Error(SECRET);
}

// React retries a throwing render once, so the page stays broken until the test fixes it.
let flakyBroken = false;
function Flaky(): React.JSX.Element {
  if (flakyBroken) throw new Error(SECRET);
  return <h1>Recovered page</h1>;
}

/** A stand-in for AppShell: navigation, a scope header and the content outlet. */
function Shell(): React.JSX.Element {
  return (
    <div>
      <nav aria-label="Main">
        <Link to="/ok">Go to the working page</Link>
      </nav>
      <p>Scope: Maadi</p>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function renderAt(path: string, { strict = false } = {}) {
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        errorElement: <RouteErrorFallback />,
        children: [
          {
            errorElement: <ShellRouteErrorFallback />,
            children: [
              { index: true, element: <Thrower /> },
              { path: "/boom", element: <Thrower /> },
              { path: "/flaky", element: <Flaky /> },
              { path: "/ok", element: <h1>Working page</h1> },
            ],
          },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  const tree = <RouterProvider router={router} />;
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return router;
}

beforeEach(() => {
  captureException.mockClear();
  sentryClient = undefined;
  flakyBroken = false;
  // React logs caught render errors; keep the test output clean.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ShellRouteErrorFallback", () => {
  test("renders inside the shell: navigation and scope stay, one h1, no second main", async () => {
    renderAt("/boom");
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "This page couldn't be displayed",
    });
    expect(heading).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByText("Scope: Maadi")).toBeTruthy();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    // The root fallback is not used for a page error.
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  test("reads What, Safety, Action and never shows the error itself", async () => {
    renderAt("/boom");
    const alert = await screen.findByRole("alert");
    const text = alert.textContent ?? "";
    expect(text).toContain("An unexpected error stopped this page from displaying.");
    expect(text).toContain("Showing this page does not change any data.");
    expect(text).toContain("choose another page from the menu");
    expect(text).not.toContain("a@b.test");
    expect(text).not.toContain("boom");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Overview" }).getAttribute("href")).toBe("/");
  });

  test("offers no Overview link when Overview itself failed", async () => {
    renderAt("/");
    await screen.findByRole("heading", { level: 1, name: "This page couldn't be displayed" });
    expect(screen.queryByRole("link", { name: "Go to Overview" })).toBeNull();
  });

  test("reports the error to Sentry exactly once, even under StrictMode", async () => {
    renderAt("/boom", { strict: true });
    await screen.findByRole("alert");
    expect(captureException).toHaveBeenCalledTimes(1);
    expect((captureException.mock.calls[0]?.[0] as Error).message).toBe(SECRET);
  });

  test("another page opens from the navigation without a reload", async () => {
    const router = renderAt("/boom");
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("link", { name: "Go to the working page" }));
    expect(await screen.findByRole("heading", { name: "Working page" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(router.state.location.pathname).toBe("/ok");
  });

  test("Try again renders the page again in place", async () => {
    flakyBroken = true;
    renderAt("/flaky");
    await screen.findByRole("alert");
    flakyBroken = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(await screen.findByRole("heading", { name: "Recovered page" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("shows no reference while Sentry is inert", async () => {
    renderAt("/boom");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("Error reference");
    expect(alert.textContent).not.toContain(EVENT_ID);
  });

  test("shows the Sentry event id as an LTR-isolated reference when an event was sent", async () => {
    sentryClient = {};
    renderAt("/boom");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Error reference:");
    const id = screen.getByText(EVENT_ID);
    expect(id.tagName).toBe("BDI");
    expect(id.getAttribute("dir")).toBe("ltr");
  });

  test("uses the Arabic copy in the Arabic locale, with no raw key", async () => {
    setLocale("ar");
    renderAt("/boom");
    await screen.findByRole("heading", { level: 1, name: "تعذّر عرض هذه الصفحة" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).not.toMatch(/app\.routeError|[A-Za-z]{3,}/);
    expect(screen.getByRole("button", { name: "حاول مرة أخرى" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "الانتقال إلى نظرة عامة" })).toBeTruthy();
  });
});

describe("RouteErrorFallback (root)", () => {
  test("renders one h1 in its own main for an error in the shell itself", async () => {
    const router = createMemoryRouter(
      [{ path: "/", element: <Thrower />, errorElement: <RouteErrorFallback /> }],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Something went wrong" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain(
      "Showing this page does not change any data.",
    );
  });
});

describe("reportError", () => {
  test("reports the same error object once and returns the same reference", () => {
    sentryClient = {};
    const error = new Error("once");
    expect(reportError(error)).toBe(EVENT_ID);
    expect(reportError(error)).toBe(EVENT_ID);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  test("returns no reference while Sentry has no client", () => {
    expect(reportError(new Error("inert"))).toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  test("reports two different errors separately", () => {
    reportError(new Error("first"));
    reportError(new Error("second"));
    expect(captureException).toHaveBeenCalledTimes(2);
  });
});
