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

  test("the art panel is decoration, the form is the main landmark, and there is no card", () => {
    const { container } = render(<SignIn onResolved={vi.fn()} />);
    const art = container.querySelector(".auth-art") as HTMLElement;
    expect(art.getAttribute("aria-hidden")).toBe("true");
    // Decorative: the wordmark beside the form already names the product.
    expect(art.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(screen.getByRole("main").querySelector("form")).not.toBeNull();
    expect(container.querySelector(".signin-card")).toBeNull();
  });

  test("the public frame is always dark: it sets the dark theme on its own wrapper", () => {
    const { container } = render(<SignIn onResolved={vi.fn()} />);
    // `[data-theme="dark"]` is an attribute selector, so the wrapper alone remaps
    // every role token (and the mint primary button) in both themes. The user's
    // theme is not known before sign-in.
    const page = container.querySelector(".auth-page") as HTMLElement;
    expect(page.getAttribute("data-theme")).toBe("dark");
  });

  test("the sign-in screen greets the user and shows the branch line, without internals", () => {
    const { container } = render(<SignIn onResolved={vi.fn()} />);
    expect(screen.getByText("Welcome back")).toBeDefined();
    expect(screen.getByText("Every branch, under your eye")).toBeDefined();
    // What happens behind the till is not told to the client on a public screen.
    expect(container.textContent ?? "").not.toMatch(/ERPNext|pipeline/i);
    // The logo and the artwork are real same-origin files, never `data:` URIs
    // (the Caddy CSP is `default-src 'self'`, so a `data:` image is blocked).
    const layout = readSource("src/auth/AuthLayout.tsx");
    expect(layout).toMatch(/signin-art\.webp\?no-inline/);
    expect(layout).toMatch(/logo-shield\.webp\?no-inline/);
  });

  test("the stylesheet uses tokens only: no card shadow, no raw colours", () => {
    const css = readSource("src/auth/signin.css");
    expect(css).not.toMatch(/box-shadow/);
    expect(css).not.toMatch(/--shadow-overlay/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    // The night ground comes from the Ink token (no new global token), and a
    // wordmark carries no tracking (RT-397).
    expect(css).toMatch(/--auth-night: color-mix\(in oklab, var\(--color-ink\)/);
    expect(css).not.toMatch(/letter-spacing/);
  });

  test("the shared password toggle stays readable on a light surface", () => {
    // PasswordInput is also used by the signed-in Account page (light, no dark
    // wrapper), and its rules live in signin.css. They must read the remapping
    // roles; the Ink-only roles are near-invisible on white.
    const css = readSource("src/auth/signin.css");
    const toggle = css.match(/\.password-input__toggle \{[^}]*\}/)?.[0] ?? "";
    expect(toggle).toMatch(/color: var\(--color-text-muted\)/);
    expect(css).not.toMatch(/\.password-input__toggle[^{]*\{[^}]*--color-(ink-muted|on-ink)/);
    // The public screens' touch-height variant must come after the field rule it
    // has to beat, or the field's inline padding runs the text under the toggle.
    expect(css.indexOf(".auth-fields .password-input__control")).toBeGreaterThan(
      css.indexOf(".auth-fields .input {"),
    );
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
