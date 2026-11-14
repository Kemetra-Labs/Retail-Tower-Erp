import { usePortPluginData } from "@port-labs/plugins-sdk/react";

const TRUSTED_ROOTS = ["port.io", "getport.io"] as const;

/**
 * True only for an https URL with no credentials and no custom port whose host
 * is port.io, getport.io or a subdomain of either. The URL is parsed, never
 * pattern-matched on the raw string, so "https://getport.io.evil.com" and
 * "https://evil.com/?https://api.port.io" are rejected.
 */
export function isTrustedBaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.port !== "") return false;
  const host = parsed.hostname.toLowerCase();
  return TRUSTED_ROOTS.some((root) => host === root || host.endsWith(`.${root}`));
}

export type BridgeStatus = "waiting" | "untrusted" | "ready";

export interface PortBridge {
  token: string | null;
  baseUrl: string | null;
  applyThemeCss: () => void;
  trusted: boolean;
  /**
   * waiting: the host has not sent a base URL or token yet.
   * untrusted: the host sent a base URL that is not Port's; token and baseUrl are withheld.
   * ready: trusted base URL and a token.
   */
  status: BridgeStatus;
}

/**
 * Thin wrapper over the SDK's usePortPluginData(). The SDK owns the postMessage
 * protocol, including the token request/refresh and the check that messages
 * come from window.parent; this hook only adds the base-URL trust gate. When
 * the host is untrusted the token is withheld too, so it can never be sent to
 * it.
 */
export function usePortBridge(): PortBridge {
  const { portToken, portApiBaseUrl, applyThemeCss } = usePortPluginData();

  if (portApiBaseUrl && !isTrustedBaseUrl(portApiBaseUrl)) {
    return { token: null, baseUrl: null, applyThemeCss, trusted: false, status: "untrusted" };
  }
  if (!portApiBaseUrl) {
    return { token: portToken, baseUrl: null, applyThemeCss, trusted: false, status: "waiting" };
  }
  return {
    token: portToken,
    baseUrl: portApiBaseUrl,
    applyThemeCss,
    trusted: true,
    status: portToken ? "ready" : "waiting",
  };
}
