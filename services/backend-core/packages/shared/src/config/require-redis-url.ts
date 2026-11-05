/**
 * REDIS_URL boot guard shared by the api and worker factories (RT-1212,
 * RT-148 H-5): production without REDIS_URL throws, any other environment
 * gets `null` so the caller can fall back to its own dev stub.
 *
 * Thrown message: `<component>: REDIS_URL is required in production (<reason>).`
 * Several specs and operator runbooks pin the `<component>:` prefix, so
 * callers must pass the historical prefix verbatim.
 */
export interface RequireRedisUrlOptions {
  /** Message prefix, e.g. "AuthModule". */
  readonly component: string;
  /** Parenthetical explaining what cannot work without Redis. */
  readonly reason: string;
  /** Optional hook run only on the non-production missing path (e.g. logging). */
  readonly onMissingDev?: () => void;
}

export function requireRedisUrl(options: RequireRedisUrlOptions): string | null {
  const url = process.env["REDIS_URL"];
  if (url) {
    return url;
  }
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(`${options.component}: REDIS_URL is required in production (${options.reason}).`);
  }
  options.onMissingDev?.();
  return null;
}
