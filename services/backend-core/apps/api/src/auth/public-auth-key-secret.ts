/**
 * RT-1043 (RT-625 D4) — the server secret behind the public-auth rate-limit keys.
 *
 * The limiter buckets for sign-in, password reset, email verification and
 * invitation accept are keyed by an HMAC-SHA-256 of the email and/or client IP
 * (`public-auth-keys.ts`), so Redis holds neither. The HMAC is only worth
 * anything while the secret stays secret, so this module decides where it
 * comes from:
 *
 * | Run                                   | `PUBLIC_AUTH_RATE_LIMIT_KEY_SECRET` unset or blank | set                        |
 * | ------------------------------------- | -------------------------------------------------- | -------------------------- |
 * | Deployed (`NODE_ENV=production`, or `DEPLOYMENT_ENVIRONMENT` staging / pilot / prod) | REFUSES TO BOOT | must be >= 32 chars, else refuses to boot |
 * | `NODE_ENV=test`                       | a fixed test default                               | the value                  |
 * | Anything else (local development)     | a random per-process secret                        | the value                  |
 *
 * A deployed environment wins over `NODE_ENV=test`: a test runner cannot hide
 * a deployed environment. The random development secret means no constant in
 * this repository ever keys a real Redis; counters simply start over on each
 * restart, which is harmless on a developer machine.
 *
 * Boot: `main.ts` calls {@link assertPublicAuthKeySecretConfigured} before
 * Nest starts, so a missing secret stops the process at boot. It is never a
 * 500 on the first sign-in, which would break the O6 "never a 500" ruling
 * (`public-auth-limiter.ts`). No message here contains the secret value.
 *
 * Rotating the secret changes every key, so every public-auth counter starts
 * over once (the same one-time reset as the deploy that introduced it).
 */
import { randomBytes } from "node:crypto";

import { isDeployedEnvironment } from "../common/trust-proxy";

export const PUBLIC_AUTH_KEY_SECRET_ENV = "PUBLIC_AUTH_RATE_LIMIT_KEY_SECRET";

/** Shortest accepted deployed secret: `openssl rand -hex 32` gives 64. */
export const PUBLIC_AUTH_KEY_SECRET_MIN_LENGTH = 32;

/**
 * The `NODE_ENV=test` default. It is not a credential: it only keeps tests
 * deterministic, and a deployed environment can never resolve to it.
 */
const TEST_DEFAULT_SECRET = "rt-1043-test-only-public-auth-key-secret-not-for-deployment";

let developmentSecret: string | null = null;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The secret in `env`, or the fallback for this run (see the module header).
 * Throws in a deployed environment when the secret is missing, blank or short.
 */
export function resolvePublicAuthKeySecret(env: Env = process.env): string {
  const raw = env[PUBLIC_AUTH_KEY_SECRET_ENV] ?? "";
  const configured = raw.trim() === "" ? null : raw;

  if (isDeployedEnvironment(env)) {
    if (configured === null) {
      throw new Error(
        `${PUBLIC_AUTH_KEY_SECRET_ENV} is required in a deployed environment (RT-1043): ` +
          "the public-auth rate-limit keys are HMAC'd under it. Generate one with `openssl rand -hex 32` " +
          "and keep it in the secret manager.",
      );
    }
    if (configured.length < PUBLIC_AUTH_KEY_SECRET_MIN_LENGTH) {
      throw new Error(
        `${PUBLIC_AUTH_KEY_SECRET_ENV} is too short for a deployed environment (RT-1043): ` +
          `at least ${PUBLIC_AUTH_KEY_SECRET_MIN_LENGTH} characters are required. ` +
          "Generate one with `openssl rand -hex 32`.",
      );
    }
    return configured;
  }

  if (configured !== null) return configured;
  if (env["NODE_ENV"] === "test") return TEST_DEFAULT_SECRET;
  developmentSecret ??= randomBytes(32).toString("hex");
  return developmentSecret;
}

/** Boot check: throws when this run cannot resolve a usable secret. */
export function assertPublicAuthKeySecretConfigured(env: Env = process.env): void {
  resolvePublicAuthKeySecret(env);
}
