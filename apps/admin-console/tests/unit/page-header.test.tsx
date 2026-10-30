import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";

import { PageHeader } from "@/components/PageHeader";
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

describe("RT-963 page title and focus", () => {
  test("names the document «<page> – <app>»", () => {
    render(<PageHeader title="Stores" />);
    expect(document.title).toBe("Stores – Retail Tower Console");
  });

  test("a navigation to another path moves focus to the new page's title", () => {
    window.history.pushState({}, "", "/rt963-a");
    const first = render(<PageHeader title="Stores" />);
    first.unmount();
    window.history.pushState({}, "", "/rt963-b");
    render(<PageHeader title="Devices" />);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  test("the same path remounted (a scope change) leaves focus where it is", () => {
    window.history.pushState({}, "", "/rt963-c");
    const first = render(<PageHeader title="Sales" />);
    first.unmount();
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    render(<PageHeader title="Sales" />);
    expect(document.activeElement).toBe(button);
    button.remove();
  });
});

/** Screens outside the shell keep their own title: sign-in, gates, crash. */
const OUTSIDE_THE_SHELL = [
  "src/auth/AcceptInvitation.tsx",
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
