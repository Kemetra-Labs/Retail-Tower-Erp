/**
 * linking-identity-provider.adapter.unit.spec.ts — 029 D3 (T4 / T5).
 *
 * Docker-free coverage for the shared half of every identity adapter
 * (`LinkingIdentityProviderAdapter`), exercised through the Descope adapter (the
 * only provider since RT-800; moved from the retired Clerk adapter's spec):
 *   - linkExternalIdentity writes a row and returns its id;
 *   - the defined-but-not-wired lifecycle seams throw loudly (fail fast, never
 *     a silent no-op).
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { DescopeIdentityProviderAdapter } from "../../src/auth/descope-identity-provider.adapter";
import type { OperatorTokenVerifier } from "../../src/auth/operator-token-verifier";

const SUB = "U2linkingSubject01";
const USER_ID = "0a000000-0000-7000-8000-00000000aa01";

function fakeVerifier(): OperatorTokenVerifier {
  return { verify: async () => ({ providerKey: "descope", sub: SUB }) };
}

function adapterWith(query: jest.Mock): DescopeIdentityProviderAdapter {
  return new DescopeIdentityProviderAdapter(fakeVerifier(), { query } as unknown as Pool, "i");
}

describe("LinkingIdentityProviderAdapter — linkExternalIdentity", () => {
  it("inserts a link row and returns its id", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: "link-id-1" }] });
    const r = await adapterWith(query).linkExternalIdentity({
      providerKey: "descope",
      issuer: "https://issuer.example",
      subject: SUB,
      userId: USER_ID,
      email: "u@example.com",
    });
    expect(r).toEqual({ id: "link-id-1" });
    expect(query).toHaveBeenCalledTimes(1);
    const params = query.mock.calls[0][1] as unknown[];
    expect(params).toEqual(["descope", "https://issuer.example", SUB, USER_ID, "u@example.com"]);
  });

  it("passes null email when omitted", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: "x" }] });
    await adapterWith(query).linkExternalIdentity({
      providerKey: "descope",
      issuer: "i",
      subject: SUB,
      userId: USER_ID,
    });
    const params = query.mock.calls[0][1] as unknown[];
    expect(params[4]).toBeNull();
  });

  it("throws if the insert returns no row", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await expect(
      adapterWith(query).linkExternalIdentity({
        providerKey: "descope",
        issuer: "i",
        subject: SUB,
        userId: USER_ID,
      }),
    ).rejects.toThrow("returned no id");
  });
});

describe("LinkingIdentityProviderAdapter — lifecycle seams (T5, not wired in D3)", () => {
  const adapter = adapterWith(jest.fn());

  it("getIdentityProfile throws not-wired", async () => {
    await expect(adapter.getIdentityProfile(SUB)).rejects.toThrow("not wired in D3");
  });
  it("createIdentity throws not-wired", async () => {
    await expect(adapter.createIdentity({ email: "a@b.c" })).rejects.toThrow("not wired in D3");
  });
  it("inviteUser throws not-wired", async () => {
    await expect(adapter.inviteUser({ email: "a@b.c" })).rejects.toThrow("not wired in D3");
  });
  it("disableIdentity throws not-wired", async () => {
    await expect(adapter.disableIdentity(USER_ID)).rejects.toThrow("not wired in D3");
  });
  it("enableIdentity throws not-wired", async () => {
    await expect(adapter.enableIdentity(USER_ID)).rejects.toThrow("not wired in D3");
  });
  it("sendPasswordReset throws not-wired", async () => {
    await expect(adapter.sendPasswordReset("a@b.c")).rejects.toThrow("not wired in D3");
  });
});
