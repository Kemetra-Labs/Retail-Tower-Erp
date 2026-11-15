import { isTrustedBaseUrl } from "./usePortBridge";

/**
 * The origin of the page that frames this widget, when the browser tells us: Chromium lists the
 * ancestors in `location.ancestorOrigins`, and `document.referrer` is the fallback. Null when
 * neither says.
 */
function parentOrigin(): string | null {
  const ancestor = typeof location !== "undefined" ? location.ancestorOrigins?.[0] : undefined;
  const candidate = ancestor ?? (typeof document !== "undefined" ? document.referrer : "");
  if (!candidate) return null;
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

/**
 * Asks the Port host for a fresh token. The SDK requests one only once per
 * page load and exports no way to ask again, so after a 401 this sends the
 * same `REQUEST_PORT_TOKEN` message the SDK uses. The message carries no data,
 * and the answer arrives through the SDK's own listener (which accepts
 * messages from `window.parent` only).
 *
 * The target origin is the parent's own origin when the browser reveals it, so the request
 * cannot reach a page that is not Port. A parent that is known and not a Port origin gets nothing.
 * Only when no browser reveals the parent does it fall back to "*": the message is data-free,
 * and the token comes back through the SDK's checked listener, never through this call.
 */
export function requestPortToken(): void {
  if (typeof window === "undefined" || window.parent === window) return;
  const origin = parentOrigin();
  if (origin !== null && !isTrustedBaseUrl(origin)) return;
  window.parent.postMessage({ type: "REQUEST_PORT_TOKEN" }, origin ?? "*");
}
