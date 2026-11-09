/**
 * RT-1298: the verifier of the pilot promotion credential. Tokens are signed here
 * with a locally generated RSA key pair and checked through an injected key
 * resolver, so nothing goes to GitHub.
 *
 * Mapping (contract): a token that cannot be authenticated (missing, malformed,
 * badly signed, expired, wrong issuer or audience, JWKS unavailable) is 401; a
 * genuine token whose claims do not match the configured pins is 403. The
 * verdict carries only the actor, run id and repository, never the token.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type KeyLike } from "jose";

import type { PromotionOidcConfig } from "../../src/pos-pilot-releases/promotion-oidc.config";
import {
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_JWKS_URL,
  PromotionOidcVerifier,
  createPromotionKeyResolver,
} from "../../src/pos-pilot-releases/promotion-oidc.verifier";

const CONFIG = {
  enabled: true,
  audience: "retail-tower-backend-core",
  repository: "Kemetra-Labs/Retail-Tower-Erp",
  environment: "release-pos-pilot-promote",
  ref: "refs/heads/main",
  workflowRef: "Kemetra-Labs/Retail-Tower-Erp/.github/workflows/promote-pos-pilot.yml@refs/heads/main",
} as const satisfies Extract<PromotionOidcConfig, { enabled: true }>;

const CLAIMS = {
  repository: CONFIG.repository,
  environment: CONFIG.environment,
  ref: CONFIG.ref,
  job_workflow_ref: CONFIG.workflowRef,
  actor: "kemetra-owner",
  run_id: "123456789",
};

interface Keys {
  readonly privateKey: KeyLike;
  readonly jwks: ReturnType<typeof createLocalJWKSet>;
}

/** A fresh RSA key pair and a local key set that holds its public half under `k1`. */
async function makeKeys(): Promise<Keys> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

interface SignOptions {
  readonly claims?: Record<string, unknown>;
  readonly issuer?: string;
  readonly audience?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number | null;
  readonly key?: KeyLike;
}

/** A GitHub-shaped token, valid unless an option says otherwise. */
async function sign(keys: Keys, options: SignOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ ...CLAIMS, ...options.claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(options.issuer ?? GITHUB_OIDC_ISSUER)
    .setAudience(options.audience ?? CONFIG.audience)
    .setIssuedAt(options.issuedAt ?? now);
  if (options.expiresAt !== null) jwt.setExpirationTime(options.expiresAt ?? now + 300);
  return await jwt.sign(options.key ?? keys.privateKey);
}

