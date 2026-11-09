/**
 * RT-1298: verifies the GitHub OIDC token of the owner-run promotion workflow
 * (owner decision D-5a). `jose` does the cryptography:
 *
 *   - signature: GitHub's key set; algorithm allow-list `RS256` (no `none`, no HMAC);
 *   - `iss` is `https://token.actions.githubusercontent.com`; `aud` is the
 *     configured audience; `exp` and `iat` are required; the token may be at
 *     most 15 minutes old.
 *
 * Verdict (the contract's mapping): a token that cannot be authenticated is
 * `401` (missing, malformed, badly signed, expired, wrong issuer or audience,
 * key set unavailable); a genuine token whose claims do not match the pins in
 * `promotion-oidc.config.ts` (repository, environment, ref, workflow), or that
 * lacks a usable actor or run id, is `403`. Nothing is thrown: every failure is
 * a verdict. The verdict carries only the actor, run id and repository, never
 * the token or its other claims (jose claim errors quote the payload, so they
 * are dropped here).
 *
 * The key set is fetched from GitHub on first use and cached; a refetch is
 * rate-limited by a cooldown, so a flood of bad tokens cannot become a flood of
 * outbound calls. This is the new egress to `token.actions.githubusercontent.com`
 * the owner accepted with D-5a.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

import type { PromotionOidcConfig } from "./promotion-oidc.config";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;

/** DI token of the verifier; `null` while the promotion pins are not all set. */
export const PROMOTION_OIDC_VERIFIER = Symbol("PROMOTION_OIDC_VERIFIER");

const ALLOWED_ALGORITHMS = ["RS256"];
const CLOCK_TOLERANCE_SECONDS = 30;
const MAX_TOKEN_AGE = "15 minutes";
const JWKS_TIMEOUT_MS = 5_000;
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;

const GITHUB_LOGIN = /^[A-Za-z0-9](-?[A-Za-z0-9])*$/;
const GITHUB_LOGIN_MAX = 39;
const RUN_ID = /^[0-9]{1,20}$/;

/** Who the verified token says is running the promotion; never the token itself. */
export interface PromotionPrincipal {
  readonly actor: string;
  readonly runId: string;
  readonly repository: string;
}

export type PromotionVerdict =
  | { readonly ok: true; readonly principal: PromotionPrincipal }
  | { readonly ok: false; readonly status: 401 | 403 };

type Pins = Extract<PromotionOidcConfig, { enabled: true }>;

/** The production key source: GitHub's key set, cached, with a bounded fetch and a refetch cooldown. */
export function createPromotionKeyResolver(url: URL = new URL(GITHUB_OIDC_JWKS_URL)): JWTVerifyGetKey {
  return createRemoteJWKSet(url, {
    timeoutDuration: JWKS_TIMEOUT_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
  });
}

/** True when the four claims GitHub stamps on the job equal the pins. */
function matchesPins(payload: JWTPayload, pins: Pins): boolean {
  return (
    payload["repository"] === pins.repository &&
    payload["environment"] === pins.environment &&
    payload["ref"] === pins.ref &&
    payload["job_workflow_ref"] === pins.workflowRef
  );
}

/** True when the value is a GitHub login: at most 39 characters of letters, digits and single hyphens. */
function isGithubLogin(value: string): boolean {
  return value.length <= GITHUB_LOGIN_MAX && GITHUB_LOGIN.test(value);
}

/** The actor (a GitHub login) and the run id, or null when either is absent, not a string, or unusable. */
function readActorAndRun(payload: JWTPayload): { actor: string; runId: string } | null {
  const { actor, run_id: runId } = payload;
  if (typeof actor !== "string" || typeof runId !== "string") return null;
  return isGithubLogin(actor) && RUN_ID.test(runId) ? { actor, runId } : null;
}

/** The verdict for a token that already passed the cryptographic checks. */
function judge(payload: JWTPayload, pins: Pins): PromotionVerdict {
  if (!matchesPins(payload, pins)) return { ok: false, status: 403 };
  const who = readActorAndRun(payload);
  if (who === null) return { ok: false, status: 403 };
  return { ok: true, principal: { ...who, repository: pins.repository } };
}

/** Verifies the promotion workflow's GitHub OIDC token against the configured pins. */
export class PromotionOidcVerifier {
  constructor(
    private readonly pins: Pins,
    private readonly keys: JWTVerifyGetKey,
  ) {}

  /** The verdict for a raw JWT; never throws and never echoes the token. */
  async verify(rawJwt: string): Promise<PromotionVerdict> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(rawJwt, this.keys, {
        issuer: GITHUB_OIDC_ISSUER,
        audience: this.pins.audience,
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        maxTokenAge: MAX_TOKEN_AGE,
        requiredClaims: ["exp", "iat"],
      }));
    } catch {
      return { ok: false, status: 401 };
    }
    return judge(payload, this.pins);
  }
}
