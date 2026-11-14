import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  data: {
    portToken: null as string | null,
    portApiBaseUrl: null as string | null,
    applyThemeCss: () => {},
  },
}));

vi.mock("@port-labs/plugins-sdk/react", () => ({
  usePortPluginData: () => sdk.data,
}));

import { isTrustedBaseUrl, usePortBridge } from "../usePortBridge";

describe("isTrustedBaseUrl", () => {
  it.each([
    "https://api.getport.io",
    "https://api.port.io",
    "https://api.us.port.io",
    "https://getport.io",
    "https://port.io",
  ])("accepts %s", (url) => {
    expect(isTrustedBaseUrl(url)).toBe(true);
  });

  it.each([
    "http://api.getport.io",
    "https://getport.io.evil.com",
    "https://evil.com",
    "https://evilport.io",
    "https://api.port.io.evil.com",
    "https://api.port.io.",
    "https://user:pw@api.port.io",
    "https://api.port.io:8443",
    "https://evil.com/?https://api.port.io",
    "https://evil.com#@api.port.io",
    "javascript:alert(1)",
    "api.port.io",
    "",
  ])("rejects %s", (url) => {
    expect(isTrustedBaseUrl(url)).toBe(false);
  });
});

describe("usePortBridge", () => {
  beforeEach(() => {
    sdk.data = {
      portToken: null,
      portApiBaseUrl: null,
      applyThemeCss: () => {},
    };
  });

  it("is waiting, untrusted and empty before the host sends data", () => {
    const { result } = renderHook(() => usePortBridge());
    expect(result.current.status).toBe("waiting");
    expect(result.current.trusted).toBe(false);
    expect(result.current.baseUrl).toBeNull();
    expect(result.current.token).toBeNull();
  });

  it("returns trusted false, no base URL and no token for an untrusted host", () => {
    sdk.data = { ...sdk.data, portToken: "secret", portApiBaseUrl: "https://evil.com" };
    const { result } = renderHook(() => usePortBridge());
    expect(result.current.trusted).toBe(false);
    expect(result.current.status).toBe("untrusted");
    expect(result.current.baseUrl).toBeNull();
    expect(result.current.token).toBeNull();
  });

  it("passes token and base URL through for a trusted host", () => {
    const applyThemeCss = vi.fn();
    sdk.data = { portToken: "tok", portApiBaseUrl: "https://api.getport.io", applyThemeCss };
    const { result } = renderHook(() => usePortBridge());
    expect(result.current.trusted).toBe(true);
    expect(result.current.status).toBe("ready");
    expect(result.current.baseUrl).toBe("https://api.getport.io");
    expect(result.current.token).toBe("tok");
    result.current.applyThemeCss();
    expect(applyThemeCss).toHaveBeenCalledTimes(1);
  });

  it("is waiting when the host is trusted but the token has not arrived", () => {
    sdk.data = { ...sdk.data, portApiBaseUrl: "https://api.getport.io" };
    const { result } = renderHook(() => usePortBridge());
    expect(result.current.trusted).toBe(true);
    expect(result.current.status).toBe("waiting");
    expect(result.current.token).toBeNull();
  });

  it("does not expose the token anywhere except the token field", () => {
    sdk.data = { portToken: "tok-123", portApiBaseUrl: "https://api.getport.io", applyThemeCss: () => {} };
    const { result } = renderHook(() => usePortBridge());
    const { token, ...rest } = result.current;
    expect(token).toBe("tok-123");
    expect(JSON.stringify(rest)).not.toContain("tok-123");
  });
});
