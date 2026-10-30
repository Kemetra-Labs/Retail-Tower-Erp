/**
 * RT-984 — every environment setting read in `apps/api/src` must reach the container.
 *
 * docker-compose.prod.yml lists the `api` environment explicitly and has no
 * `env_file`, so a name missing from that list never reaches `dp2-api` from the
 * host's `backend.env`. RT-983 found this for the tender gate (every tendered
 * sale got 400). This spec collects every env name read in `apps/api/src` and
 * fails when one is neither mapped from the host variable of the same name nor
 * excluded below with a reason. An env read it cannot resolve (an indirect key,
 * `env.X` on a parameter, destructuring) fails too, so a new form is noticed.
 * Reads inside workspace packages (e.g. `@data-pulse-2/shared`) are out of scope.
 *
 * It also proves that the compose defaults change nothing: each setting is
 * read through the real parser with the compose default and with the variable
 * unset, and both answers must match.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { load } from "js-yaml";

import { resolveAiReservationTtlSeconds } from "../../src/ai-entitlements/ai-entitlements.tokens";
import { readAiGatewayRuntime } from "../../src/ai/gateway/ai-gateway.runtime";
import { isOutboxAuditEnabled } from "../../src/audit/audit-enqueuer.module";
import { descopeAuthFactory } from "../../src/auth/descope-auth.client";
import { readPublicAuthLimiterTimeoutMs } from "../../src/auth/public-auth-limiter";
import { isLegacyRefundEnabled, isRefundSettleBeforePostEnabled } from "../../src/catalog/sales/refund-gates";
import { isPosReturnsEnabled } from "../../src/catalog/sales/returns-gate";
import {
  isPosSaleTendersEnabled,
  isPosSaleTendersSameMethodEnabled,
} from "../../src/catalog/sales/sale-tenders-gate";
import { checkTrustProxyConfig } from "../../src/common/trust-proxy";
import { readConsoleRateLimitConfig } from "../../src/console-rate-limit/console-rate-limit.config";
import { resolveForwardTarget } from "../../src/console-telemetry/console-telemetry.forwarder";
import {
  readCashierAdmissionPolicy,
  readTakeoverLimiterTimeoutMs,
} from "../../src/pos-cashier-admissions/cashier-admissions.config";
import { descopeVerifierConfig } from "../../src/pos-operators/descope-verifier";
import { isDeviceTokenExpiryEnforced } from "../../src/pos-operators/device-token-expiry-gate";
import { readPreAuthRateLimitConfig } from "../../src/preauth-rate-limit/preauth-rate-limit.config";

/** Read in apps/api/src but deliberately not passed to the production api. */
const EXCLUDED: Readonly<Record<string, string>> = {
  VERIFY_DATABASE_POOL_BOUNDARY: "test-only; production always verifies the pool boundary",
  ALLOWED_ORIGINS:
    "RT-336 single origin: CORS and extra trusted origins stay off by construction (caddy-same-origin.spec.ts)",
  ERPNEXT_FEED_RESPONSIBILITIES_ENABLED:
    "unmapped until the RT-419 hold lift, which must re-head the held rows in the same release step",
};

/** Mapped, but deliberately not from the host variable of the same name. */
const FIXED_VALUES: Readonly<Record<string, string>> = {
  NODE_ENV: "always production in this compose",
  PORT: "the container port Caddy proxies to",
  METRICS_PORT: "the port the datadog-agent scrapes",
  TRUST_PROXY: "exactly one trusted hop, the Caddy service",
  DB_MIGRATIONS_DIR: "the drizzle directory shipped in the image",
  SENTRY_ENVIRONMENT: "derived from DEPLOYMENT_ENVIRONMENT",
};

/** The only file whose `env[name]` reads names passed to `isEnvFlagOn`. */
const ENV_FLAG_HELPER_FILE = "catalog/sales/sale-tenders-gate.ts";

const apiRoot = resolve(__dirname, "..", "..");
const srcRoot = join(apiRoot, "src");
const serviceRoot = resolve(apiRoot, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts") ? [path] : [];
  });
}

const files = sourceFiles(srcRoot).map((path) => ({
  path: relative(srcRoot, path).replace(/\\/g, "/"),
  text: readFileSync(path, "utf8"),
}));
const allText = files.map((f) => f.text).join("\n");

function matches(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(pattern)].map((m) => m[1] as string);
}

/**
 * Non-literal keys the spec knows how to resolve. Each returns the names that
 * reach that read: `isEnvFlagOn(name)` callers, the cashier settings table, and
 * a `const X_ENV = "NAME"` constant.
 */
