import { FilterBar, FilterField } from "@/components/FilterBar";
import { reportRateLimited, resetRateLimit } from "@/lib/rate-limit";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * RT-960: one FilterBar for every list. It is presentational: the screen owns
 * the draft, the URL and the validation. It gives one Apply (rate-limit gated)
 * and a ghost Clear, an optional «فلاتر إضافية» disclosure with the count of
 * active hidden filters, and removable chips for the applied filters.
 */
function renderBar(props: Partial<React.ComponentProps<typeof FilterBar>> = {}) {
  const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
  const onClear = vi.fn();
  render(
    <FilterBar label="Device filters" onSubmit={onSubmit} onClear={onClear} {...props}>
      <FilterField id="f-store" label="Store">
        <select id="f-store" className="input">
          <option value="">All</option>
        </select>
      </FilterField>
    </FilterBar>,
  );
  return { onSubmit, onClear };
}

describe("FilterBar", () => {
  afterEach(() => act(() => resetRateLimit()));

  test("a labelled filter form in a section panel, never a dirty-guard form", () => {
    renderBar();
    const form = screen.getByRole("form", { name: "Device filters" });
    expect(form.closest(".section-panel")).not.toBeNull();
    expect(form.getAttribute("data-dirty-guard")).toBe("off");
    expect(form.hasAttribute("novalidate")).toBe(true);
    expect(screen.getByLabelText("Store")).toBeDefined();
  });

  test("one Apply (primary, submit) and a ghost Clear", () => {
    const { onSubmit, onClear } = renderBar();
    const apply = screen.getByRole("button", { name: "Apply" });
    const clear = screen.getByRole("button", { name: "Clear" });
    expect(apply.className).toContain("btn-primary");
    expect(apply.getAttribute("type")).toBe("submit");
    expect(clear.className).toContain("btn-ghost");
    fireEvent.click(apply);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  test("Apply is gated while a Retry-After runs (RT-621)", () => {
    renderBar();
    act(() => reportRateLimited(30));
    expect(screen.getByRole("button", { name: /Apply/ }).hasAttribute("disabled")).toBe(true);
  });

  test("no extra filters: no disclosure", () => {
    renderBar();
    expect(screen.queryByRole("button", { name: /More filters/ })).toBeNull();
  });

  test("the disclosure: collapsed, names its active count, hides (not unmounts) the fields", () => {
    renderBar({
      extraActive: 2,
      extra: (
        <FilterField id="f-sync" label="Sync">
          <input id="f-sync" className="input" />
        </FilterField>
      ),
    });
    const toggle = screen.getByRole("button", { name: "More filters, 2 active" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const region = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(region?.hidden).toBe(true);
    // Hidden fields stay in the form, so their values still apply.
    expect(region?.querySelector("#f-sync")).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(region?.hidden).toBe(false);
  });

  test("no active hidden filter: the toggle names no count", () => {
    renderBar({ extraActive: 0, extra: <span>x</span> });
    expect(screen.getByRole("button", { name: "More filters" })).toBeDefined();
  });

  test("an error in a hidden field opens the disclosure", () => {
    renderBar({ extra: <span>x</span>, extraOpen: true });
    expect(screen.getByRole("button", { name: "More filters" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  test("chips: each applied filter, removable unless required; removing calls back", () => {
    const onRemove = vi.fn();
    renderBar({
      chips: [
        { key: "store", label: "Store: Dubai Mall" },
        { key: "trust", label: "Trust: Revoked", onRemove },
      ],
    });
    const list = screen.getByRole("list", { name: "Applied filters" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(list).queryByRole("button", { name: "Remove filter Store: Dubai Mall" }),
    ).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: "Remove filter Trust: Revoked" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  test("the result slot renders beside the chips", () => {
    renderBar({ result: <output>3 loaded</output> });
    expect(screen.getByText("3 loaded")).toBeDefined();
  });

  test("Apply can be busy (BusyButton): focus kept, no native disable", () => {
    renderBar({ busy: true });
    const apply = screen.getByRole("button", { name: /Apply/ });
    expect(apply.getAttribute("aria-busy")).toBe("true");
    expect(apply.hasAttribute("disabled")).toBe(false);
  });
});
