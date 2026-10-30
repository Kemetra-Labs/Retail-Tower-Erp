import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ShellSidebar } from "@/shell/ShellFrame";
import type { NavGroup } from "@/shell/nav-model";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, test, vi } from "vitest";

/**
 * RT-991 (D-V1/D-V2, DESIGN.md §12.1-§12.2): the Ink sidebar, its Mint signal
 * line and the brand mark. Semantics are asserted on the rendered markup; the
 * visual contract (which role paints what, the forced-colours fallbacks) is
 * asserted on the stylesheet text, because jsdom does not compute `color-mix`
 * or media queries. The rendered captures are in the PR (1280x800 and 390 wide).
 */

const groups: readonly NavGroup[] = [
  {
    id: "ops",
    entries: [
      { to: "/sales", label: "sales.nav.label", icon: "sale" },
      { to: "/stores", label: "shell.nav.stores", icon: "dashboard" },
    ],
  },
];

function renderSidebar(path = "/stores"): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ShellSidebar navLabel="Main" tag="Console" groups={groups} onSignOut={vi.fn()} />
    </MemoryRouter>,
  );
}

const css = (file: string): string =>
  readFileSync(join(process.cwd(), "src", "shell", file), "utf8").replace(/\r\n/g, "\n");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(sheet);
  if (!match) throw new Error(`rule ${selector} not found`);
  return match[1];
}

describe("RT-991 sidebar semantics", () => {
  test("the active entry is the one link with aria-current=page", () => {
    renderSidebar("/stores");
    const current = document.querySelectorAll(".sidebar a[aria-current='page']");
    expect(current).toHaveLength(1);
    expect(current[0].classList.contains("nav-entry--active")).toBe(true);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  test("the brand mark is decorative: aria-hidden, three bars, no image role", () => {
    renderSidebar();
    const mark = document.querySelector(".sidebar .brand-mark");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.querySelectorAll(".brand-mark__bar")).toHaveLength(3);
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("the product word still names the lockup", () => {
    renderSidebar();
    expect(screen.getByText("Retail Tower OS")).toBeDefined();
  });
});

describe("RT-991 Ink sidebar stylesheet", () => {
  const shell = css("app-shell.css");
  const scope = css("scope-header.css");

  test("the sidebar surface is Ink with on-Ink text in both themes", () => {
    const sidebar = rule(shell, ".sidebar");
    expect(sidebar).toContain("background-color: var(--color-ink)");
    expect(sidebar).toContain("color: var(--color-on-ink)");
    // Fixed roles, so the dark theme does not remap the surface.
    expect(sidebar).not.toMatch(/--color-(surface|background|text)\b/);
  });

  test("secondary text is ink-muted and the primary text on Ink is on-ink", () => {
    expect(shell).toMatch(
      /\.sidebar \.tower-lockup__tag,[^{]*\.sidebar \.nav-section,[^{]*\{\s*color: var\(--color-ink-muted\)/,
    );
    expect(rule(shell, ".sidebar .tower-lockup__word")).toContain("color: var(--color-on-ink)");
  });

  test("the active entry has a 4px Mint bar at the inline start and a Mint icon", () => {
    const bar = rule(shell, ".sidebar .nav-entry--active::before");
    expect(bar).toContain("width: 4px");
    expect(bar).toContain("background: var(--color-mint)");
    expect(bar).not.toContain("left");
    expect(rule(shell, ".sidebar .nav-entry--active .nav-entry__icon")).toContain(
      "color: var(--color-mint)",
    );
  });

  test("Mint is never a fill or text on a light surface: the drawer keeps teal", () => {
    // Every Mint rule in the shell sheet is scoped to .sidebar or draws the brand tile.
    const code = shell.replace(/\/\*[\s\S]*?\*\//g, "");
    const mintRules = [
      ...code.matchAll(/(?:^|\n)([^{}@\n][^{}]*)\{([^}]*var\(--color-mint\)[^}]*)\}/g),
    ];
    expect(mintRules.length).toBeGreaterThan(0);
    for (const [, selector] of mintRules) {
      expect(selector.trim()).toMatch(/^\.sidebar\b|^\.brand-mark\b/);
    }
    expect(rule(shell, ".nav-entry--active::before")).toContain("var(--color-primary)");
  });

  test("the global focus ring is Mint on Ink and teal again inside the light scope menu", () => {
    expect(rule(shell, ".sidebar")).toContain("--color-focus-ring: var(--color-mint)");
    expect(rule(scope, ".scope-menu")).toContain("--color-focus-ring: var(--color-primary)");
  });

  test("forced colours: the grid and glow go, the edge and the marker stay", () => {
    const forced = shell.slice(shell.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/\.sidebar \{[^}]*background-image: none[^}]*CanvasText/s);
    expect(forced).toMatch(/\.nav-entry--active::before \{[^}]*background: Highlight/s);
    expect(forced).toMatch(/\.brand-mark \{[^}]*background: Canvas[^}]*CanvasText/s);
  });

  test("compact width: the scope row stays Ink but the Tower grid is dropped", () => {
    const compact = shell.slice(shell.indexOf("@media (max-width: 768px)"));
    expect(compact).toMatch(/\.sidebar \{[^}]*background-image: none/s);
    expect(compact).not.toMatch(/\.sidebar \{[^}]*background: var\(--color-surface-sunken\)/s);
  });

  test("the sidebar's scope button takes the Ink roles", () => {
    const button = rule(scope, ".sidebar .scope__btn");
    expect(button).toContain("color: var(--color-on-ink)");
    expect(rule(scope, ".sidebar .scope__tile")).toContain("color: var(--color-mint)");
  });
});
