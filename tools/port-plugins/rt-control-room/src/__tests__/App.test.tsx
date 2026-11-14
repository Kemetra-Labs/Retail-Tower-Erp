import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortBridge } from "../bridge/usePortBridge";

const bridge = vi.hoisted(() => ({
  value: undefined as unknown as PortBridge,
}));

vi.mock("../bridge/usePortBridge", () => ({
  usePortBridge: () => bridge.value,
}));

import { App } from "../App";

// useBoard needs a QueryClient, and a ready bridge makes it fetch: the stand-in
// answers 500 so no test reaches the real Port API.
function render(ui: ReactElement) {
  return rtlRender(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

function setBridge(partial: Partial<PortBridge>): void {
  bridge.value = {
    token: null,
    baseUrl: null,
    applyThemeCss: () => {},
    trusted: false,
    status: "waiting",
    ...partial,
  };
}

describe("App", () => {
  beforeEach(() => {
    setBridge({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
  });

  // vitest globals are off, so Testing Library does not auto-clean between tests.
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("waits for Port when no bridge data has arrived", () => {
    render(<App />);
    expect(screen.getByText("Waiting for Port...")).toBeTruthy();
  });

  it("shows Untrusted Port API host and never renders the token", () => {
    setBridge({ status: "untrusted", trusted: false, token: null });
    const { container } = render(<App />);
    expect(screen.getByText("Untrusted Port API host")).toBeTruthy();
    expect(container.textContent).not.toContain("Waiting for Port");
  });

  it("renders the shell once the bridge is ready, without printing the token", () => {
    setBridge({
      status: "ready",
      trusted: true,
      token: "tok-secret",
      baseUrl: "https://api.getport.io",
    });
    const { container } = render(<App />);
    expect(container.querySelector(".shell")).toBeTruthy();
    expect(screen.queryByText("Waiting for Port...")).toBeNull();
    expect(container.textContent).not.toContain("tok-secret");
  });

  it("applies the host theme on every state", () => {
    const applyThemeCss = vi.fn();
    setBridge({ applyThemeCss });
    render(<App />);
    expect(applyThemeCss).toHaveBeenCalled();
  });
});

describe("App hook order", () => {
  it("renders the same hooks before and after the token arrives", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setBridge({});
    const queryClient = new QueryClient();
    const ui = (
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );
    const { rerender, container } = rtlRender(ui);
    expect(screen.getByText("Waiting for Port...")).toBeTruthy();

    setBridge({ status: "ready", trusted: true, token: "tok-secret", baseUrl: "https://api.getport.io" });
    expect(() => rerender(ui)).not.toThrow();
    expect(container.querySelector(".shell")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBeTruthy();
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/hook/i);
    errors.mockRestore();
  });
});

describe("App with the board", () => {
  // The hook-order test above leaves its tree mounted.
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the header, the verdict and the telemetry once Port answers, then follows the language and pause", async () => {
    const { createFakePort } = await import("../state/__tests__/testkit");
    createFakePort().install();
    setBridge({ status: "ready", trusted: true, token: "tok-secret", baseUrl: "https://api.getport.io" });
    const { container } = render(<App />);

    // While loading: busy placeholders, no figures, one status region.
    expect(container.querySelector("[aria-busy='true']")).toBeTruthy();
    expect(screen.getAllByRole("status")).toHaveLength(1);

    expect(await screen.findByText(/3 faults on the invoice cable/, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText("Test lab, not real stores")).toBeTruthy();
    expect(container.querySelectorAll("svg.trace")).toHaveLength(4);
    // The control room: five stations and the alarm pins; it adds no status region (the announcer is the panel's).
    expect(container.querySelectorAll('[data-focus^="station:"]')).toHaveLength(5);
    expect(container.querySelectorAll(".pin")).toHaveLength(5);
    expect(container.querySelector('.room [role="status"]')).toBeNull();
    // The side panel, the four lower panels and the table toggle (the diagram stays the default).
    expect(screen.getByRole("tab", { name: "Alarms (5)" })).toBeTruthy();
    expect(container.querySelectorAll("[data-lower-panels] > section")).toHaveLength(4);
    expect(container.querySelector("[data-status-table]")).toBeNull();
    expect(screen.getByRole("button", { name: "Table view" }).getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).not.toContain("tok-secret");

    fireEvent.click(screen.getByRole("button", { name: "Pause motion" }));
    expect(container.querySelector(".pulse")?.className).toContain("paused");
    expect(screen.getByRole("button", { name: "Resume motion" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "عربي" }));
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByText("بيئة تجربة، مش محلات حقيقية")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(document.documentElement.dir).toBe("ltr");
  });
});
