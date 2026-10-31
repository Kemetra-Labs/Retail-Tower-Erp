import { Banner } from "@/components/Banner";
import { InlineError } from "@/components/InlineError";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";

/**
 * Error/notification surface (T011, FR-003-007/008, VD-4/VD-5).
 * Persistent banner (not toast); surfaces the backend request_id.
 * Plain Testing Library queries (no jest-dom — not an approved dep).
 */
describe("Banner", () => {
  test("renders the message and the backend request_id", () => {
    render(<Banner variant="danger" message="Sign-in failed." requestId="9f3c1a7e-4b22" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Sign-in failed.");
    expect(alert.textContent).toContain("9f3c1a7e-4b22");
  });

  test("omits the request_id line when none is given", async () => {
    render(<Banner variant="info" message="Heads up." />);
    const status = screen.getByRole("status");
    await waitFor(() => expect(status.textContent).toContain("Heads up."));
    expect(status.textContent).not.toMatch(/request_id/i);
  });

  // RT-963 (WCAG 4.1.3): danger and warning interrupt, inserted populated.
  test.each(["danger", "warning"] as const)("a %s banner is an alert at once", (variant) => {
    render(<Banner variant={variant} message="Notice." />);
    expect(screen.getByRole("alert").textContent).toContain("Notice.");
  });

  // Success and info are polite: the status region mounts empty and the text
  // lands in it afterwards, so a screen reader that tracks it announces it.
  test.each(["success", "info"] as const)(
    "a %s banner is a status region that fills after mount",
    async (variant) => {
      render(<Banner variant={variant} message="Notice." />);
      const status = screen.getByRole("status");
      expect(status.textContent).toBe("");
      await waitFor(() => expect(status.textContent).toContain("Notice."));
    },
  );

  // RT-978: a banner that stays mounted while its severity moves from alert to
  // status (a stale snapshot becoming «no warehouse mapping») is a new status
  // region: its text must land after the empty first commit as well.
  test("a banner that moves from warning to info refills its status region after an empty commit", async () => {
    const { rerender } = render(<Banner variant="warning" message="Stale." />);
    expect(screen.getByRole("alert").textContent).toContain("Stale.");
    rerender(<Banner variant="info" message="Not mapped." />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    await waitFor(() => expect(status.textContent).toContain("Not mapped."));
  });

  test("a banner that moves from info to danger is an alert populated at once", async () => {
    const { rerender } = render(<Banner variant="info" message="Fine." />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Fine."));
    rerender(<Banner variant="danger" message="Broken." />);
    expect(screen.getByRole("alert").textContent).toContain("Broken.");
  });
});

describe("InlineError", () => {
  test("renders nothing when there is no error", () => {
    const { container } = render(<InlineError message={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders the field error text when present", () => {
    render(<InlineError message="Email is required." />);
    expect(screen.getByText("Email is required.")).toBeDefined();
  });
});
