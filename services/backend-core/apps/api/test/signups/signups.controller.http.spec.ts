/**
 * signups.controller.http.spec.ts — RT-1350 slice 3: the two PUBLIC signup routes over HTTP
 * (contract `signups.openapi.yaml`), with the real controller + service and fake store,
 * limiter, provider and human-proof verifier. Docker-free. Pins the contract's
 * NON-DISCLOSURE rules: requestSignup answers the same empty 202 for every address,
 * every 400 is one generic body, and a completion never reveals which check failed.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { RateLimiter } from "../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { SignupsController } from "../../src/signups/signups.controller";
import { SIGNUP_INVALID_MESSAGE } from "../../src/signups/signup.dto";
import { SignupsService } from "../../src/signups/signups.service";
import { createHash } from "node:crypto";
import { makeService, NOW, REQUEST, type Harness } from "./signups.fakes";

const TOKEN = "raw-signup-token-0123456789012345678901234";
const PASSWORD = "Correct-Horse-Battery-9!";

let app: INestApplication;
let h: Harness;

async function boot(): Promise<void> {
  h = makeService();
  const moduleRef = await Test.createTestingModule({
    controllers: [SignupsController],
    providers: [
      { provide: SignupsService, useValue: h.service },
      { provide: RateLimiter, useValue: h.limiter },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
}

beforeEach(async () => {
  await boot();
  h.store.pendingByTokenHash.set(createHash("sha256").update(TOKEN, "utf8").digest("hex"), {
    id: "p-1",
    emailNormalized: "owner@example.com",
    name: "Mona Hassan",
    businessName: "Hassan Market",
    locale: "ar",
    termsVersion: "2026-11",
    termsAcceptedAt: NOW,
    ipHash: "a".repeat(64),
    status: "pending",
    expiresAt: new Date(NOW.getTime() + 3_600_000),
  });
});

afterEach(async () => {
  await h.service.settleWork();
  await app.close();
});

const post = (path: string, body: unknown) => request(app.getHttpServer()).post(path).send(body as object);
const signup = (body: unknown = REQUEST) => post("/api/v1/signups", body);
const complete = (body: unknown = { token: TOKEN, password: PASSWORD }) => post("/api/v1/signups/complete", body);

/** The observable shape of an answer: status, body and header NAMES/values that matter. */
function shape(res: request.Response): unknown {
  const { date: _d, "x-request-id": _r, connection: _c, "keep-alive": _k, etag: _e, ...rest } = res.headers;
  return { status: res.status, text: res.text, headers: rest };
}

describe("POST /api/v1/signups: non-disclosure", () => {
  it("answers the identical empty 202 for a new, an existing, a pending, a disabled, a platform-admin, a disposable and an over-limit address", async () => {
    const answers: unknown[] = [];

    answers.push(shape(await signup())); // new

    h.store.user = { id: "u-1", isPlatformAdmin: false, blocked: false };
    answers.push(shape(await signup())); // existing active user

    h.store.existingPending = true;
    answers.push(shape(await signup())); // already pending

    h.store.user = { id: "u-2", isPlatformAdmin: false, blocked: true };
    answers.push(shape(await signup())); // disabled

    h.store.user = { id: "u-3", isPlatformAdmin: true, blocked: false };
    answers.push(shape(await signup())); // platform admin

    h.store.user = null;
    answers.push(shape(await signup({ ...REQUEST, email: "x@mailinator.com" }))); // disposable

    h.limiter.blocked.add("signup_create_email");
    answers.push(shape(await signup())); // over its per-email limit

    for (const a of answers) expect(a).toEqual(answers[0]);
    expect((answers[0] as { status: number; text: string }).status).toBe(202);
    expect((answers[0] as { text: string }).text).toBe("");
  });

  it("a malformed body, a non-current terms version and a failed human proof are ONE generic 400 body", async () => {
    const bodies = [{}, { ...REQUEST, termsVersion: "1999-01" }, { ...REQUEST, termsAccepted: false }];
    const answers = [];
    for (const b of bodies) answers.push(await signup(b));
    h.humanProof.next = { kind: "refused" };
    answers.push(await signup());

    for (const a of answers) {
      expect(a.status).toBe(400);
      expect(a.body.error).toMatchObject({ code: "validation_error", message: SIGNUP_INVALID_MESSAGE });
      expect(a.body.error.details).toBeUndefined();
      expect(a.body.error).toEqual({ ...answers[0]!.body.error, request_id: a.body.error.request_id });
    }
  });

  it("never echoes the address, the name or the proof in any response", async () => {
    const ok = await signup();
    const bad = await signup({ ...REQUEST, termsAccepted: false });
    for (const r of [ok, bad]) {
      expect(r.text).not.toContain("owner@example.com");
      expect(r.text).not.toContain(REQUEST.humanProof);
    }
  });
});

