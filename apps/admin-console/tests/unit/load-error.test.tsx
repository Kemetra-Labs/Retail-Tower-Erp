import { LoadErrorBanner } from "@/components/LoadErrorBanner";
import { ReadingNote } from "@/components/ReadingNote";
import { setLocale } from "@/i18n/locale";
import type { LoadFailure } from "@/lib/error-recovery";
import { PanelError } from "@/overview/PanelParts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * RT-965 (DESIGN.md §8): a load error reads What → Safety → Action → Evidence, in both locales.
 * A network failure and a 500 are the two captures of the audit; a 4xx is the non-retryable case.
 */
const NETWORK: LoadFailure = { cause: "network", retryable: true };
const SERVER: LoadFailure = { cause: "server", retryable: true, requestId: "req-500" };
const REFUSED: LoadFailure = { cause: "request", retryable: false, requestId: "req-422" };

afterEach(() => {
  cleanup();
  setLocale("en");
});

describe("LoadErrorBanner", () => {
  test("500 (en): what, cause, safety, a retry, and the request id", () => {
    setLocale("en");
    const retry = vi.fn();
    render(
      <LoadErrorBanner
        what="Devices could not be loaded."
        failure={SERVER}
        retryLabel="Retry"
        onRetry={retry}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Devices could not be loaded.");
    expect(alert.textContent).toContain("The server returned an error.");
    expect(alert.textContent).toContain("Nothing was changed.");
    expect(alert.textContent).toContain("req-500");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("network failure (ar): Arabic cause and safety, a retry, no request id to show", () => {
    setLocale("ar");
    render(
      <LoadErrorBanner
        what="تعذّر تحميل الأجهزة."
        failure={NETWORK}
        retryLabel="إعادة المحاولة"
        onRetry={() => {}}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("تعذّر الوصول إلى الخادم.");
    expect(alert.textContent).toContain("لم يتغيّر شيء.");
    expect(alert.textContent).not.toContain("المرجع");
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeTruthy();
  });

  test.each(["en", "ar"] as const)("a non-retryable failure (%s) offers no retry", (locale) => {
    setLocale(locale);
    render(<LoadErrorBanner what="x" failure={REFUSED} retryLabel="Retry" onRetry={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("req-422");
  });
});

describe("PanelError", () => {
  test("a retryable failure keeps the retry and the reference", () => {
    render(<PanelError requestId="req-500" failure={SERVER} retry={() => {}} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn't load this part.");
    expect(alert.textContent).toContain("Nothing was changed.");
    expect(alert.textContent).toContain("req-500");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  test("a non-retryable failure says so and offers no retry", () => {
    render(<PanelError requestId="req-422" failure={REFUSED} retry={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Retrying will not fix it");
  });
});

describe("ReadingNote", () => {
  test("the caveats sit in a collapsed disclosure, reachable by its summary", () => {
    render(
      <ReadingNote>
        <p>A caveat.</p>
      </ReadingNote>,
    );
    const details = screen.getByText("How to read this page").closest("details");
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.textContent).toContain("A caveat.");
  });
});
