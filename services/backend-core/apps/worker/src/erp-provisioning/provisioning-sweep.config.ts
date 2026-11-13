/**
 * RT-1358 — cadence and heartbeat timeout of the ERP provisioning sweep.
 *
 * `ERP_PROVISIONING_SWEEP_INTERVAL_MS` (optional): unset or blank -> 60_000
 * (every minute); otherwise a whole number of milliseconds, at least 10_000.
 * `ERP_PROVISIONING_HEARTBEAT_TIMEOUT_MS` (optional): unset or blank ->
 * 1_800_000 (30 minutes); otherwise a whole number, at least 60_000. The sweep
 * is what fails a request whose first heartbeat never arrived.
 * Any other value refuses boot (resolved at module init), so a typo never
 * silently falls back to the default.
 */
const PROVISIONING_SWEEP_INTERVAL_ENV = "ERP_PROVISIONING_SWEEP_INTERVAL_MS";
const PROVISIONING_HEARTBEAT_TIMEOUT_ENV = "ERP_PROVISIONING_HEARTBEAT_TIMEOUT_MS";

const DEFAULT_PROVISIONING_SWEEP_INTERVAL_MS = 60_000;
const MIN_PROVISIONING_SWEEP_INTERVAL_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30 * 60_000;
const MIN_HEARTBEAT_TIMEOUT_MS = 60_000;

function whole(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be a whole number of milliseconds >= ${min}`);
  }
  return value;
}

export function resolveProvisioningSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return whole(env, PROVISIONING_SWEEP_INTERVAL_ENV, DEFAULT_PROVISIONING_SWEEP_INTERVAL_MS, MIN_PROVISIONING_SWEEP_INTERVAL_MS);
}

export function resolveHeartbeatTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return whole(env, PROVISIONING_HEARTBEAT_TIMEOUT_ENV, DEFAULT_HEARTBEAT_TIMEOUT_MS, MIN_HEARTBEAT_TIMEOUT_MS);
}