function resolveIndirectKey(key: string, file: { path: string; text: string }): string[] | null {
  if (key === "name" && file.path === ENV_FLAG_HELPER_FILE) {
    return matches(/isEnvFlagOn\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/g, allText);
  }
  if (key === "setting.name") return matches(/\bname:\s*"([A-Z][A-Z0-9_]*)"/g, file.text);
  if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
    const value = new RegExp(`\\b${key}\\s*=\\s*"([A-Z][A-Z0-9_]*)"`).exec(allText)?.[1];
    return value === undefined ? null : [value];
  }
  return null;
}

interface Collected {
  names: Set<string>;
  unresolved: string[];
}

function collectEnvNames(): Collected {
  const names = new Set<string>();
  const unresolved: string[] = [];
  for (const file of files) {
    for (const name of matches(/process\.env\.([A-Z][A-Z0-9_]*)/g, file.text)) names.add(name);
    for (const name of matches(/(?<!process\.)\benv\.([A-Z][A-Z0-9_]*)/g, file.text)) {
      unresolved.push(`${file.path}: env.${name}`);
    }
    for (const lhs of matches(/(\{[^}]*\})\s*=\s*process\.env\b/g, file.text)) {
      unresolved.push(`${file.path}: ${lhs} = process.env`);
    }
    for (const arg of matches(/isEnvFlagOn\(\s*([^)]*?)\s*\)/g, file.text)) {
      if (!/^"[A-Z][A-Z0-9_]*"$/.test(arg) && file.path !== ENV_FLAG_HELPER_FILE) {
        unresolved.push(`${file.path}: isEnvFlagOn(${arg})`);
      }
    }
    for (const key of matches(/\benv\[\s*([^\]]+?)\s*\]/g, file.text)) {
      const literal = /^"([A-Z][A-Z0-9_]*)"$/.exec(key)?.[1];
      const resolved = literal !== undefined ? [literal] : resolveIndirectKey(key, file);
      if (resolved === null || resolved.length === 0) unresolved.push(`${file.path}: env[${key}]`);
      else resolved.forEach((name) => names.add(name));
    }
  }
  return { names, unresolved };
}

const compose = load(readFileSync(join(serviceRoot, "docker-compose.prod.yml"), "utf8")) as {
  services: { api: { environment: Record<string, string | number> } };
};
const apiEnvironment = compose.services.api.environment;

/**
 * The default of a `NAME: ${NAME:-d}` mapping (the value the container sees
 * when the host does not set NAME), or null for any other form.
 */
function composeDefault(name: string): string | null {
  const m = /^\$\{([A-Z][A-Z0-9_]*):-([^}]*)\}$/.exec(String(apiEnvironment[name]));
  return m !== null && m[1] === name ? (m[2] as string) : null;
}

