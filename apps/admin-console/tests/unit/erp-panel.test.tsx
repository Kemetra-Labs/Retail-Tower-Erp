import { Panel } from "@/erp-status/parts";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

/**
 * RT-1011: the ERP status `Panel` is shared with the mappings and the product
 * reconciliation screens. The section index is opt-in, so those screens keep
 * their heading exactly as it was.
 */
describe("ERP status Panel", () => {
  test("without an index there is no badge, and the heading names the region", () => {
    render(
      <Panel id="p" title="Item mappings">
        <p>body</p>
      </Panel>,
    );
    expect(document.querySelector(".section-index")).toBeNull();
    expect(screen.getByRole("region", { name: "Item mappings" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Item mappings" })).toBeDefined();
  });

  test("with an index the badge is decoration beside the heading, never in its name", () => {
    render(
      <Panel id="p" title="Item mappings" index={3}>
        <p>body</p>
      </Panel>,
    );
    const badge = document.querySelector(".section-index");
    expect(badge?.textContent).toBe("03");
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("heading", { name: "Item mappings" })).toBeDefined();
  });
});
