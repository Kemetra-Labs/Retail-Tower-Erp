import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PageHeader } from "@/components/PageHeader";
import { setLocale } from "@/i18n/locale";
import { translate } from "@/i18n/translate";
import { RouteEffects } from "@/shell/RouteEffects";
import { sourcesUnder } from "./source-scan";

/**
 * RT-969 AC 1: every routed page renders the shared page header: one `<h1>`
 * screen title, an optional subtitle, children under it, and the segmented
 * control and actions at the inline end.
 */

afterEach(cleanup);

describe("PageHeader", () => {
  test("renders the title as the page's h1, with the subtitle under it", () => {
    render(<PageHeader title="Stores" subtitle="Stores in Northstar Retail" />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Stores" });
    expect(h1.className).toContain("content__title");
    // RT-963: a programmatic focus target after navigation, never a Tab stop.
    expect(h1.getAttribute("tabindex")).toBe("-1");
    expect(screen.getByText("Stores in Northstar Retail").className).toContain("content__sub");
  });

  test("leaves out the subtitle and the end slot when none is given", () => {
    const { container } = render(<PageHeader title="Audit" />);
    expect(container.querySelector(".content__sub")).toBeNull();
    expect(container.querySelector(".page-header__end")).toBeNull();
  });

  test("puts the segmented control before the actions, at the end", () => {
    const { container } = render(
      <PageHeader
        title="Overview"
        segmented={<fieldset aria-label="Period">period</fieldset>}
        actions={<button type="button">Today's report</button>}
      />,
    );
    const end = container.querySelector(".page-header__end") as HTMLElement;
    expect(Array.from(end.children).map((c) => c.textContent)).toEqual([
      "period",
      "Today's report",
    ]);
  });

  test("children sit under the title (status chips, a second note)", () => {
    render(
      <PageHeader title="Sale R-1">
        <span>Posted</span>
      </PageHeader>,
    );
    const text = screen.getByRole("heading", { level: 1 }).parentElement as HTMLElement;
    expect(text.textContent).toContain("Posted");
  });

  test("titleRef makes the title a focus target; titleId labels a region", () => {
    const ref = createRef<HTMLHeadingElement>();
    render(<PageHeader title="Water 1.5L" titleRef={ref} titleId="item-title" />);
    expect(ref.current?.getAttribute("tabindex")).toBe("-1");
    expect(ref.current?.id).toBe("item-title");
  });
});

describe("RT-963 page title", () => {
  test("names the document «<page> – <app>»", () => {
    render(<PageHeader title="Stores" />);
    expect(document.title).toBe("Stores – Retail Tower Console");
  });

  test("RT-993: a greeting h1 still names the document after the page", () => {
    render(<PageHeader title="Welcome, Amal" documentTitle="Overview" />);
    expect(document.title).toBe("Overview – Retail Tower Console");
  });
});

/**
 * RT-978: the root `RouteEffects` records route transitions (so a route without
 * a page header still counts) and names the document after each one.
 */
function GoTo({ to }: Readonly<{ to: string }>): React.JSX.Element {
  return <Link to={to}>{`go ${to}`}</Link>;
}

/** A routed page whose body is remounted when its scope changes (ProtectedArea's keyed Outlet). */
function ScopedPage({ title }: Readonly<{ title: string }>): React.JSX.Element {
  const [scope, setScope] = useState(1);
  return (
    <div key={scope}>
      <PageHeader title={title} />
      <button type="button" onClick={() => setScope(scope + 1)}>
        switch scope
      </button>
    </div>
  );
}

function renderRoutes(initial: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <RouteEffects />
      <Routes>
        <Route
          path="/stores"
          element={
            <>
              <ScopedPage title="Stores" />
              <GoTo to="/devices" />
              <GoTo to="/signin" />
            </>
          }
        />
        <Route
          path="/devices"
          element={
            <>
              <PageHeader title="Devices" />
              <GoTo to="/stores" />
            </>
          }
        />
        <Route
          path="/signin"
          element={
            <>
              <p>Sign in</p>
              <GoTo to="/stores" />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RT-978 document title across routes", () => {
  beforeEach(() => setLocale("en"));

  test("a route without a page header (after sign-out) names the document with the app title", () => {
    renderRoutes("/stores");
    expect(document.title).toBe("Stores – Retail Tower Console");
    fireEvent.click(screen.getByText("go /signin"));
    expect(document.title).toBe("Retail Tower Console");
  });

  test("the same holds in Arabic", () => {
    setLocale("ar");
    renderRoutes("/stores");
    fireEvent.click(screen.getByText("go /signin"));
    expect(document.title).toBe(translate("ar", "app.title"));
    expect(document.title).not.toBe("Retail Tower Console");
  });

  test("a route with a page header names the document after its page", () => {
    renderRoutes("/signin");
    expect(document.title).toBe("Retail Tower Console");
    fireEvent.click(screen.getByText("go /stores"));
    expect(document.title).toBe("Stores – Retail Tower Console");
  });
});

describe("RT-963 and RT-978 focus after navigation", () => {
  beforeEach(() => setLocale("en"));

  test("the first load leaves focus where it is", () => {
    renderRoutes("/stores");
    expect(document.activeElement).toBe(document.body);
  });

  test("a navigation to another path moves focus to the new page's title", () => {
    renderRoutes("/stores");
    fireEvent.click(screen.getByText("go /devices"));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Devices" }));
  });

  test("returning from sign-in to the same path moves focus to that page's title", () => {
    renderRoutes("/stores");
    expect(document.activeElement).toBe(document.body);
    // Session expired on /stores: sign-in has no page header, then the return.
    fireEvent.click(screen.getByText("go /signin"));
    fireEvent.click(screen.getByText("go /stores"));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Stores" }));
  });

  test("the same path remounted by a scope change leaves focus where it is", () => {
    renderRoutes("/stores");
    const button = screen.getByRole("button", { name: "switch scope" });
    button.focus();
    fireEvent.click(button);
    // The scope body was replaced: the old button is gone and focus did not go to the title.
    expect(document.activeElement).toBe(document.body);
  });

  test("a scope change after a navigation does not move focus again", () => {
    renderRoutes("/stores");
    fireEvent.click(screen.getByText("go /signin"));
    fireEvent.click(screen.getByText("go /stores"));
    const title = screen.getByRole("heading", { level: 1, name: "Stores" });
    expect(document.activeElement).toBe(title);
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    fireEvent.click(screen.getByRole("button", { name: "switch scope" }));
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});

/** Screens outside the shell keep their own title: sign-in, gates, crash. */
const OUTSIDE_THE_SHELL = [
  "src/auth/AcceptInvitation.tsx",
  "src/auth/AuthLayout.tsx",
  "src/auth/NoAccess.tsx",
  "src/auth/SignIn.tsx",
  "src/observability/ErrorFallback.tsx",
  "src/platform/PlatformNotAvailable.tsx",
  "src/shell/ScopeGate.tsx",
  "src/components/PageHeader.tsx",
];

describe("adoption", () => {
  test("no page inside the shell writes its own h1 or screen-title class", () => {
    const offenders = sourcesUnder("src")
      .filter(({ file }) => !OUTSIDE_THE_SHELL.some((allowed) => file.endsWith(allowed)))
      .filter(({ src }) => /<h1[\s>]|"content__title"/.test(src))
      .map(({ file }) => file.replace(/^.*\/src\//, "src/"));
    expect(offenders).toEqual([]);
  });
});
