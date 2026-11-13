/**
 * turnstile-verifier.unit.spec.ts — RT-1350 slice 3 (design D5, owner card 2026-11-13
 * "Cloudflare Turnstile"): the human-proof port, its Turnstile adapter and the
 * fail-closed `unconfigured` adapter. No network: `fetch` is injected.
 */
import {
  humanProofVerifierFromEnv,
  TurnstileHumanProofVerifier,
  UnconfiguredHumanProofVerifier,
} from "../../src/signups/turnstile.verifier";

const SECRET = "turnstile-test-secret-value";
const BASE = { secret: SECRET, expectedHostname: "console.example.test", expectedAction: "signup" };

type FetchCall = { url: string; body: URLSearchParams };

function fetchReturning(
  json: unknown,
  opts: { ok?: boolean; status?: number; reject?: boolean } = {},
): { fetchFn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
    if (opts.reject) throw new Error("network down");
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => json,
    } as Response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("TurnstileHumanProofVerifier", () => {
  it("posts the secret, the token and the remote IP to siteverify and accepts a matching hostname and action", async () => {
    const { fetchFn, calls } = fetchReturning({ success: true, hostname: "console.example.test", action: "signup" });
    const verifier = new TurnstileHumanProofVerifier({ ...BASE, fetchFn });

    await expect(verifier.verify({ token: "tok", remoteIp: "203.0.113.9" })).resolves.toEqual({ kind: "ok" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(calls[0]?.body.get("secret")).toBe(SECRET);
    expect(calls[0]?.body.get("response")).toBe("tok");
    expect(calls[0]?.body.get("remoteip")).toBe("203.0.113.9");
  });

  it("omits remoteip when the client address is unknown", async () => {
    const { fetchFn, calls } = fetchReturning({ success: true, hostname: "console.example.test", action: "signup" });
    await new TurnstileHumanProofVerifier({ ...BASE, fetchFn }).verify({ token: "tok", remoteIp: "unknown" });
    expect(calls[0]?.body.has("remoteip")).toBe(false);
  });

  it("refuses success:false (a failed or reused challenge)", async () => {
    const { fetchFn } = fetchReturning({ success: false, "error-codes": ["invalid-input-response"] });
    await expect(new TurnstileHumanProofVerifier({ ...BASE, fetchFn }).verify({ token: "t", remoteIp: "1.2.3.4" })).resolves.toEqual({
      kind: "refused",
    });
  });

  it("refuses a token minted for another hostname", async () => {
    const { fetchFn } = fetchReturning({ success: true, hostname: "evil.example", action: "signup" });
    await expect(new TurnstileHumanProofVerifier({ ...BASE, fetchFn }).verify({ token: "t", remoteIp: "1.2.3.4" })).resolves.toEqual({
      kind: "refused",
    });
  });

  it("refuses a token minted for another action", async () => {
    const { fetchFn } = fetchReturning({ success: true, hostname: "console.example.test", action: "login" });
    await expect(new TurnstileHumanProofVerifier({ ...BASE, fetchFn }).verify({ token: "t", remoteIp: "1.2.3.4" })).resolves.toEqual({
      kind: "refused",
    });
  });

  it("is unavailable (never refused) on a network error, a non-2xx answer, a malformed answer and a timeout", async () => {
    const cases = [
      fetchReturning({}, { reject: true }),
      fetchReturning({}, { ok: false, status: 502 }),
      fetchReturning("not-an-object"),
      fetchReturning({ success: false, "error-codes": ["internal-error"] }),
      fetchReturning({ success: false, "error-codes": ["invalid-input-secret"] }),
    ];
    for (const c of cases) {
      await expect(new TurnstileHumanProofVerifier({ ...BASE, fetchFn: c.fetchFn }).verify({ token: "t", remoteIp: "1.2.3.4" })).resolves.toEqual({
        kind: "unavailable",
      });
    }
    const hang = (() => new Promise(() => undefined)) as unknown as typeof fetch;
    await expect(new TurnstileHumanProofVerifier({ ...BASE, fetchFn: hang, timeoutMs: 20 }).verify({ token: "t", remoteIp: "1.2.3.4" })).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("never puts the secret or the token in an error or a log line it raises", async () => {
    const lines: string[] = [];
    const logWarn = (fields: Record<string, unknown>, message: string): void => {
      lines.push(JSON.stringify([fields, message]));
    };
    const rejecting = (async () => {
      throw new Error(`boom ${SECRET} super-secret-token`);
    }) as unknown as typeof fetch;
    await new TurnstileHumanProofVerifier({ ...BASE, fetchFn: rejecting, logWarn }).verify({
      token: "super-secret-token",
      remoteIp: "1.2.3.4",
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("")).not.toContain(SECRET);
    expect(lines.join("")).not.toContain("super-secret-token");
    expect(lines.join("")).not.toContain("1.2.3.4");
  });
});

describe("humanProofVerifierFromEnv", () => {
  it("is Turnstile when the secret and the expected hostname are set", () => {
    const v = humanProofVerifierFromEnv({ TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_EXPECTED_HOSTNAME: "console.example.test" });
    expect(v).toBeInstanceOf(TurnstileHumanProofVerifier);
  });

  it("fails closed (unconfigured) when the secret is unset or blank", async () => {
    for (const env of [{}, { TURNSTILE_SECRET_KEY: "  ", TURNSTILE_EXPECTED_HOSTNAME: "h.test" }]) {
      const v = humanProofVerifierFromEnv(env);
      expect(v).toBeInstanceOf(UnconfiguredHumanProofVerifier);
      await expect(v.verify({ token: "t", remoteIp: "1.2.3.4" })).resolves.toEqual({ kind: "unavailable" });
    }
  });

  it("fails closed when the secret is set but the expected hostname is not (no hostname binding is not allowed)", () => {
    expect(humanProofVerifierFromEnv({ TURNSTILE_SECRET_KEY: SECRET })).toBeInstanceOf(UnconfiguredHumanProofVerifier);
  });
});
