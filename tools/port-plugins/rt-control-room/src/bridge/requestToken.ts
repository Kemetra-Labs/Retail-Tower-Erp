/**
 * Asks the Port host for a fresh token. The SDK requests one only once per
 * page load and exports no way to ask again, so after a 401 this sends the
 * same `REQUEST_PORT_TOKEN` message the SDK uses. The message carries no data,
 * and the answer arrives through the SDK's own listener (which accepts
 * messages from `window.parent` only).
 */
export function requestPortToken(): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage({ type: "REQUEST_PORT_TOKEN" }, "*");
}
