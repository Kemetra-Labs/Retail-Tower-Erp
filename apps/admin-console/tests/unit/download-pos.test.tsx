import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ctx } from "./device-fixtures";

const consolePilotGetLatestPosRelease = vi.fn();
vi.mock("@/lib/pilot-release-queries", () => ({
  consolePilotGetLatestPosRelease: (...a: unknown[]) => consolePilotGetLatestPosRelease(...a),
}));
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));
const supportSession = vi.fn();
vi.mock("@/platform/session/useSupportSession", () => ({
  useSupportSession: () => supportSession(),
}));

import { DownloadPos } from "@/devices/DownloadPos";
import { t } from "@/i18n";
import { createQueryClient } from "@/lib/query";

const SECRET_URL =
  "https://bucket.s3.eu-central-1.amazonaws.com/POS.exe?X-Amz-Signature=SENTINELSECRET";
const SHA = "ab12cd34".repeat(8);
const EXPIRES = "2026-11-09T20:00:00Z";
const available = {
  available: true,
  version: "0.3.7",
  sha256: SHA,
  sizeBytes: 185_500_000,
  fileName: "POS-Pulse-Setup-0.3.7.exe",
  expectedPublisher: "CN=Kemetra POS PILOT",
  downloadUrl: SECRET_URL,
  expiresAt: EXPIRES,
};
const ok = (data: unknown) => ({ status: 200, data });
const fail = (status: number, code = "x", retryAfter?: number) => ({
  status,
  error: { error: { code, message: "m", request_id: "req-9" } },
  ...(retryAfter ? { retryAfter } : {}),
});

