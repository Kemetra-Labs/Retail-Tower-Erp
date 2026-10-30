import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BusyButton } from "@/components/BusyButton";
import { GatedButton } from "@/components/GatedButton";
import { reportRateLimited, resetRateLimit } from "@/lib/rate-limit";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * RT-959 (AC 2): one busy pattern. A pending button is aria-busy and
 * aria-disabled, never natively disabled, so it keeps keyboard focus; it
 * ignores repeat activation (a click, or Enter submitting its form) and shows
 * the shared spinner next to the caller's label.
 */
describe("BusyButton", () => {
  test("busy: announces busy, stays enabled and focusable, shows the spinner", () => {
    const { rerender } = render(<BusyButton className="btn-primary">Save</BusyButton>);
    const button = screen.getByRole("button", { name: "Save" });
    button.focus();
    rerender(
      <BusyButton className="btn-primary" busy>
        Saving…
      </BusyButton>,
    );
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(button);
    const spinner = button.querySelector(".spinner");
    expect(spinner?.getAttribute("aria-hidden")).toBe("true");
    expect(button.textContent).toContain("Saving…");
  });

  test("busy: a click never reaches the handler", () => {
    const onClick = vi.fn();
    render(
      <BusyButton busy onClick={onClick}>
        Save
      </BusyButton>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  test("busy: a submit button does not submit its form on a click", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <input aria-label="Name" />
        <BusyButton type="submit" busy>
          Save
        </BusyButton>
      </form>,
    );
    // Enter in a field submits through a click on the default button, so the
    // same guard covers it (proven in the browser: e2e busy-button.spec.ts).
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("idle: a plain button, no busy attributes, no spinner, handler runs", () => {
    const onClick = vi.fn();
    render(<BusyButton onClick={onClick}>Save</BusyButton>);
    const button = screen.getByRole("button");
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(button.querySelector(".spinner")).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("defaults to type=button", () => {
    render(<BusyButton>Go</BusyButton>);
    expect(screen.getByRole("button").getAttribute("type")).toBe("button");
  });
});

describe("GatedButton is a BusyButton", () => {
  afterEach(() => act(() => resetRateLimit()));

  test("busy passes through: focusable, aria-busy, no native disabled", () => {
    render(
      <GatedButton type="submit" busy>
        Save
      </GatedButton>,
    );
    const button = screen.getByRole("button", { name: /Save/ });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  test("a running Retry-After stays a native disable: unavailable, not busy", () => {
    render(<GatedButton>Apply</GatedButton>);
    act(() => reportRateLimited(30));
    const button = screen.getByRole("button", { name: /Apply/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });
});

/**
 * RT-959 (AC 6): busy is not unavailable, in forced colours too. The rules that
 * recess an unavailable button, and that turn it GrayText in forced colours,
 * must both exclude `[aria-busy="true"]`, and only on the aria-disabled branch:
 * a natively disabled button (a Retry-After during a request) always reads as
 * unavailable. (Hover and press rules name aria-disabled only to skip it.)
 */
describe("busy stays apart from unavailable in the styles", () => {
  const css = (file: string): string =>
    readFileSync(join(process.cwd(), "src/styles", file), "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
  /** Button rules that match an unavailable button and set its colour. */
  const unavailableRules = (source: string): string[] =>
    [...source.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .map((m) => ({ selector: m[1].replace(/\s+/g, " ").trim(), body: m[2] }))
      .filter(
        ({ selector, body }) =>
          selector.includes(".btn-primary") &&
          selector.includes('[aria-disabled="true"]') &&
          !/:(hover|active)/.test(selector) &&
          /(^|[;\s])color:/.test(body),
      )
      .map(({ selector }) => selector);

  test.each(["controls.css", "a11y.css"])(
    "%s: the unavailable rule skips a busy button",
    (file) => {
      const rules = unavailableRules(css(file));
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(rule).toContain('[aria-disabled="true"]:not([aria-busy="true"])');
        expect(rule).not.toMatch(/\):not\(\[aria-busy="true"\]\)/);
      }
    },
  );
});
