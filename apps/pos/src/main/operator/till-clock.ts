/**
 * RT-1312 F18 — the till clock check shared by cashier sign-in and cashier takeover.
 *
 * Backend-Core refuses a cashier sale whose time is more than `CLOCK_SKEW_TOLERANCE_SECONDS`
 * (120 s, services/backend-core/apps/api/src/catalog/sales/operator-attribution.ts) off the
 * server, so a till with a wrong clock would capture sales that are all refused at sync and
 * stranded. Owner decision 2026-11-10: block the cashier sign-in instead.
 *
 * The admission's `server_time` was stamped while the request was in flight, so it is judged
 * against the window between the till's wall clock when the request was SENT and when the answer
 * was RECEIVED, widened by the tolerance on both sides. Network latency therefore never causes a
 * refusal, and a refusal always means the till clock itself is off by more than the tolerance.
 */

/** Keep equal to Backend-Core `CLOCK_SKEW_TOLERANCE_SECONDS` (120 s). */
export const TILL_CLOCK_TOLERANCE_MS = 120_000;

/**
 * True when `serverTime` lies outside `[sentAtMs - tolerance, receivedAtMs + tolerance]`.
 * An unparseable server time cannot be judged and is not refused (the client already checked
 * it is a string; Backend-Core still enforces the rule on every sale).
 */
export function tillClockSkewed(
  serverTime: string,
  sentAtMs: number,
  receivedAtMs: number,
): boolean {
  const serverMs = Date.parse(serverTime);
  if (!Number.isFinite(serverMs)) return false;
  return (
    serverMs < sentAtMs - TILL_CLOCK_TOLERANCE_MS ||
    serverMs > receivedAtMs + TILL_CLOCK_TOLERANCE_MS
  );
}
