/**
 * @Idempotent — T521.
 *
 * Route-level decorator that marks a controller method for HTTP idempotency
 * enforcement by `IdempotencyInterceptor`.
 *
 * Usage:
 *   @Idempotent('required')   — missing Idempotency-Key header → 400
 *   @Idempotent('optional')   — missing header → pass-through, no replay
 *
 * The decorator publishes two metadata keys:
 *   IDEMPOTENT_POLICY_KEY — 'required' | 'optional'
 *   IDEMPOTENT_OPTIONS_KEY — IdempotentOptions (TTL overrides etc.)
 *
 * This decorator is passive — it only stores metadata. The interceptor
 * drives all enforcement. Exactly one usage in this slice (on `createInvitation`).
 *
 * Design discipline (strategy.md §12):
 *   - Route-level only — never applied to a class or globally.
 *   - The decorator does NOT check the HTTP verb at decoration time.
 *     Enforcement of safe-verb rejection is the interceptor's responsibility.
 */
import { SetMetadata, applyDecorators } from "@nestjs/common";

export type IdempotentPolicy = "required" | "optional";

export interface IdempotentOptions {
  /** Override the 72h default replay retention (seconds). */
  replayTtlSec?: number;
  /** Override the 60s default in-flight marker TTL (seconds). */
  inflightTtlSec?: number;
  /**
   * RT-1325 (RT-1125 R-03): the lifetime of the Postgres in-flight claim, as a
   * lease (seconds). Default: the claim lives as long as the replay record
   * (72 h, or `replayTtlSec`), so an orphaned claim (process killed, failed
   * release, failed save) answers 425 for that long. With a lease it lapses
   * after `claimLeaseSec` and a retry re-runs the handler; the saved result
   * still gets the full replay TTL.
   *
   * Opt in ONLY a route whose handler is itself guarded against a double run,
   * both concurrent (a slow handler outliving the lease) and sequential (the
   * first run committed but its result was never saved): see the route/guard
   * table on RT-1325. A route without such a guard keeps the default.
   */
  claimLeaseSec?: number;
  /**
   * `"forbid"` — the response carries credential material and is never
   * stored or replayed (RT-82 K3). The key stays occupied, so the handler
   * never runs twice; a same-key retry answers `409 idempotency_key_conflict`.
   * Default `"allow"`.
   */
  replay?: "allow" | "forbid";
  /**
   * With `replay: "forbid"`: the top-level response fields kept in the stored
   * marker (an allowlist; every other field is dropped). Must name only
   * non-secret identifiers, e.g. `["credential_id"]`.
   */
  replayMarkerFields?: readonly string[];
  /**
   * `"device"` — key the replay store by the authenticated device
   * (`request.posDeviceId`, set by the route's device guard) instead of the
   * user. A device principal has no user, so the default would share one
   * `"anonymous"` partition across the tenant's devices (RT-369). Opt-in per
   * route: the store key of every other route is unchanged.
   */
  clientScope?: "device";
  /**
   * RT-1112: top-level fields of a replayed JSON object body that the replay
   * sets to fixed values, for a contract whose body says whether it is a
   * replay (V-A redeem `idempotent_replayed: true`, reverse
   * `already_reversed: true`). The stored record is unchanged; a non-object
   * body is replayed as stored. Default: none.
   */
  replayBodyOverrides?: Readonly<Record<string, unknown>>;
}

/**
 * RT-1325: the claim lease of the routes that opt in (`claimLeaseSec`). Twice
 * the 60 s in-flight marker, far above a normal handler run, and far below
 * the 72 h default: an orphaned claim stalls a retrying Connector for at most
 * two minutes.
 */
export const GUARDED_ROUTE_CLAIM_LEASE_SEC = 120;

export const IDEMPOTENT_POLICY_KEY = "dp2:idempotent:policy";
export const IDEMPOTENT_OPTIONS_KEY = "dp2:idempotent:options";

/**
 * Mark a route handler for HTTP idempotency enforcement.
 *
 * @param policy  'required' — missing header → 400; 'optional' — pass-through.
 * @param options Optional TTL overrides.
 */
export const Idempotent = (
  policy: IdempotentPolicy,
  options: IdempotentOptions = {},
) =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_POLICY_KEY, policy),
    SetMetadata(IDEMPOTENT_OPTIONS_KEY, options),
  );
