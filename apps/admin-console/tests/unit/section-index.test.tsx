import { DetailPanel } from "@/components/DetailPanel";
import { ReceiptCard } from "@/components/ReceiptCard";
import { SectionIndex, sectionIndexLabel } from "@/components/SectionIndex";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";

/**
 * RT-1009 (DESIGN.md v4.0 §12.2) the section index badge: decoration beside a
 * section's heading. The digits are hidden from assistive tech, so the heading
 * stays the section's only name.
 */
describe("SectionIndex (RT-1009)", () => {
  test("two Latin digits for a 1-based position", () => {
    expect(sectionIndexLabel(1)).toBe("01");
    expect(sectionIndexLabel(6)).toBe("06");
    expect(sectionIndexLabel(12)).toBe("12");
  });

  test("the badge is aria-hidden", () => {
    const { container } = render(<SectionIndex position={3} />);
    const badge = container.querySelector(".section-index") as HTMLElement;
    expect(badge.textContent).toBe("03");
    expect(badge.getAttribute("aria-hidden")).toBe("true");
  });

  test("in a detail panel it sits beside the heading, never inside its name", () => {
    render(
      <DetailPanel id="p" title="Lines" index={3}>
        <p>body</p>
      </DetailPanel>,
    );
    const region = screen.getByRole("region", { name: "Lines" });
    const heading = within(region).getByRole("heading", { level: 2, name: "Lines" });
    const badge = region.querySelector(".section-index") as HTMLElement;
    expect(badge.textContent).toBe("03");
    expect(heading.contains(badge)).toBe(false);
    expect(badge.nextElementSibling).toBe(heading);
  });

  test("a panel without an index has no badge", () => {
    const { container } = render(
      <DetailPanel id="p" title="Events">
        <p>body</p>
      </DetailPanel>,
    );
    expect(container.querySelector(".section-index")).toBeNull();
  });

  test("a receipt card as a page section: a region named by its h2, with the badge beside it", () => {
    render(
      <ReceiptCard section index={2} label="Payments" figure="250.00 EGP">
        <p>tenders</p>
      </ReceiptCard>,
    );
    const region = screen.getByRole("region", { name: "Payments" });
    expect(region.tagName).toBe("SECTION");
    const heading = within(region).getByRole("heading", { level: 2, name: "Payments" });
    const badge = region.querySelector(".section-index") as HTMLElement;
    expect(badge.textContent).toBe("02");
    expect(heading.contains(badge)).toBe(false);
    expect(screen.queryByRole("article")).toBeNull();
  });

  test("a plain receipt card keeps its article and takes no badge", () => {
    render(
      <ReceiptCard index={2} label="Invoices" figure="12">
        <p>delta</p>
      </ReceiptCard>,
    );
    expect(screen.getByRole("article", { name: "Invoices" })).toBeDefined();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(document.querySelector(".section-index")).toBeNull();
  });
});
