/**
 * RT-1298: the guard of the pilot registry writes (register, withdraw). It
 * authenticates only the promotion workflow's GitHub OIDC bearer: a missing or
 * non-bearer credential, or a disabled lane, is 401 and never reaches the
 * verifier; the verifier's verdict maps to 401 or 403; a success attaches the
 * principal and nothing else. A Console cookie is never accepted.
 */
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";

import { PromotionWriterGuard } from "../../src/pos-pilot-releases/promotion-writer.guard";
import type { PromotionOidcVerifier, PromotionVerdict } from "../../src/pos-pilot-releases/promotion-oidc.verifier";

interface FakeRequest {
  headers: Record<string, string | undefined>;
  principal?: unknown;
  promotionPrincipal?: unknown;
}

/** A guard over a fake verifier that records what it was asked to verify. */
function build(verdict: PromotionVerdict, enabled = true) {
  const verify = jest.fn(async (_raw: string) => verdict);
  const verifier = enabled ? ({ verify } as unknown as PromotionOidcVerifier) : null;
  return { guard: new PromotionWriterGuard(verifier), verify };
}

function contextOf(request: FakeRequest): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

const PRINCIPAL = { actor: "kemetra-owner", runId: "123456789", repository: "Kemetra-Labs/Retail-Tower-Erp" };

describe("RT-1298 PromotionWriterGuard", () => {
  it("attaches the principal and allows a verified token", async () => {
    const { guard, verify } = build({ ok: true, principal: PRINCIPAL });
    const request: FakeRequest = { headers: { authorization: "Bearer abc.def.ghi" } };
    await expect(guard.canActivate(contextOf(request))).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith("abc.def.ghi");
    expect(request.promotionPrincipal).toEqual(PRINCIPAL);
  });

  it.each([
    ["no Authorization header", {}],
    ["a Basic credential", { authorization: "Basic dXNlcjpwYXNz" }],
    ["an empty bearer", { authorization: "Bearer " }],
    ["a cookie only", { cookie: "dp2_session=abc" }],
  ])("answers 401 without verifying for %s", async (_label, headers) => {
    const { guard, verify } = build({ ok: true, principal: PRINCIPAL });
    await expect(guard.canActivate(contextOf({ headers }))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verify).not.toHaveBeenCalled();
  });

  it("answers 401 for every token while the lane is disabled, without verifying", async () => {
    const { guard, verify } = build({ ok: true, principal: PRINCIPAL }, false);
    const request: FakeRequest = { headers: { authorization: "Bearer abc.def.ghi" } };
    await expect(guard.canActivate(contextOf(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verify).not.toHaveBeenCalled();
    expect(request.promotionPrincipal).toBeUndefined();
  });

  it("maps a 401 verdict to 401 and attaches nothing", async () => {
    const { guard } = build({ ok: false, status: 401 });
    const request: FakeRequest = { headers: { authorization: "Bearer abc.def.ghi" } };
    await expect(guard.canActivate(contextOf(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.promotionPrincipal).toBeUndefined();
  });

  it("maps a 403 verdict to 403 `forbidden` and attaches nothing", async () => {
    const { guard } = build({ ok: false, status: 403 });
    const request: FakeRequest = { headers: { authorization: "Bearer abc.def.ghi" } };
    const failure: unknown = await guard.canActivate(contextOf(request)).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ForbiddenException);
    expect((failure as ForbiddenException).getResponse()).toMatchObject({ code: "forbidden" });
    expect(request.promotionPrincipal).toBeUndefined();
  });

  it("does not let a Console session principal stand in for the credential", async () => {
    const { guard } = build({ ok: true, principal: PRINCIPAL });
    const request: FakeRequest = { headers: {}, principal: { kind: "session", userId: "u1" } };
    await expect(guard.canActivate(contextOf(request))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("never puts the token in an error", async () => {
    const { guard } = build({ ok: false, status: 403 });
    const failure: unknown = await guard
      .canActivate(contextOf({ headers: { authorization: "Bearer secret.token.value" } }))
      .catch((err: unknown) => err);
    expect(JSON.stringify((failure as ForbiddenException).getResponse())).not.toContain("secret.token.value");
  });
});
