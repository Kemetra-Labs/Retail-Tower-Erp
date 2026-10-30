import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PipelineRail, type PipelineRailNode } from "@/components/PipelineRail";
import { setLocale } from "@/i18n/locale";
import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";

/**
 * RT-992 (DESIGN.md §12.2, D-V5) the pipeline rail: POS → server → ERPNext as
 * three nodes in a named group. The status dot and the dotted connector are
 * decoration; each node's fact is text, so the rail reads without colour. The
 * connector pulse is pinned as CSS text because jsdom computes no stylesheet.
 */
const css = readFileSync(join(process.cwd(), "src/components/pipeline-rail.css"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first `@media (query)` block, brace-balanced. */
function media(query: string): string {
  const start = css.indexOf(`@media (${query})`);
  if (start < 0) throw new Error(`@media (${query}) not found`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced");
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`rule ${selector} not found`);
  return source.slice(start, source.indexOf("}", start));
}

const FACTS = ["6 of 7 online", "Up to date", "3 stopped"] as const;

const NODES: readonly PipelineRailNode[] = [
  { id: "pos", status: "attention", fact: FACTS[0] },
  { id: "server", status: "ok", fact: FACTS[1] },
  { id: "erp", status: "failed", fact: FACTS[2] },
];

describe("PipelineRail structure", () => {
  test("is a group named for the sale pipeline", () => {
    render(<PipelineRail nodes={NODES} />);
    expect(screen.getByRole("group", { name: "Sale pipeline" })).toBeTruthy();
  });

  test("the group is named «مسار البيع» in Arabic", () => {
    act(() => setLocale("ar"));
    render(<PipelineRail nodes={NODES} />);
    expect(screen.getByRole("group", { name: "مسار البيع" })).toBeTruthy();
  });

  test("three nodes in order: POS, server, ERPNext", () => {
    render(<PipelineRail nodes={NODES} />);
    const items = within(screen.getByRole("group", { name: "Sale pipeline" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(3);
    expect(items.map((li) => li.querySelector(".pipeline-rail__name")?.textContent)).toEqual([
      "POS",
      "Server",
      "ERPNext",
    ]);
  });

  test("every node's fact is present as text", () => {
    render(<PipelineRail nodes={NODES} />);
    const items = screen.getAllByRole("listitem");
    FACTS.forEach((fact, i) => {
      expect(items[i]?.textContent).toContain(fact);
      expect(within(items[i] as HTMLElement).getByText(fact)).toBeTruthy();
    });
  });

  test("a node reads as name then fact", () => {
    render(<PipelineRail nodes={NODES} />);
    const first = screen.getAllByRole("listitem")[0] as HTMLElement;
    expect(first.textContent?.replace(/\s+/g, " ").trim()).toBe("POS 6 of 7 online");
  });

  test("dots and the two connectors are aria-hidden", () => {
    const { container } = render(<PipelineRail nodes={NODES} />);
    const dots = container.querySelectorAll(".pipeline-rail__dot");
    const links = container.querySelectorAll(".pipeline-rail__link");
    expect(dots).toHaveLength(3);
    expect(links).toHaveLength(2);
    for (const el of [...dots, ...links]) expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  test("the dot carries the status as data for its colour only", () => {
    const { container } = render(<PipelineRail nodes={NODES} />);
    const statuses = [...container.querySelectorAll(".pipeline-rail__dot")].map((d) =>
      d.getAttribute("data-status"),
    );
    expect(statuses).toEqual(["attention", "ok", "failed"]);
  });
});

describe("PipelineRail stylesheet", () => {
  test("connectors are a dotted line", () => {
    expect(rule(css, ".pipeline-rail__link")).toMatch(/dotted/);
  });

  test("reduced motion: the pulse does not run", () => {
    const animated = media("prefers-reduced-motion: no-preference");
    expect(animated).toMatch(/animation:\s*pipeline-rail-pulse/);
    const outside = css.replace(animated, "");
    expect(outside).not.toMatch(/animation\s*:/);
    expect(outside).not.toMatch(/@keyframes/);
  });

  test("forced colours: the dot falls back to CanvasText", () => {
    expect(rule(media("forced-colors: active"), ".pipeline-rail__dot")).toMatch(/CanvasText/);
  });

  test("no hex or rgb literal", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
