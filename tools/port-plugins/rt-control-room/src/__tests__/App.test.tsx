import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortBridge } from "../bridge/usePortBridge";

const bridge = vi.hoisted(() => ({
  value: undefined as unknown as PortBridge,
}));

vi.mock("../bridge/usePortBridge", () => ({
  usePortBridge: () => bridge.value,
}));

import { App } from "../App";

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
  });

  // vitest globals are off, so Testing Library does not auto-clean between tests.
  afterEach(cleanup);

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