describe("POST /api/v1/signups: limits, origin and outages", () => {
  it("is 429 with Retry-After when the per-IP bucket is over, before the human proof is spent", async () => {
    h.limiter.blocked.add("signup_create_ip");
    const res = await signup();
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("60");
    expect(h.humanProof.calls).toHaveLength(0);
  });

  it("fails closed with 503 + Retry-After when the limiter is down", async () => {
    h.limiter.broken = true;
    const res = await signup();
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body.error.code).toBe("service_unavailable");
    expect(h.humanProof.calls).toHaveLength(0);
  });

  it("is 503 + Retry-After (not a 400) when the human-proof verifier is unavailable", async () => {
    h.humanProof.next = { kind: "unavailable" };
    const res = await signup();
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body.error.code).toBe("service_unavailable");
  });

  it("is 403 origin_rejected for a foreign Origin and admits a missing one", async () => {
    const foreign = await signup().set("Origin", "https://evil.example");
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe("origin_rejected");
    expect((await signup()).status).toBe(202);
  });

  it("uses the signup_create_ip bucket", async () => {
    await signup();
    expect(h.limiter.buckets).toContain("signup_create_ip");
  });
});

describe("POST /api/v1/signups/complete", () => {
  it("201 returns exactly {tenantId, membershipRole: owner, entitlement: restricted} and sets the HttpOnly session cookie", async () => {
    const res = await complete();

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["entitlement", "membershipRole", "tenantId"]);
    expect(res.body.membershipRole).toBe("owner");
    expect(res.body.entitlement).toBe("restricted");
    expect(res.body.tenantId).toBe(h.store.tenants[0]!.tenantId);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(res.text).not.toContain(TOKEN);
    expect(res.text).not.toContain(PASSWORD);
  });

  it("a second complete with the same token is the generic 400 with NO cookie and NO second tenant", async () => {
    expect((await complete()).status).toBe(201);
    const again = await complete();
    expect(again.status).toBe(400);
    expect(again.headers["set-cookie"]).toBeUndefined();
    expect(h.store.tenants).toHaveLength(1);
  });

  it("an unknown token, a rejected password and a platform admin are one generic 400 body", async () => {
    const unknown = await complete({ token: "no-such-token", password: PASSWORD });

    h.external.setPassword = { kind: "rejected" };
    const weak = await complete();

    h.external.setPassword = { kind: "ok" };
    h.store.user = { id: "u-admin", isPlatformAdmin: true, blocked: false };
    const admin = await complete();

    for (const r of [unknown, weak, admin]) {
      expect(r.status).toBe(400);
      expect(r.headers["set-cookie"]).toBeUndefined();
      expect(r.body.error).toMatchObject({ code: "validation_error", message: SIGNUP_INVALID_MESSAGE });
      expect(r.body.error.details).toBeUndefined();
    }
  });

  it("an existing user keeps their password: no provider call, no password applied, same 201 shape", async () => {
    h.store.user = { id: "u-existing", isPlatformAdmin: false, blocked: false };
    const res = await complete();
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["entitlement", "membershipRole", "tenantId"]);
    expect(h.external.calls).toEqual([]);
    expect(h.external.passwordsSet).toEqual([]);
  });

  it("is 503 + Retry-After (never a 400) when the identity provider is unavailable", async () => {
    h.external.create = { kind: "unavailable" };
    const res = await complete();
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
  });

  it("is 429 with Retry-After over the per-IP bucket, 503 on a limiter outage, 403 for a foreign Origin", async () => {
    h.limiter.blocked.add("signup_complete_ip");
    const limited = await complete();
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    h.limiter.blocked.clear();

    h.limiter.broken = true;
    expect((await complete()).status).toBe(503);
    h.limiter.broken = false;

    const foreign = await complete().set("Origin", "https://evil.example");
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe("origin_rejected");
  });

  it("validates the body: a missing password and an unknown property are the generic 400", async () => {
    for (const body of [{ token: TOKEN }, { token: TOKEN, password: PASSWORD, extra: 1 }]) {
      const res = await complete(body);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe(SIGNUP_INVALID_MESSAGE);
    }
  });
});
