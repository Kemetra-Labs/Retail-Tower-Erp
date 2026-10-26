/**
 * Pre-auth rate limiting — the one configuration module (RT-630, RT-574
 * residual risk R1, owner ruling O5).
 *
 * A REPORT-ONLY per-IP counter of requests that fail authentication (no
 * credential, or a garbage / expired / revoked session cookie or bearer
 * token). It sizes the pre-auth flood gap from real data; it never refuses a
 * request. There is deliberately no `enforce` mode: enforcing is a later
 * owner decision with its own issue.
 *
 * Boot-time environment:
 *
 * | Variable                        | Default  | Meaning |
 * |---------------------------------|----------|---------|
 * | `PREAUTH_RATE_LIMIT_MODE`       | `off`    | `off` / `report`. Anything else, `enforce` included, is `off`. |
 * | `PREAUTH_RATE_LIMIT_LIMIT`      | 300      | Failed-auth requests per IP per window before `would_limit`. 1 … 1000000. OWNER number. |
 * | `PREAUTH_RATE_LIMIT_WINDOW_MS`  | 300000   | Fixed window (5 minutes). 1000 … 3600000. OWNER number. |
 * | `PREAUTH_RATE_LIMIT_TIMEOUT_MS` | 250      | Max wait for the limiter's store before failing open. 1 … 10000. |
 *
 * The default ceiling (300 failures per 5 minutes per IP, one per second
 * sustained) is a placeholder RT-630 left unspecified: high enough that a
 * store behind one NAT address never reaches it with real expired sessions
 * (ten times the 30/h sign-in per-IP budget, in a twelfth of the time), low
 * enough that a cookie or bearer flood shows up. Calibrate from `report`
 * telemetry before any enforce decision. Invalid values fall back to the
 * defaults; merging this module changes no behaviour (mode `off`).
 */
import type { RateLimitBucket } from "../auth/rate-limit";

export const PREAUTH_RATE_LIMIT_MODES = ["off", "report"] as const;
export type PreAuthRateLimitMode = (typeof PREAUTH_RATE_LIMIT_MODES)[number];

/** Unset means off (the console limiter's O3b precedent). */
export const DEFAULT_PREAUTH_RATE_LIMIT_MODE: PreAuthRateLimitMode = "off";

/** OWNER number (RT-630 gives none): see the module comment. */
export const DEFAULT_PREAUTH_RATE_LIMIT_BUCKET: RateLimitBucket = { limit: 300, windowMs: 5 * 60 * 1000 };
/** The bound on a limiter call before failing open (same as the console limiter). */
export const DEFAULT_PREAUTH_RATE_LIMIT_TIMEOUT_MS = 250;

const LIMIT_RANGE = { min: 1, max: 1_000_000 } as const;
const WINDOW_MS_RANGE = { min: 1_000, max: 60 * 60 * 1000 } as const;
const TIMEOUT_MS_RANGE = { min: 1, max: 10_000 } as const;

/** Open after 5 consecutive failures; probe with one request after 10 s. */
export const PREAUTH_RATE_LIMIT_BREAKER = { failureThreshold: 5, openMs: 10_000 } as const;

/** A counted hit at or above this share of the ceiling is `near_limit`. */
export const PREAUTH_RATE_LIMIT_NEAR_LIMIT_RATIO = 0.5;

/** Warn logs (would-limit, fail-open) at most once per outcome per interval. */
export const PREAUTH_RATE_LIMIT_LOG_INTERVAL_MS = 60_000;

/** Redis key: `rl:preauth_ip:<ip>` (the `signin_ip` precedent). */
export const PREAUTH_RATE_LIMIT_BUCKET_NAME = "preauth_ip";

export interface PreAuthRateLimitConfig {
  readonly mode: PreAuthRateLimitMode;
  readonly bucket: RateLimitBucket;
  readonly timeoutMs: number;
}

/** DI token for the boot-time config. */
export const PREAUTH_RATE_LIMIT_CONFIG = "PREAUTH_RATE_LIMIT_CONFIG";

type Env = Readonly<Record<string, string | undefined>>;

function readMode(raw: string | undefined): PreAuthRateLimitMode {
  const value = (raw ?? "").trim().toLowerCase();
  return (PREAUTH_RATE_LIMIT_MODES as readonly string[]).includes(value)
    ? (value as PreAuthRateLimitMode)
    : DEFAULT_PREAUTH_RATE_LIMIT_MODE;
}

function readInt(raw: string | undefined, range: { min: number; max: number }, fallback: number): number {
  const value = (raw ?? "").trim();
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return parsed >= range.min && parsed <= range.max ? parsed : fallback;
}

/** Read once at boot. Invalid values fall back to the safe defaults. */
export function readPreAuthRateLimitConfig(env: Env = process.env): PreAuthRateLimitConfig {
  return {
    mode: readMode(env["PREAUTH_RATE_LIMIT_MODE"]),
    bucket: {
      limit: readInt(env["PREAUTH_RATE_LIMIT_LIMIT"], LIMIT_RANGE, DEFAULT_PREAUTH_RATE_LIMIT_BUCKET.limit),
      windowMs: readInt(env["PREAUTH_RATE_LIMIT_WINDOW_MS"], WINDOW_MS_RANGE, DEFAULT_PREAUTH_RATE_LIMIT_BUCKET.windowMs),
    },
    timeoutMs: readInt(env["PREAUTH_RATE_LIMIT_TIMEOUT_MS"], TIMEOUT_MS_RANGE, DEFAULT_PREAUTH_RATE_LIMIT_TIMEOUT_MS),
  };
}