function tree(): React.JSX.Element {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/devices/download-pos"]}>
        <DownloadPos />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
const renderPage = (strict = false) => render(strict ? <StrictMode>{tree()}</StrictMode> : tree());
const button = () => screen.getByRole("button", { name: t("devices.download.action") });
async function activate(): Promise<void> {
  await act(async () => {
    fireEvent.click(button());
  });
}

describe("DownloadPos (RT-1304)", () => {
  beforeEach(() => {
    consolePilotGetLatestPosRelease.mockReset();
    activeContext.mockReturnValue(ctx());
    supportSession.mockReturnValue(null);
    for (const frame of document.body.querySelectorAll("iframe")) frame.remove();
  });
  afterEach(() => vi.useRealTimers());

  test("AC1/AC17: a role outside the device roles, or a support session, reads S5 with zero calls", () => {
    activeContext.mockReturnValue(ctx("store_staff"));
    const view = renderPage();
    expect(screen.getByText(t("devices.download.notAllowed"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: t("devices.download.action") })).toBeNull();
    view.unmount();

    activeContext.mockReturnValue(ctx("owner"));
    supportSession.mockReturnValue({ id: "s1" });
    renderPage();
    expect(screen.getByText(t("devices.download.notAllowed"))).toBeTruthy();
    expect(consolePilotGetLatestPosRelease).not.toHaveBeenCalled();
  });

  test("S10: no active tenant asks for one, no call", () => {
    activeContext.mockReturnValue(ctx("owner", null));
    renderPage();
    expect(screen.getByText(t("devices.list.scopePrompt"))).toBeTruthy();
    expect(consolePilotGetLatestPosRelease).not.toHaveBeenCalled();
  });

  test("AC2: opening, re-rendering and StrictMode make zero resolver calls", async () => {
    const view = renderPage(true);
    view.rerender(<StrictMode>{tree()}</StrictMode>);
    await act(async () => undefined);
    expect(consolePilotGetLatestPosRelease).not.toHaveBeenCalled();
    expect(screen.queryByText(t("devices.download.issued"))).toBeNull();
  });

  test("AC3: one activation is one call; click, Enter and a second click in the busy window are one", async () => {
    let release: (v: unknown) => void = () => undefined;
    consolePilotGetLatestPosRelease.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    renderPage();
    await act(async () => {
      fireEvent.click(button());
      fireEvent.click(button());
      fireEvent.keyDown(button(), { key: "Enter" });
    });
    expect(consolePilotGetLatestPosRelease).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: t("devices.download.busy") })).toBeTruthy();
    await act(async () => release(ok({ available: false })));
    expect(consolePilotGetLatestPosRelease).toHaveBeenCalledTimes(1);
  });

  test("S2/AC9/AC10: issued shows the facts and a status line; the link lives only in the transient frame", async () => {
    consolePilotGetLatestPosRelease.mockResolvedValue(ok(available));
    renderPage();
    await activate();
    expect(await screen.findByText(t("devices.download.issued"))).toBeTruthy();
    expect(screen.getByText("0.3.7")).toBeTruthy();
    expect(screen.getByText("POS-Pulse-Setup-0.3.7.exe")).toBeTruthy();
    expect(screen.getByText("185.5 MB")).toBeTruthy();
    expect(screen.getByText("CN=Kemetra POS PILOT")).toBeTruthy();
    const frames = document.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.getAttribute("src")).toBe(SECRET_URL);
    // Outside the one frame, the link and the expiry appear nowhere in the document.
    frames[0]?.remove();
    expect(document.documentElement.outerHTML).not.toContain("SENTINELSECRET");
    expect(document.documentElement.outerHTML).not.toContain(EXPIRES);
    expect(screen.queryByRole("link", { name: /copy link|نسخ الرابط/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /copy link|نسخ الرابط/i })).toBeNull();
    expect(window.location.href).not.toContain("SENTINELSECRET");
  });

  test("AC11: copy writes exactly the 64-char hex", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    consolePilotGetLatestPosRelease.mockResolvedValue(ok(available));
    renderPage();
    await activate();
    fireEvent.click(await screen.findByRole("button", { name: t("devices.download.copy") }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SHA));
    expect(SHA).toHaveLength(64);
  });

  test("S3/AC6: available:false is one DOM for any extra fields, no reason text", async () => {
    consolePilotGetLatestPosRelease.mockResolvedValue(ok({ available: false }));
    const view = renderPage();
    await activate();
    await screen.findByText(t("devices.download.unavailable"));
    const plain = view.container.innerHTML;
    view.unmount();

    consolePilotGetLatestPosRelease.mockResolvedValue(
      ok({ available: false, reason: "not_allowlisted" }),
    );
    const again = renderPage();
    await activate();
    await screen.findByText(t("devices.download.unavailable"));
    expect(again.container.innerHTML).toBe(plain);
    expect(plain).not.toMatch(/allowlist|withdrawn|reason/i);
    expect(button().getAttribute("aria-disabled")).not.toBe("true");
  });

  test("AC5/AC7: each contract answer is its own state; a 500 never reads as S3", async () => {
    const cases: [ReturnType<typeof fail>, string][] = [
      [fail(401), t("devices.list.sessionExpired")],
      [fail(403, "support_session_required"), t("platform.session.expiredBody.title")],
      [fail(403, "support_session_expired"), t("platform.session.expiredBody.title")],
      [fail(404, "not_found"), t("devices.download.notAllowed")],
      [fail(400, "validation_error"), t("devices.download.failed")],
      [fail(500, "system_failure"), t("devices.download.failed")],
    ];
    for (const [response, copy] of cases) {
      consolePilotGetLatestPosRelease.mockReset();
      consolePilotGetLatestPosRelease.mockResolvedValue(response);
      const view = renderPage();
      await activate();
      expect(await screen.findByText(copy)).toBeTruthy();
      expect(screen.queryByText(t("devices.download.unavailable"))).toBeNull();
      expect(screen.queryByText(t("devices.download.issued"))).toBeNull();
      view.unmount();
    }
    consolePilotGetLatestPosRelease.mockReset();
    consolePilotGetLatestPosRelease.mockResolvedValue(fail(500));
    renderPage();
    await activate();
    expect(await screen.findByText("req-9")).toBeTruthy();
  });

  test("S9: a network failure reads its own state and offers a manual retry", async () => {
    consolePilotGetLatestPosRelease.mockRejectedValue(new TypeError("Failed to fetch"));
    renderPage();
    await activate();
    expect(await screen.findByText(t("devices.download.network"))).toBeTruthy();
    expect(consolePilotGetLatestPosRelease).toHaveBeenCalledTimes(1);
  });

  test("AC8: 429 disables the button for Retry-After seconds, then re-enables; nothing retries", async () => {
    vi.useFakeTimers();
    consolePilotGetLatestPosRelease.mockResolvedValue(fail(429, "rate_limited", 3));
    renderPage();
    await activate();
    const wait = (n: number) =>
      t("devices.download.rateLimited", { wait: t("devices.download.seconds", { count: n }) });
    expect(screen.getByText(wait(3))).toBeTruthy();
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(wait(2))).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.queryByText(/Too many requests/)).toBeNull();
    expect((button() as HTMLButtonElement).disabled).toBe(false);
    expect(consolePilotGetLatestPosRelease).toHaveBeenCalledTimes(1);
  });

  test("AC16: a tenant change returns to idle", async () => {
    consolePilotGetLatestPosRelease.mockResolvedValue(ok(available));
    const view = renderPage();
    await activate();
    expect(await screen.findByText(t("devices.download.issued"))).toBeTruthy();
    activeContext.mockReturnValue(ctx("owner", "t2"));
    view.rerender(tree());
    await waitFor(() => expect(screen.queryByText(t("devices.download.issued"))).toBeNull());
    expect(screen.queryByText("POS-Pulse-Setup-0.3.7.exe")).toBeNull();
  });

  test("AC18: the support line is plain text; no mailto or tel link anywhere", () => {
    renderPage();
    expect(screen.getByText(t("devices.download.support"))).toBeTruthy();
    expect(document.querySelectorAll('a[href^="mailto:"], a[href^="tel:"]')).toHaveLength(0);
  });

  test("S11: the multi-tenant hint shows only with more than one membership", () => {
    const base = ctx();
    activeContext.mockReturnValue({
      context: { ...base.context, memberships: [{ tenant_id: "t1" }, { tenant_id: "t2" }] },
    });
    const view = renderPage();
    expect(screen.getByText(t("devices.download.multiTenant"))).toBeTruthy();
    view.unmount();
    activeContext.mockReturnValue({
      context: { ...base.context, memberships: [{ tenant_id: "t1" }] },
    });
    renderPage();
    expect(screen.queryByText(t("devices.download.multiTenant"))).toBeNull();
  });

  test("a late answer after unmount sets no state and throws nothing", async () => {
    let release: (v: unknown) => void = () => undefined;
    consolePilotGetLatestPosRelease.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = renderPage();
    await activate();
    view.unmount();
    await act(async () => release(ok({ available: false })));
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
