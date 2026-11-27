import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/client", () => ({
  signIn: vi.fn(),
  requestPasswordReset: vi.fn(),
  confirmPasswordReset: vi.fn(),
}));

import { ForgotPassword } from "@/auth/ForgotPassword";
import { ResetPassword } from "@/auth/ResetPassword";
import { SignIn } from "@/auth/SignIn";
import { setLocale } from "@/i18n/locale";
import * as client from "@/lib/client";

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("ar");
});

afterEach(() => {
  cleanup();
  setLocale("en");
});

function renderForgot(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/forgot-password"]}>
      <ForgotPassword />
    </MemoryRouter>,
  );
}

function renderReset(entry: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ResetPassword />
    </MemoryRouter>,
  );
}

describe("SignIn forgot-password link (RT-1497)", () => {
  test("renders link to /forgot-password in Arabic and English", () => {
    render(
      <MemoryRouter initialEntries={["/signin"]}>
        <SignIn onResolved={vi.fn()} />
      </MemoryRouter>,
    );
    const linkAr = screen.getByRole("link", { name: "نسيت كلمة المرور؟" });
    expect(linkAr.getAttribute("href")).toBe("/forgot-password");

    cleanup();
    setLocale("en");
    render(
      <MemoryRouter initialEntries={["/signin"]}>
        <SignIn onResolved={vi.fn()} />
      </MemoryRouter>,
    );
    const linkEn = screen.getByRole("link", { name: "Forgot password?" });
    expect(linkEn.getAttribute("href")).toBe("/forgot-password");
  });
});

