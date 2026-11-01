import { resolveDeploymentEnvironment } from "../connector/deployment-environment";

/**
 * RT-624 (RT-574 issue 5b) — `TRUST_PROXY` boot check.
 *
 * Unset `TRUST_PROXY` resolves to `false`. Behind Caddy that puts every client
 * in one IP bucket, so the per-IP public-auth budgets become global (a sign-in
 * denial of service). In a deployed environment an unset value is therefore
 * logged as a warning at boot. An explicit value, including `false` for a
 * direct deployment, is silent.
 *
 * Failing fast changes production boot behaviour, so it is an owner option:
 * it only happens when `TRUST_PROXY_REQUIRED` is exactly `true`. Default off.
 *
 * RT-625 D3 (owner, 2026-11-01): the sign-in lockout keys on the client IP, so
 * an explicit value that defeats it refuses boot in a deployed environment,
 * whatever `TRUST_PROXY_REQUIRED` says:
 *
 *   - `true` trusts every `X-Forwarded-For` hop, so a client that can set the
 *     header picks its own IP and a fresh rate-limit bucket per request;
 *   - `false` behind a proxy gives every client the proxy's IP. The shipped
 *     topology is behind Caddy, so `false` is refused unless the deployment
 *     declares itself direct with `TRUST_PROXY_DIRECT_DEPLOYMENT=true`.
 */
export const TRUST_PROXY_UNSET_WARNING =
  "TRUST_PROXY is unset in a deployed environment: forwarded headers are not trusted, so behind a " +
  "reverse proxy all clients share one IP rate-limit bucket. Set TRUST_PROXY to the proxy hop " +
  "count (for example 1 behind a single Caddy), or to false with TRUST_PROXY_DIRECT_DEPLOYMENT=true " +
  "for a direct deployment.";

export const TRUST_PROXY_TRUE_REFUSED =
  "TRUST_PROXY=true is refused in a deployed environment (RT-625): it trusts every X-Forwarded-For " +
  "hop, so a client can choose its own IP and rate-limit bucket. Set the proxy hop count instead " +
  "(for example 1 behind a single Caddy).";

export const TRUST_PROXY_FALSE_REFUSED =
  "TRUST_PROXY=false is refused in a deployed environment behind a proxy (RT-625): every client " +
  "would share the proxy's IP rate-limit bucket. Set the proxy hop count (for example 1 behind a " +
  "single Caddy), or set TRUST_PROXY_DIRECT_DEPLOYMENT=true if no proxy is in front of the API.";

export const TRUST_PROXY_UNRECOGNIZED_WARNING =
  "TRUST_PROXY has an unrecognized value in a deployed environment and resolves to false: only a " +
  "hop count (digits), true, or false (exactly, no whitespace) is understood. Behind a reverse " +
  "proxy all clients then share one IP rate-limit bucket.";

export type TrustProxyCheck = { warn: false } | { warn: true; message: string };

/** The value for Express `trust proxy`; identical to the pre-RT-624 inline logic. */
export function resolveTrustProxySetting(
  env: NodeJS.ProcessEnv = process.env,
): number | boolean {
  const raw = env["TRUST_PROXY"] ?? "false";
  return /^\d+$/.test(raw) ? Number(raw) : raw === "true";
}

function isRecognizedTrustProxy(raw: string): boolean {
  if (/^\d+$/.test(raw)) return true;
  return raw === "true" || raw === "false";
}

function isDeployed(env: NodeJS.ProcessEnv): boolean {
  if (env["NODE_ENV"] === "production") return true;
  return ["staging", "pilot", "prod"].includes(resolveDeploymentEnvironment(env) ?? "");
}

/**
 * Decide whether boot should warn about an unset `TRUST_PROXY`. Throws when
 * `TRUST_PROXY_REQUIRED=true` is set explicitly and the value is unset or
 * unrecognized, and (RT-625) for an explicit `true`, or an explicit `false`
 * without `TRUST_PROXY_DIRECT_DEPLOYMENT=true`. Pure: the caller logs.
 */
export function checkTrustProxyConfig(
  env: NodeJS.ProcessEnv = process.env,
): TrustProxyCheck {
  if (!isDeployed(env)) return { warn: false };
  const raw = env["TRUST_PROXY"] ?? "";
  if (raw === "true") throw new Error(TRUST_PROXY_TRUE_REFUSED);
  if (raw === "false" && env["TRUST_PROXY_DIRECT_DEPLOYMENT"] !== "true") {
    throw new Error(TRUST_PROXY_FALSE_REFUSED);
  }
  if (isRecognizedTrustProxy(raw)) return { warn: false };
  if (env["TRUST_PROXY_REQUIRED"] === "true") {
    throw new Error(
      "TRUST_PROXY must be set to a hop count, true, or false in a deployed environment " +
        "when TRUST_PROXY_REQUIRED=true",
    );
  }
  return {
    warn: true,
    message: raw.trim() === "" ? TRUST_PROXY_UNSET_WARNING : TRUST_PROXY_UNRECOGNIZED_WARNING,
  };
}
