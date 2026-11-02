import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const read = vi.fn();
vi.mock("@/lib/system-status-queries", () => ({
  consoleGetSystemStatus: (...a: unknown[]) => read(...a),
}));
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { setLocale } from "@/i18n";
import { createQueryClient } from "@/lib/query";
import { SystemStatus } from "@/shell/SystemStatus";

const AT = "2026-11-02T10:00:00.000Z";
const comp = (state: string, reason: string, link: string) => ({
  state,
  reason,
  observedAt: AT,
  link,
  ...(link === "none" ? {} : { facts: null }),
});
const status = (sale = ["ok", "keeping_up"], erp = ["ok", "heartbeat_fresh"], overall = "ok") => ({
  status: 200,
  data: {
    asOf: AT,
    overall,
    components: {
      server: comp("ok", "answered", "none"),
      saleSync: comp(sale[0], sale[1], "sale_sync_ops"),
      erpConnector: comp(erp[0], erp[1], "erp_connection"),
    },
  },
});

function renderBlock(): void {
  activeContext.mockReturnValue({
    context: { active_tenant: { id: "t1", name: "N" }, active_role_code: "owner" },
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <SystemStatus />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  read.mockReset();
  setLocale("en");
});
afterEach(() => {
  vi.useRealTimers();
  setLocale("en");
});

describe("RT-1071 system-status block", () => {
  test("loading: names the check and claims no state", () => {
    read.mockReturnValue(new Promise(() => {}));
    renderBlock();
    expect(screen.getByText("Checking…")).toBeDefined();
    expect(screen.queryByText("OK")).toBeNull();
  });

  test("each state is named in words with its reason and a destination link", async () => {
    read.mockResolvedValue(
      status(["down", "queue_stalled"], ["degraded", "some_instances_stale"], "down"),
    );
    renderBlock();
    await screen.findByText("Queue has stalled");
    expect(screen.getByText("Down")).toBeDefined();
    expect(screen.getByText("Degraded")).toBeDefined();
    expect(screen.getByText("Some instances are silent")).toBeDefined();
    expect(screen.getByRole("link", { name: "Sale sync" }).getAttribute("href")).toBe(
      "/sales-needing-repair",
    );
    expect(screen.getByRole("link", { name: "ERP connector" }).getAttribute("href")).toBe(
      "/erp-connection",
    );
    // The server has no screen, so no link rather than a dead one.
    expect(screen.queryByRole("link", { name: "Server" })).toBeNull();
  });

  test("the component list is a polite live region, so a changed state is announced", async () => {
    read.mockResolvedValue(status());
    renderBlock();
    await screen.findByText("Keeping up");
    expect(screen.getByRole("list").getAttribute("aria-live")).toBe("polite");
  });

  test("unknown is shown as Unknown, never OK", async () => {
    read.mockResolvedValue(status(["ok", "keeping_up"], ["unknown", "not_configured"], "unknown"));
    renderBlock();
    await screen.findByText("Not configured");
    expect(screen.getByText("Unknown")).toBeDefined();
    expect(screen.getAllByText("OK")).toHaveLength(2);
  });

  test("shows the snapshot time", async () => {
    read.mockResolvedValue(status());
    renderBlock();
    await screen.findByText(/^As of /);
    expect(screen.getByText(/^As of .*2026/)).toBeDefined();
  });

  test("a failed read shows every component Unknown, never healthy", async () => {
    read.mockResolvedValue({ status: 500, error: { error: { code: "x", message: "x" } } });
    renderBlock();
    await screen.findByText("The status could not be read. Nothing is confirmed.");
    expect(screen.getAllByText("Unknown")).toHaveLength(3);
    expect(screen.queryByText("OK")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("a thrown read (network) is also Unknown", async () => {
    read.mockRejectedValue(new Error("network"));
    renderBlock();
    await screen.findByText("The status could not be read. Nothing is confirmed.");
    expect(screen.getAllByText("Unknown")).toHaveLength(3);
  });

  test("404 (a role outside the allowed set) hides the block, disclosing nothing", async () => {
    read.mockResolvedValue({ status: 404, error: { error: { code: "not_found", message: "x" } } });
    renderBlock();
    await waitFor(() => expect(read).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("group")).toBeNull());
    expect(screen.queryByText("System status")).toBeNull();
    expect(screen.queryByText("Unknown")).toBeNull();
  });

  test("reads once on load, and again only on Refresh", async () => {
    read.mockResolvedValue(status());
    renderBlock();
    await screen.findByText("Keeping up");
    expect(read).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    expect(read).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  test("a failed Refresh replaces the earlier OK with Unknown", async () => {
    read.mockResolvedValueOnce(status());
    renderBlock();
    await screen.findByText("Keeping up");
    read.mockResolvedValueOnce({ status: 500, error: {} });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText("The status could not be read. Nothing is confirmed.");
    expect(screen.queryByText("OK")).toBeNull();
  });

  test("stale after 10 minutes: states stay, the age and Refresh are shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    read.mockResolvedValue(status());
    renderBlock();
    await screen.findByText("Keeping up");
    expect(screen.queryByText(/Snapshot is/)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(11 * 60_000);
    });
    expect(screen.getByText(/Snapshot is 11 minutes old/)).toBeDefined();
    expect(screen.getByText("Keeping up")).toBeDefined();
    expect(read).toHaveBeenCalledTimes(1); // the clock never triggers a request
  });

  test("Arabic: labels, states and reasons are translated", async () => {
    setLocale("ar");
    read.mockResolvedValue(
      status(["degraded", "needs_repair"], ["ok", "heartbeat_fresh"], "degraded"),
    );
    renderBlock();
    await screen.findByText("مبيعات تحتاج إصلاحًا");
    expect(screen.getByText("حالة النظام")).toBeDefined();
    expect(screen.getByText("متدهور")).toBeDefined();
    expect(screen.getByRole("button", { name: "إعادة الفحص" })).toBeDefined();
  });
});