describe("RT-1298 PromotionOidcVerifier", () => {
  let keys: Keys;
  let verifier: PromotionOidcVerifier;

  beforeAll(async () => {
    keys = await makeKeys();
    verifier = new PromotionOidcVerifier(CONFIG, keys.jwks);
  });

  it("accepts a genuine token that matches every pin, and returns only the actor, run and repository", async () => {
    const token = await sign(keys);
    const verdict = await verifier.verify(token);
    expect(verdict).toEqual({
      ok: true,
      principal: { actor: "kemetra-owner", runId: "123456789", repository: CONFIG.repository },
    });
    expect(JSON.stringify(verdict)).not.toContain(token);
  });

  it.each([
    ["another audience", { audience: "someone-else" }],
    ["another issuer", { issuer: "https://evil.example.com" }],
    ["an expired token", { issuedAt: Math.floor(Date.now() / 1000) - 600, expiresAt: Math.floor(Date.now() / 1000) - 300 }],
    ["a token older than 15 minutes", { issuedAt: Math.floor(Date.now() / 1000) - 1200 }],
    ["no expiry", { expiresAt: null }],
  ])("answers 401 for %s", async (_label, options: SignOptions) => {
    expect(await verifier.verify(await sign(keys, options))).toEqual({ ok: false, status: 401 });
  });

  it("answers 401 for a token signed by another key", async () => {
    const other = await makeKeys();
    expect(await verifier.verify(await sign(keys, { key: other.privateKey }))).toEqual({ ok: false, status: 401 });
  });

  it("answers 401 for an unsigned token, an HMAC token, and garbage", async () => {
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ ...CLAIMS, iss: GITHUB_OIDC_ISSUER, aud: CONFIG.audience })).toString("base64url")}.`;
    const hmac = await new SignJWT({ ...CLAIMS })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer(GITHUB_OIDC_ISSUER)
      .setAudience(CONFIG.audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("a-shared-secret-of-at-least-32-bytes!!"));
    for (const raw of [unsigned, hmac, "not-a-jwt", "", "a.b.c"]) {
      expect(await verifier.verify(raw)).toEqual({ ok: false, status: 401 });
    }
  });

  it.each([
    ["the repository", { repository: "Kemetra-Labs/Another-Repo" }],
    ["the environment", { environment: "some-other-environment" }],
    ["the ref", { ref: "refs/heads/feature" }],
    ["the workflow", { job_workflow_ref: "Kemetra-Labs/Retail-Tower-Erp/.github/workflows/other.yml@refs/heads/main" }],
  ])("answers 403 for a genuine token with another %s", async (_label, claims) => {
    expect(await verifier.verify(await sign(keys, { claims }))).toEqual({ ok: false, status: 403 });
  });

  it.each(["repository", "environment", "ref", "job_workflow_ref"])(
    "answers 403 for a genuine token without the %s claim",
    async (claim) => {
      const claims = { ...CLAIMS, [claim]: undefined };
      expect(await verifier.verify(await sign(keys, { claims }))).toEqual({ ok: false, status: 403 });
    },
  );

  it.each([
    ["no actor", { actor: undefined }],
    ["an actor that is not a GitHub login", { actor: "evil actor; DROP" }],
    ["a bot actor", { actor: "dependabot[bot]" }],
    ["an over-long actor", { actor: "a".repeat(40) }],
    ["no run id", { run_id: undefined }],
    ["a run id that is not a number", { run_id: "12ab" }],
    ["a numeric run id (GitHub sends a string)", { run_id: 123 }],
  ])("answers 403 for %s", async (_label, claims) => {
    expect(await verifier.verify(await sign(keys, { claims }))).toEqual({ ok: false, status: 403 });
  });

  it("answers 401, and does not throw, when the key set is unavailable", async () => {
    const down = new PromotionOidcVerifier(CONFIG, async () => {
      throw new Error("JWKS fetch failed: ECONNREFUSED");
    });
    const token = await sign(keys);
    await expect(down.verify(token)).resolves.toEqual({ ok: false, status: 401 });
  });

});

describe("RT-1298 createPromotionKeyResolver (the production key source)", () => {
  /** Serves one JWKS document on a loopback port until closed. */
  async function serve(jwk: JWK): Promise<{ url: URL; close: () => Promise<void> }> {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: new URL(`http://127.0.0.1:${port}/.well-known/jwks`),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("verifies with a cached key after the key source goes away, and answers 401 for a key it never had", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const source = await serve(jwk);
    const verifier = new PromotionOidcVerifier(CONFIG, createPromotionKeyResolver(source.url));
    const keys: Keys = { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };

    expect((await verifier.verify(await sign(keys))).ok).toBe(true);
    await source.close();
    expect((await verifier.verify(await sign(keys))).ok).toBe(true);

    const stranger = await generateKeyPair("RS256", { extractable: true });
    const unknown = await new SignJWT({ ...CLAIMS })
      .setProtectedHeader({ alg: "RS256", kid: "k2" })
      .setIssuer(GITHUB_OIDC_ISSUER)
      .setAudience(CONFIG.audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(stranger.privateKey);
    expect(await verifier.verify(unknown)).toEqual({ ok: false, status: 401 });
  });

  it("answers 401 when no key was ever fetched and the source is down", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const source = await serve(jwk);
    const url = source.url;
    await source.close();
    const verifier = new PromotionOidcVerifier(CONFIG, createPromotionKeyResolver(url));
    const keys: Keys = { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
    expect(await verifier.verify(await sign(keys))).toEqual({ ok: false, status: 401 });
  });

  it("points at GitHub's key set by default", () => {
    expect(GITHUB_OIDC_JWKS_URL).toBe("https://token.actions.githubusercontent.com/.well-known/jwks");
  });
});