describe("RT-984 production compose passes every API env setting", () => {
  const { names, unresolved } = collectEnvNames();

  it("resolves every env read in apps/api/src to a name", () => {
    expect(unresolved).toEqual([]);
    // Sanity: the collector sees the indirect reads, not only literal ones.
    expect([...names]).toEqual(
      expect.arrayContaining([
        "POS_SALE_TENDERS_ENABLED",
        "POS_LEGACY_REFUND_ENABLED",
        "AI_RESERVATION_TTL_SECONDS",
        "CASHIER_TAKEOVER_LIMITER_TIMEOUT_MS",
      ]),
    );
  });

  it("maps every name into the api service environment, or excludes it with a reason", () => {
    const missing = [...names].filter((name) => !(name in apiEnvironment) && !(name in EXCLUDED)).sort();
    expect(missing).toEqual([]);
  });

  it("passes each mapped name from the host variable of the same name, or lists why not", () => {
    const misnamed = [...names]
      .filter((name) => name in apiEnvironment && !(name in FIXED_VALUES))
      .filter((name) => !String(apiEnvironment[name]).startsWith(`\${${name}:`))
      .sort();
    expect(misnamed).toEqual([]);
    for (const name of Object.keys(FIXED_VALUES)) expect(name in apiEnvironment).toBe(true);
  });

  it("keeps the exclusion list honest", () => {
    for (const name of Object.keys(EXCLUDED)) {
      expect(names.has(name)).toBe(true);
      expect(name in apiEnvironment).toBe(false);
    }
  });

  describe("compose defaults behave exactly like an unset variable", () => {
    const savedEnv = process.env;

    afterEach(() => {
      process.env = savedEnv;
    });

    function under(env: Record<string, string>, read: () => unknown): unknown {
      process.env = { ...savedEnv, NODE_ENV: "production", ...env };
      return read();
    }

    const PROJECT_ID = "P2composeEnvSpec";

    const probes: ReadonlyArray<[string, () => unknown]> = [
      ["POS_SALE_TENDERS_ENABLED", isPosSaleTendersEnabled],
      ["POS_SALE_TENDERS_SAME_METHOD_ENABLED", isPosSaleTendersSameMethodEnabled],
      ["POS_RETURNS_ENABLED", isPosReturnsEnabled],
      ["POS_REFUND_SETTLE_BEFORE_POST_ENABLED", isRefundSettleBeforePostEnabled],
      ["POS_LEGACY_REFUND_ENABLED", isLegacyRefundEnabled],
      ["DEVICE_TOKEN_EXPIRY_ENFORCED", isDeviceTokenExpiryEnforced],
      ["AI_GATEWAY_ENABLED", () => readAiGatewayRuntime().isEnabled()],
      ["OUTBOX_AUDIT_ENABLED", isOutboxAuditEnabled],
      ["TRUST_PROXY_REQUIRED", () => checkTrustProxyConfig({ ...process.env, TRUST_PROXY: "" })],
      ["AI_RESERVATION_TTL_SECONDS", () => resolveAiReservationTtlSeconds()],
      ["PUBLIC_AUTH_LIMITER_TIMEOUT_MS", () => readPublicAuthLimiterTimeoutMs()],
      ["CONSOLE_RATE_LIMIT_MODE", () => readConsoleRateLimitConfig()],
      ["CONSOLE_RATE_LIMIT_TIMEOUT_MS", () => readConsoleRateLimitConfig()],
      ["PREAUTH_RATE_LIMIT_MODE", () => readPreAuthRateLimitConfig()],
      ["PREAUTH_RATE_LIMIT_LIMIT", () => readPreAuthRateLimitConfig()],
      ["PREAUTH_RATE_LIMIT_WINDOW_MS", () => readPreAuthRateLimitConfig()],
      ["PREAUTH_RATE_LIMIT_TIMEOUT_MS", () => readPreAuthRateLimitConfig()],
      ["CASHIER_ADMISSION_TTL_SECONDS", () => readCashierAdmissionPolicy()],
      ["CASHIER_OFFLINE_GRACE_SECONDS", () => readCashierAdmissionPolicy()],
      ["CASHIER_TAKEOVER_RATE_LIMIT", () => readCashierAdmissionPolicy()],
      ["CASHIER_TAKEOVER_RATE_WINDOW_SECONDS", () => readCashierAdmissionPolicy()],
      ["CASHIER_TAKEOVER_LIMITER_TIMEOUT_MS", () => readTakeoverLimiterTimeoutMs()],
      ["DESCOPE_JWT_ISSUER", () => descopeVerifierConfig(PROJECT_ID)],
      ["DESCOPE_JWT_AUDIENCE", () => descopeVerifierConfig(PROJECT_ID)],
      [
        "DESCOPE_MANAGEMENT_KEY",
        () => {
          process.env["DESCOPE_PROJECT_ID"] = PROJECT_ID;
          return Reflect.get(descopeAuthFactory(), "managementKey");
        },
      ],
      ["CONSOLE_SENTRY_DSN", () => resolveForwardTarget(process.env)],
    ];

    it.each(probes)("%s", (name, read) => {
      const fallback = composeDefault(name);
      expect(fallback).not.toBeNull();
      const unset = under({}, () => {
        delete process.env[name];
        return read();
      });
      expect(under({ [name]: fallback ?? "" }, read)).toEqual(unset);
    });

    it("probes every name whose compose default claims to equal unset ('' or 'false')", () => {
      const probed = new Set(probes.map(([name]) => name));
      const unprobed = [...names]
        .filter((name) => name in apiEnvironment && !probed.has(name))
        .filter((name) => ["", "false"].includes(composeDefault(name) ?? "fixed"));
      expect(unprobed).toEqual([]);
    });

    it("keeps the RT-124 production audit default (OUTBOX_AUDIT_ENABLED is empty, never false)", () => {
      expect(composeDefault("OUTBOX_AUDIT_ENABLED")).toBe("");
      expect(under({ OUTBOX_AUDIT_ENABLED: "" }, isOutboxAuditEnabled)).toBe(true);
    });
  });
});
