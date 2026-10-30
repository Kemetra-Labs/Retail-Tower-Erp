import { BootFailed } from "@/shell/BootFailed";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * RT-962: when the active locale's catalog can't be fetched, the Console shows
 * a catalog-free retry state in the painted language instead of message keys.
 */

afterEach(cleanup);

describe("BootFailed (RT-962)", () => {
  test("speaks the painted language without a catalog and retries on demand", () => {
    const retry = vi.fn();
    render(<BootFailed locale="en" onRetry={retry} />);
    expect(screen.getByRole("alert").textContent).toContain("could not load");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("Arabic is shown in Arabic only", () => {
    render(<BootFailed locale="ar" onRetry={() => undefined} />);
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).not.toMatch(/[A-Za-z]{2,}/);
  });
});