describe("ForgotPassword screen (RT-1497)", () => {
  test("renders Arabic-first form with LTR email input, main landmark, and h1", () => {
    renderForgot();
    expect(screen.getByRole("heading", { level: 1, name: "استعادة كلمة المرور" })).toBeDefined();
    const email = screen.getByLabelText("البريد الإلكتروني") as HTMLInputElement;
    expect(email.getAttribute("dir")).toBe("ltr");
    expect(email.getAttribute("type")).toBe("email");
    expect(screen.getByRole("main").querySelector("form")).not.toBeNull();
    expect(screen.getByRole("link", { name: "العودة إلى تسجيل الدخول" }).getAttribute("href")).toBe(
      "/signin",
    );
  });

  test("validates empty and malformed email without calling the backend", async () => {
    renderForgot();
    fireEvent.click(screen.getByRole("button", { name: "إرسال رابط الاستعادة" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("أدخل البريد الإلكتروني.");
    expect(client.requestPasswordReset).not.toHaveBeenCalled();
    expect(screen.getByLabelText("البريد الإلكتروني").getAttribute("aria-invalid")).toBe("true");
  });

  test("returns the same opaque confirmation for an unknown address (no enumeration)", async () => {
    vi.mocked(client.requestPasswordReset).mockResolvedValue({ status: 202 } as never);
    renderForgot();

    fireEvent.change(screen.getByLabelText("البريد الإلكتروني"), {
      target: { value: "nobody@unknown.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "إرسال رابط الاستعادة" }));

    await waitFor(() =>
      expect(client.requestPasswordReset).toHaveBeenCalledWith({
        email: "nobody@unknown.example",
      }),
    );
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status.textContent).toContain("تحقّق من بريدك الإلكتروني."));
    expect(status.textContent).toContain("إذا كان هذا البريد الإلكتروني مرتبطًا بحساب لديك");

    // Clicking "try another" returns to the form cleanly.
    fireEvent.click(screen.getByRole("button", { name: "إرسال إلى بريد إلكتروني آخر" }));
    expect(screen.getByLabelText("البريد الإلكتروني")).toBeDefined();
  });

  test("surfaces 429 rate-limit banner and disables submit with countdown", async () => {
    vi.mocked(client.requestPasswordReset).mockResolvedValue({
      status: 429,
      retryAfterSeconds: 19,
      error: { error: { request_id: "req-fp-429" } },
    } as never);
    renderForgot();

    fireEvent.change(screen.getByLabelText("البريد الإلكتروني"), {
      target: { value: "ops@store.eg" },
    });
    fireEvent.click(screen.getByRole("button", { name: "إرسال رابط الاستعادة" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("req-fp-429");
    const btn = screen.getByRole("button", { name: /19/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  test("surfaces 503 unavailable error with request_id in English", async () => {
    setLocale("en");
    vi.mocked(client.requestPasswordReset).mockResolvedValue({
      status: 503,
      error: { error: { request_id: "req-fp-503" } },
    } as never);
    renderForgot();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ops@store.eg" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("temporarily unavailable");
    expect(alert.textContent).toContain("req-fp-503");
  });
});

describe("ResetPassword screen (RT-1497)", () => {
  test("missing token shows invalid-link state with links to request a new link and sign in", () => {
    renderReset("/reset-password");
    expect(screen.getByRole("heading", { level: 1, name: "رابط غير صالح" })).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("رابط إعادة التعيين غير صالح");
    expect(screen.getByRole("link", { name: "طلب رابط جديد" }).getAttribute("href")).toBe(
      "/forgot-password",
    );
    expect(screen.getByRole("link", { name: "العودة إلى تسجيل الدخول" }).getAttribute("href")).toBe(
      "/signin",
    );
  });

  test("validates password mismatch before calling backend and keeps inputs LTR", async () => {
    renderReset("/reset-password?t=tok-123");
    const next = screen.getByLabelText("كلمة المرور الجديدة") as HTMLInputElement;
    const confirm = screen.getByLabelText("تأكيد كلمة المرور الجديدة") as HTMLInputElement;
    expect(next.getAttribute("dir")).toBe("ltr");
    expect(confirm.getAttribute("dir")).toBe("ltr");

    fireEvent.change(next, { target: { value: "StrongPass1!" } });
    fireEvent.change(confirm, { target: { value: "DifferentPass1!" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ كلمة المرور الجديدة" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("كلمتا المرور الجديدتان غير متطابقتين.");
    expect(client.confirmPasswordReset).not.toHaveBeenCalled();
  });

  test("submits Descope ?t= token verbatim and shows success confirmation on 204", async () => {
    vi.mocked(client.confirmPasswordReset).mockResolvedValue({ status: 204 } as never);
    renderReset("/reset-password?t=descope-token-xyz");

    fireEvent.change(screen.getByLabelText("كلمة المرور الجديدة"), {
      target: { value: "  KeepSpaces1!  " },
    });
    fireEvent.change(screen.getByLabelText("تأكيد كلمة المرور الجديدة"), {
      target: { value: "  KeepSpaces1!  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "حفظ كلمة المرور الجديدة" }));

    await waitFor(() =>
      expect(client.confirmPasswordReset).toHaveBeenCalledWith({
        token: "descope-token-xyz",
        new_password: "  KeepSpaces1!  ",
      }),
    );
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status.textContent).toContain("تم تحديث كلمة المرور."));
    expect(
      screen.getByRole("link", { name: "الانتقال إلى تسجيل الدخول" }).getAttribute("href"),
    ).toBe("/signin");
  });

  test("accepts native ?token= and renders generic 400 error with request_id", async () => {
    setLocale("en");
    vi.mocked(client.confirmPasswordReset).mockResolvedValue({
      status: 400,
      error: { error: { code: "invalid_token", request_id: "req-rp-400" } },
    } as never);
    renderReset("/reset-password?token=expired-tok");

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "ValidPass1!" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "ValidPass1!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));

    await waitFor(() =>
      expect(client.confirmPasswordReset).toHaveBeenCalledWith({
        token: "expired-tok",
        new_password: "ValidPass1!",
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("invalid or expired");
    expect(alert.textContent).toContain("req-rp-400");
  });
});
