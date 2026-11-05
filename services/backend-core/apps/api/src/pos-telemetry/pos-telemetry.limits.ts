/**
 * Bounds of the POS device tunnel (RT-1252). Per-key Sentry rate limits are
 * not available on the current plan (RT-1243 comment 15636), so these
 * buckets are the main noisy-terminal control. The per-device bucket is
 * checked first, so one noisy terminal is stopped before it spends the
 * global budget. Starting values, far above a working terminal's error rate.
 */
import type { RateLimitBucket } from "../auth/rate-limit";

const TEN_MINUTES_MS = 10 * 60 * 1000;

export const POS_TELEMETRY_BUCKETS = {
  /** Per authenticated device (`devices.id`). */
  perDevice: { limit: 30, windowMs: TEN_MINUTES_MS },
  /** Across the whole fleet: bounds what reaches the POS Sentry project's quota. */
  global: { limit: 1200, windowMs: TEN_MINUTES_MS },
} as const satisfies Record<string, RateLimitBucket>;
