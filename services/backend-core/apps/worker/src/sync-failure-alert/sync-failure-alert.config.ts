/**
 * RT-1034 — configuration of the sync-failure email alert sweep (Automation V1 PoC).
 *
 * `SYNC_FAILURE_ALERT_ENABLED`
 *   - unset, blank or anything but the exact string `true` → the sweep job runs but does
 *     nothing (the alert is OFF by default, so a deploy of this code sends no mail).
 *
 * `SYNC_FAILURE_ALERT_SWEEP_INTERVAL_MS` (optional)
 *   - unset or blank → 300_000 (5 minutes: with BullMQ's retry window the worst-case delay
 *     from a failure state appearing to its email is well under the 10-minute AC3 target);
 *   - otherwise a whole number of milliseconds, at least 60_000.
 * Any other value refuses boot (the scheduler resolves it at construction).
 */

const SYNC_FAILURE_ALERT_ENABLED_ENV = "SYNC_FAILURE_ALERT_ENABLED";
export const SYNC_FAILURE_ALERT_INTERVAL_ENV = "SYNC_FAILURE_ALERT_SWEEP_INTERVAL_MS";

export const DEFAULT_SYNC_FAILURE_ALERT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_SYNC_FAILURE_ALERT_INTERVAL_MS = 60 * 1000;

export function resolveSyncFailureAlertEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[SYNC_FAILURE_ALERT_ENABLED_ENV] ?? "").trim() === "true";
}

/** The configured sweep interval in ms. Throws on an invalid value. */
export function resolveSyncFailureAlertIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[SYNC_FAILURE_ALERT_INTERVAL_ENV] ?? "").trim();
  if (raw === "") return DEFAULT_SYNC_FAILURE_ALERT_INTERVAL_MS;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < MIN_SYNC_FAILURE_ALERT_INTERVAL_MS) {
    throw new Error(
      `${SYNC_FAILURE_ALERT_INTERVAL_ENV} must be a whole number of milliseconds ` +
        `>= ${MIN_SYNC_FAILURE_ALERT_INTERVAL_MS}`,
    );
  }
  return value;
}
