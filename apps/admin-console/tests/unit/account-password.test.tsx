import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/client", () => ({
  changePassword: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => ({
    context: { user: { id: "u1", email: "hala@nile-retail.example", display_name: "Hala" } },
  }),
}));

import { AccountPage } from "@/account/AccountPage";
import { setLocale } from "@/i18n/locale";
import { changePassword, refreshSession, signOut } from "@/lib/client";
import { createQueryClient } from "@/lib/query";
import { resetRateLimit } from "@/lib/rate-limit";

/**
 * RT-807 (owner decisions PW-1, PW-4; boards Password-change and
 * Password-states 3-9): the «حسابي» page and its change-password form.
 */

const mockChange = vi.mocked(changePassword);
const mockRefresh = vi.mocked(refreshSession);
const mockSignOut = vi.mocked(signOut);

beforeEach(() => {
  setLocale("en");
  mockChange.mockReset();
  mockRefresh.mockReset();
  mockSignOut.mockReset();
  mockSignOut.mockResolvedValue({ status: 204, data: undefined, error: undefined } as never);
});
afterEach(() => {
  cleanup();
  resetRateLimit();
  setLocale("en");
});

function renderPage(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route path="/account" element={<AccountPage />} />
          <Route path="/signin" element={<p>sign-in page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

function fill(current: string, next: string, confirm: string): void {
  fireEvent.change(field("Current password"), { target: { value: current } });
  fireEvent.change(field("New password"), { target: { value: next } });
  fireEvent.change(field("Confirm new password"), { target: { value: confirm } });
}

async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  });
}

const result = (status: number, extra: Record<string, unknown> = {}) =>
  ({ status, data: undefined, error: undefined, ...extra }) as never;

describe("account page", () => {
  test("is «My account» for the signed-in address, with three password fields and the aside", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "My account" })).toBeDefined();
    const email = screen.getByText("hala@nile-retail.example");
    expect(email.tagName).toBe("BDI");
    expect(email.getAttribute("dir")).toBe("ltr");
    expect(field("Current password").autocomplete).toBe("current-password");
    expect(field("New password").autocomplete).toBe("new-password");
    expect(field("Confirm new password").autocomplete).toBe("new-password");
    // PW-2: the provider sets the rules; no meter, no rule list, no length bound.
    expect(screen.getByText("Your identity provider sets the password rules.")).toBeDefined();
    expect(field("New password").getAttribute("minlength")).toBeNull();
    expect(
      screen.getByRole("complementary", { name: "What happens after the change" }),
    ).toBeDefined();
  });

  test("a confirm that does not match is caught here and nothing is sent (PW-4)", async () => {
    renderPage();
    fill("old-secret", "new-secret-1", "new-secret-2");
    await submit();
    expect(mockChange).not.toHaveBeenCalled();
    expect(field("Confirm new password").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getAllByText("The new passwords do not match.").length).toBeGreaterThan(0);
  });

  test("empty fields are required and nothing is sent", async () => {
    renderPage();
    await submit();
    expect(mockChange).not.toHaveBeenCalled();
    expect(field("Current password").getAttribute("aria-invalid")).toBe("true");
  });

  test("204: says what succeeded, that other sessions were signed out, and clears the form", async () => {
    mockChange.mockResolvedValue(result(204));
    renderPage();
    fill("old-secret", "new-secret", "new-secret");
    await submit();
    expect(mockChange).toHaveBeenCalledWith({
      current_password: "old-secret",
      new_password: "new-secret",
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Password changed.");
    expect(status.textContent).toContain(
      "You were signed out of your other sessions. This session stays open.",
    );
    expect(field("Current password").value).toBe("");
    expect(field("New password").value).toBe("");
    expect(field("Confirm new password").value).toBe("");
  });

  test("400: one generic refusal, the fields are cleared and focus returns to the current password", async () => {
    mockChange.mockResolvedValue(
      result(400, { error: { error: { code: "validation_error", message: "x" } } }),
    );
    renderPage();
    fill("wrong", "new-secret", "new-secret");
    await submit();
    expect(screen.getByRole("alert").textContent).toContain("Could not change the password.");
    expect(field("Current password").value).toBe("");
    expect(field("New password").value).toBe("");
    expect(field("Confirm new password").value).toBe("");
    expect(document.activeElement).toBe(field("Current password"));
  });

  test("409: blocked with a reason, and the submit is unavailable", async () => {
    mockChange.mockResolvedValue(result(409));
    renderPage();
    fill("old-secret", "new-secret", "new-secret");
    await submit();
    expect(screen.getByText(/not linked to the identity provider yet/)).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Change password" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("429: no second banner on the page (the shell banner and the submit countdown say it)", async () => {
    mockChange.mockResolvedValue(result(429, { retryAfter: "240" }));
    renderPage();
    fill("old-secret", "new-secret", "new-secret");
    await submit();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Too many attempts/)).toBeNull();
  });

  test("503: says the change is not confirmed and keeps the fields for a retry", async () => {
    mockChange.mockResolvedValue(result(503));
    renderPage();
    fill("old-secret", "new-secret", "new-secret");
    await submit();
    expect(screen.getByText(/the password change is not confirmed/)).toBeDefined();
    expect(field("New password").value).toBe("new-secret");
  });

  test("401 after a failed refresh: signs out to the sign-in page", async () => {
    mockChange.mockResolvedValue(result(401));
    mockRefresh.mockResolvedValue(result(401));
    renderPage();
    fill("old-secret", "new-secret", "new-secret");
    await submit();
    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
    expect(await screen.findByText("sign-in page")).toBeDefined();
  });

  test("401 and a sign-out request that fails: still clears locally and goes to sign-in", async () => {
    mockChange.mockResolvedValue(result(401));
    mockRefresh.mockResolvedValue(result(401));
    mockSignOut.mockRejectedValue(new TypeError("Failed to fetch"));
    renderPage();
    fill("old-secret", "new-secret", "new-secret");
    await submit();
    expect(await screen.findByText("sign-in page")).toBeDefined();
  });

  test("401 and a refresh that never answers: not changed, no sign-out, never 'not confirmed'", async () => {
    mockChange.mockResolvedValue(result(401));
    mockRefresh.mockRejectedValue(new TypeError("Failed to fetch"));
    renderPage();
    fill("old-secret", "new-secret", "new-secret");
    await submit();
    expect(screen.getByText(/it was not changed/)).toBeDefined();
    expect(screen.queryByText(/not confirmed/)).toBeNull();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  test("editing a field clears its own error and keeps the others", async () => {
    renderPage();
    fireEvent.change(field("New password"), { target: { value: "new-secret-1" } });
    fireEvent.change(field("Confirm new password"), { target: { value: "new-secret-2" } });
    await submit();
    expect(field("Current password").getAttribute("aria-invalid")).toBe("true");
    expect(field("Confirm new password").getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(field("Confirm new password"), { target: { value: "new-secret-1" } });
    expect(field("Confirm new password").getAttribute("aria-invalid")).toBeNull();
    expect(field("Current password").getAttribute("aria-invalid")).toBe("true");
  });

  test("Arabic copy (UX-12): the page and the primary action", () => {
    setLocale("ar");
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "حسابي" })).toBeDefined();
    expect(screen.getByRole("button", { name: "تغيير كلمة المرور" })).toBeDefined();
    expect(screen.getByLabelText("تأكيد كلمة المرور الجديدة")).toBeDefined();
  });
});
