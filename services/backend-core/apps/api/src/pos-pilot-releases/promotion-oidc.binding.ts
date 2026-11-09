/**
 * RT-1298: binds the promotion OIDC verifier from the environment and warns,
 * with a closed reason and never a value, when the pins are partly set. A fully
 * blank lane (the normal state before the owner switches it on) is silent. With
 * no verifier every registry write from the workflow is 401. Pure apart from the
 * `warn` callback and the key source, so it is testable without Nest.
 */
import type { JWTVerifyGetKey } from "jose";

import { resolvePromotionOidcConfig } from "./promotion-oidc.config";
import { PromotionOidcVerifier, createPromotionKeyResolver } from "./promotion-oidc.verifier";

type Env = Readonly<Record<string, string | undefined>>;

/** The verifier for the environment, or null (every write is 401); warns when the pins are half set. */
export function bindPromotionVerifier(
  env: Env,
  warn: (message: string) => void,
  keys: () => JWTVerifyGetKey = createPromotionKeyResolver,
): PromotionOidcVerifier | null {
  const config = resolvePromotionOidcConfig(env);
  if (config.enabled) return new PromotionOidcVerifier(config, keys());
  if (config.reason !== "not_configured") warn(`pilot release promotion writes are off: ${config.reason}`);
  return null;
}
