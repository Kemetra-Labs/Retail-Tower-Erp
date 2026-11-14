import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Evidence for "bridge messages are accepted only from window.parent": this
// drives the REAL SDK listener (no mock) while the plugin is framed, i.e.
// window.parent !== window, which is how Port embeds it.

const ORIGIN = "https://app.getport.io";

function post(source: Window, origin: string, data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
}

describe("SDK bridge accepts messages only from window.parent", () => {
  const fakeParent = { postMessage: vi.fn() } as unknown as Window;
  const stranger = { postMessage: vi.fn() } as unknown as Window;
  const originalParent = Object.getOwnPropertyDescriptor(window, "parent");

  beforeEach(async () => {
    // The SDK keeps module-level state and one listener; it is external to
    // vite-node so resetModules cannot reload it. Reset the state through the
    // protocol itself (a valid message from the parent).
    Object.defineProperty(window, "parent", { configurable: true, value: fakeParent });
    const sdk = await import("@port-labs/plugins-sdk");
    sdk.getToken();
    post(fakeParent, ORIGIN, { type: "PORT_TOKEN", token: null });
    post(fakeParent, ORIGIN, { type: "PLUGIN_DATA", baseUrl: null });
  });

  afterEach(() => {
    if (originalParent) Object.defineProperty(window, "parent", originalParent);
  });

  it("ignores a token from another window, accepts it from the parent", async () => {
    const sdk = await import("@port-labs/plugins-sdk");
    sdk.getToken(); // installs the single message listener, as the hook does
    expect(sdk.getToken()).toBeNull();

    post(stranger, ORIGIN, { type: "PORT_TOKEN", token: "from-stranger" });
    expect(sdk.getToken()).toBeNull();

    post(fakeParent, ORIGIN, { type: "PORT_TOKEN", token: "from-parent" });
    expect(sdk.getToken()).toBe("from-parent");
  });

  it("ignores the parent when its origin is not a Port origin", async () => {
    const sdk = await import("@port-labs/plugins-sdk");
    sdk.getToken();
    post(fakeParent, "https://evil.example", { type: "PORT_TOKEN", token: "bad-origin" });
    expect(sdk.getToken()).toBeNull();
  });

  it("ignores PLUGIN_DATA (base URL) from another window", async () => {
    const sdk = await import("@port-labs/plugins-sdk");
    sdk.getToken();
    post(stranger, ORIGIN, { type: "PLUGIN_DATA", baseUrl: "https://evil.com" });
    expect(sdk.getPortApiBaseUrl()).toBeNull();
    post(fakeParent, ORIGIN, { type: "PLUGIN_DATA", baseUrl: "https://api.getport.io" });
    expect(sdk.getPortApiBaseUrl()).toBe("https://api.getport.io");
  });
});
