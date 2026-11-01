import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/client", () => ({
  signIn: vi.fn(),
  acceptInvitation: vi.fn(),
  listMembers: vi.fn(),
  revokeMembership: vi.fn(),
  updateMembership: vi.fn(),
}));

import { AcceptInvitation } from "@/auth/AcceptInvitation";
import { SignIn } from "@/auth/SignIn";
import { getLocale, setLocale } from "@/i18n/locale";
import { createQueryClient } from "@/lib/query";
import { readSource } from "./source-scan";

/**
 * RT-971 (canvas «تسجيل الدخول»): sign-in and accept-invitation on the shared
 * public frame. A language switch on the page, a show-password toggle, no dots
 * placeholder, a decorative brand panel, no card. The auth flow is unchanged
 * (signin-component.test.tsx, signin-route.test.tsx).
 */

beforeEach(() => setLocale("en"));
afterEach(() => {
  cleanup();
  setLocale("en");
});

function renderAccept(entry: string): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <AcceptInvitation />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("sign-in screen", () => {
  test("the password has no placeholder and a show-password toggle", () => {
    render(<SignIn onResolved={vi.fn()} />);
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.getAttribute("placeholder")).toBeNull();
    expect(password.type).toBe("password");
    expect(password.getAttribute("dir")).toBe("ltr");

    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("password");

    fireEvent.click(toggle);
    expect(password.type).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    // The name stays; the pressed state says which way it is.
    expect(toggle.getAttribute("aria-label")).toBe("Show password");
    fireEvent.click(toggle);
    expect(password.type).toBe("password");
  });

  test("the language switch is on the page and changes the locale", () => {
    render(<SignIn onResolved={vi.fn()} />);
    const sw = screen.getByRole("button", { name: "التبديل إلى العربية" });
    expect(sw.getAttribute("lang")).toBe("ar-EG");
    act(() => fireEvent.click(sw));
    expect(getLocale()).toBe("ar");
    expect(screen.getByRole("heading", { level: 1, name: "تسجيل الدخول" })).toBeDefined();
    expect(screen.getByRole("button", { name: "إظهار كلمة المرور" })).toBeDefined();
  });

  test("the brand panel is decoration, the form is the main landmark, and there is no card", () => {
    const { container } = render(<SignIn onResolved={vi.fn()} />);
    const brand = container.querySelector(".auth-brand-panel") as HTMLElement;
    expect(brand.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("main").querySelector("form")).not.toBeNull();
    expect(container.querySelector(".signin-card")).toBeNull();
    expect(screen.getByText(/There is no self sign-up/)).toBeDefined();
  });

  test("RT-807 (PW-5): the brand panel is flat Ink in both themes, with no mark, grid or glow", () => {
    const { container } = render(<SignIn onResolved={vi.fn()} />);
    const brand = container.querySelector(".auth-brand-panel") as HTMLElement;
    expect(brand.querySelector("svg")).toBeNull();
    const css = readSource("src/auth/signin.css");
    const panel = css.match(/\.auth-brand-panel \{[^}]*\}/)?.[0] ?? "";
    expect(panel).toMatch(/--brand-bg: var\(--color-ink\)/);
    expect(panel).toMatch(/--brand-fg: var\(--color-on-ink\)/);
    expect(css).not.toMatch(/\[data-theme="dark"\] \.auth-brand-panel/);
    expect(css).not.toMatch(/gradient|auth-brand-panel__mark/);
  });

  test("the stylesheet keeps the canvas grammar: no card shadow, no spelled control sizes", () => {
    const css = readSource("src/auth/signin.css");
    expect(css).not.toMatch(/box-shadow/);
    expect(css).not.toMatch(/--shadow-overlay/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe("accept-invitation screen", () => {
  test("same frame: language switch, password toggle, the requirement as a hint", () => {
    renderAccept("/accept-invitation?token=valid-token");
    expect(screen.getByRole("heading", { level: 1, name: "Accept your invitation" })).toBeDefined();
    expect(screen.getByRole("button", { name: "التبديل إلى العربية" })).toBeDefined();
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.getAttribute("placeholder")).toBeNull();
    expect(password.getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByRole("button", { name: "Show password" })).toBeDefined();
    expect(document.getElementById("password-hint")?.textContent).toBe(
      "Required for a new account.",
    );
  });

  test("an invalid link keeps the frame and a way to sign in", () => {
    renderAccept("/accept-invitation");
    expect(screen.getByRole("heading", { level: 1, name: "Invitation" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Go to sign in" }).getAttribute("href")).toBe(
      "/signin",
    );
    expect(screen.queryByRole("button", { name: "Show password" })).toBeNull();
  });
});
