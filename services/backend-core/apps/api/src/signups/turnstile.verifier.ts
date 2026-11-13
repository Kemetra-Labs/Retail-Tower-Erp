/**
 * Cloudflare Turnstile adapter of the human-proof port (RT-1350 slice 3, design D5;
 * owner card 2026-11-13: "Cloudflare Turnstile").
 *
 * EXIT-COST NOTE (the vendor is a new external dependency of the public signup):
 *   - Lock-in is small and confined to this file. Backend-Core knows the vendor only
 *     as `HumanProofVerifier.verify({ token, remoteIp })`; the Console sends an opaque
 *     `humanProof` string and the contract names no vendor.
 *   - To switch (hCaptcha, reCAPTCHA, a self-hosted check): write one adapter with the
 *     same port, bind it in `humanProofVerifierFromEnv`, and swap the widget in the
 *     Console signup page (a separate slice). No contract, schema or limiter change.
 *     Estimated effort: about a day plus the Console widget swap.
 *   - Runtime coupling: one outbound HTTPS call per `requestSignup` that passes the
 *     per-IP limiter, with a short timeout. A Turnstile outage fails the signup route
 *     closed (503 + Retry-After): signup is unavailable, existing sign-in is not.
 *   - Data shared with the vendor: the challenge token and the caller's IP (the
 *     `remoteip` field). No email, name or business name is sent.
 *
 * Configuration (secrets come from the environment, never from code or logs):
 *   TURNSTILE_SECRET_KEY         the siteverify secret. Unset or blank: fail closed.
 *   TURNSTILE_EXPECTED_HOSTNAME  the Console hostname the token must be minted for.
 *                                Required with the secret: without a hostname binding a
 *                                token solved on another site would be accepted.
 *   TURNSTILE_EXPECTED_ACTION    the widget `action` (default `signup`).
 *
 * This adapter never throws for an expected failure and never logs the secret, the
 * token or the address; a failure is logged as a reason label only.
 */
import { createLogger, type Logger } from "@data-pulse-2/shared";

import type { HumanProofInput, HumanProofResult, HumanProofVerifier } from "./human-proof.port";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_ACTION = "signup";
const DEFAULT_TIMEOUT_MS = 3_000;

/** Turnstile error codes that mean OUR configuration or THEIR service is broken, not that the caller failed. */
const UNAVAILABLE_ERROR_CODES = new Set(["internal-error", "invalid-input-secret", "missing-input-secret"]);

type Env = Readonly<Record<string, string | undefined>>;
type LogWarn = (fields: Record<string, unknown>, message: string) => void;

let logger: Logger | null = null;
function defaultLogWarn(fields: Record<string, unknown>, message: string): void {
  logger ??= createLogger({ service: "api.signups", level: process.env["LOG_LEVEL"] ?? "info" });
  logger.warn(fields, message);
}

export interface TurnstileOptions {
  readonly secret: string;
  readonly expectedHostname: string;
  readonly expectedAction?: string;
  readonly timeoutMs?: number;
  /** Injected in tests. */
  readonly fetchFn?: typeof fetch;
  /** Injected in tests; the default writes to the service logger. */
  readonly logWarn?: LogWarn;
}

export class TurnstileHumanProofVerifier implements HumanProofVerifier {
  private readonly secret: string;
  private readonly expectedHostname: string;
  private readonly expectedAction: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly logWarn: LogWarn;

  constructor(options: TurnstileOptions) {
    this.secret = options.secret;
    this.expectedHostname = options.expectedHostname.toLowerCase();
    this.expectedAction = options.expectedAction ?? DEFAULT_ACTION;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
    this.logWarn = options.logWarn ?? defaultLogWarn;
  }

  async verify(input: HumanProofInput): Promise<HumanProofResult> {
    const answer = await this.siteverify(input);
    if (answer === null) return { kind: "unavailable" };
    if (answer["success"] !== true) {
      const codes = Array.isArray(answer["error-codes"]) ? (answer["error-codes"] as unknown[]) : [];
      if (codes.some((c) => typeof c === "string" && UNAVAILABLE_ERROR_CODES.has(c))) {
        this.logWarn({ reason: "provider_error" }, "human-proof verifier reported a configuration or service error");
        return { kind: "unavailable" };
      }
      return { kind: "refused" };
    }
    const hostname = typeof answer["hostname"] === "string" ? answer["hostname"].toLowerCase() : null;
    if (hostname !== this.expectedHostname || answer["action"] !== this.expectedAction) return { kind: "refused" };
    return { kind: "ok" };
  }

  /** The decoded siteverify answer, or null for any transport or shape failure. */
  private async siteverify(input: HumanProofInput): Promise<Record<string, unknown> | null> {
    const body = new URLSearchParams({ secret: this.secret, response: input.token });
    if (input.remoteIp !== "unknown" && input.remoteIp.length > 0) body.set("remoteip", input.remoteIp);

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, this.timeoutMs);
      timer.unref();
    });
    try {
      const response = await Promise.race([
        this.fetchFn(SITEVERIFY_URL, { method: "POST", body, signal: controller.signal }),
        timedOut,
      ]);
      if (response === "timeout") {
        this.logWarn({ reason: "timeout" }, "human-proof verifier did not answer in time");
        return null;
      }
      if (!response.ok) {
        this.logWarn({ reason: "http_status", status: response.status }, "human-proof verifier answered an error status");
        return null;
      }
      const json: unknown = await response.json();
      if (typeof json !== "object" || json === null || Array.isArray(json)) {
        this.logWarn({ reason: "malformed" }, "human-proof verifier answered an unreadable body");
        return null;
      }
      return json as Record<string, unknown>;
    } catch {
      // The error text can echo request data; log the reason label only.
      this.logWarn({ reason: "network" }, "human-proof verifier could not be reached");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The production default when nothing is configured: every check is `unavailable` (503, fail closed). */
export class UnconfiguredHumanProofVerifier implements HumanProofVerifier {
  verify(_input: HumanProofInput): Promise<HumanProofResult> {
    return Promise.resolve({ kind: "unavailable" });
  }
}

/**
 * The verifier for this process. Turnstile only with BOTH the secret and the expected
 * hostname; anything less is the fail-closed `unconfigured` adapter, so the public
 * signup stays closed rather than running without a human check.
 */
export function humanProofVerifierFromEnv(env: Env = process.env): HumanProofVerifier {
  const secret = (env["TURNSTILE_SECRET_KEY"] ?? "").trim();
  const hostname = (env["TURNSTILE_EXPECTED_HOSTNAME"] ?? "").trim();
  if (secret === "" || hostname === "") return new UnconfiguredHumanProofVerifier();
  const action = (env["TURNSTILE_EXPECTED_ACTION"] ?? "").trim();
  return new TurnstileHumanProofVerifier({
    secret,
    expectedHostname: hostname,
    ...(action === "" ? {} : { expectedAction: action }),
  });
}
