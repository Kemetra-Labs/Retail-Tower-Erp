import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReceiptCard } from "@/components/ReceiptCard";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";

/**
 * RT-992 (DESIGN.md §12.2, D-V5) the receipt card: one `<article>` named by its
 * label, a perforation between the figure and its comparison, and notches that
 * are decoration only. jsdom computes no stylesheet, so the forced-colours
 * contract is pinned as CSS text.
 */
const css = readFileSync(join(process.cwd(), "src/components/receipt-card.css"), "utf8")
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

function renderCard() {
  return render(
    <ReceiptCard
      label="Invoices"
      figure={<bdi dir="ltr">33,918</bdi>}
      icon={<svg data-testid="tile-icon" />}
    >
      <span>↑ 12% vs September</span>
    </ReceiptCard>,
  );
}

describe("ReceiptCard structure", () => {
  test("is one article named by its label", () => {
    renderCard();
    const card = screen.getByRole("article", { name: "Invoices" });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    const labelId = card.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId ?? "")?.textContent).toBe("Invoices");
  });

  test("carries the figure and the comparison as text", () => {
    renderCard();
    const card = screen.getByRole("article", { name: "Invoices" });
    expect(within(card).getByText("33,918")).toBeTruthy();
    expect(within(card).getByText("↑ 12% vs September")).toBeTruthy();
  });

  test("the icon tile is decoration", () => {
    renderCard();
    expect(screen.getByTestId("tile-icon").closest('[aria-hidden="true"]')).not.toBeNull();
  });

  test("the card has no icon tile when none is given", () => {
    const { container } = render(
      <ReceiptCard label="Invoices" figure="1">
        x
      </ReceiptCard>,
    );
    expect(container.querySelector(".receipt-card__icon")).toBeNull();
  });

  test("two notches, both aria-hidden, and nothing in them to read", () => {
    const { container } = renderCard();
    const notches = container.querySelectorAll(".receipt-card__notch");
    expect(notches).toHaveLength(2);
    for (const notch of notches) {
      expect(notch.getAttribute("aria-hidden")).toBe("true");
      expect(notch.textContent).toBe("");
    }
  });

  test("two cards keep distinct names", () => {
    render(
      <>
        <ReceiptCard label="Invoices" figure="1">
          a
        </ReceiptCard>
        <ReceiptCard label="Average invoice" figure="2">
          b
        </ReceiptCard>
      </>,
    );
    expect(screen.getByRole("article", { name: "Invoices" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "Average invoice" })).toBeTruthy();
  });
});

describe("ReceiptCard stylesheet", () => {
  test("a 2px dashed perforation between the two parts", () => {
    expect(rule(css, ".receipt-card__rule")).toMatch(/border-block-start:\s*2px dashed/);
  });

  test("panel radius, resting elevation and surface come from role tokens", () => {
    const card = rule(css, ".receipt-card");
    expect(card).toMatch(/background:\s*var\(--color-surface\)/);
    expect(card).toMatch(/border-radius:\s*var\(--radius-panel\)/);
    expect(card).toMatch(/box-shadow:\s*var\(--shadow-resting\)/);
  });

  test("the notch is filled with the canvas role, never a literal", () => {
    expect(css).toMatch(/--receipt-notch-fill:\s*var\(--color-canvas\)/);
  });

  test("forced colours: notches disappear", () => {
    expect(rule(media("forced-colors: active"), ".receipt-card__notch")).toMatch(/display:\s*none/);
  });

  test("forced colours: the perforation is a CanvasText dashed rule", () => {
    expect(rule(media("forced-colors: active"), ".receipt-card__rule")).toMatch(
      /border-block-start:\s*2px dashed CanvasText/,
    );
  });

  test("no hex or rgb literal", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
