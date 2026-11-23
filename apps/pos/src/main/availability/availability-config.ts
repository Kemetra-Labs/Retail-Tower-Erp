/**
 * RT-1578 (RT-1511 S3) — the availability refresh cadence and staleness window, both configurable
 * (owner scope: "Both values are configurable"). Defaults are the RT-1511 decision-record values: refresh
 * every 15 minutes, stale after 60. Read from the launch environment, bounded, and a malformed value falls
 * back to the default rather than disabling the cache.
 */

export const ENV_AVAILABILITY_REFRESH_MINUTES = 'POS_AVAILABILITY_REFRESH_MINUTES';
export const ENV_AVAILABILITY_STALE_MINUTES = 'POS_AVAILABILITY_STALE_MINUTES';

const DEFAULT_REFRESH_MINUTES = 15;
const DEFAULT_STALE_MINUTES = 60;
const MIN_MINUTES = 1;
const MAX_MINUTES = 7 * 24 * 60;
const MS_PER_MINUTE = 60_000;

export interface AvailabilityConfig {
  readonly refreshIntervalMs: number;
  readonly staleAfterMs: number;
}

function minutesFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d{1,5}$/.test(raw.trim())) return fallback;
  const minutes = Number(raw.trim());
  return minutes >= MIN_MINUTES && minutes <= MAX_MINUTES ? minutes : fallback;
}

export function resolveAvailabilityConfig(env: NodeJS.ProcessEnv): AvailabilityConfig {
  return {
    refreshIntervalMs:
      minutesFrom(env[ENV_AVAILABILITY_REFRESH_MINUTES], DEFAULT_REFRESH_MINUTES) * MS_PER_MINUTE,
    staleAfterMs:
      minutesFrom(env[ENV_AVAILABILITY_STALE_MINUTES], DEFAULT_STALE_MINUTES) * MS_PER_MINUTE,
  };
}
