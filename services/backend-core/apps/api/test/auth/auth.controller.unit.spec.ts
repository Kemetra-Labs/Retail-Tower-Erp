/**
 * auth.controller.unit.spec.ts
 *
 * Docker-free unit coverage for AuthController.
 *
 * Strategy: minimal Nest app mounting only AuthController.
 * AuthGuard replaced with a scripted CanActivate double; AuthService and
 * RateLimiter replaced with hand-written fakes. No Testcontainers, no DB,
 * no Redis, no network.
 *
 * The Testcontainers integration spec (auth.controller.spec.ts) covers the
 * full stack including real sessions, real tokens, and email spy. This spec
 * pins the controller's own responsibilities:
 *   - rate-limit guard wiring (bucket names, short-circuit on per-account block)
 *   - Zod body validation (ZodValidationPipe; 400 validation_error envelope)
 *   - session cookie set/clear/refresh (httpOnly, sameSite=lax, no Secure in test)
 *   - guard chain wiring (AuthGuard on guarded endpoints)
 *   - principal kind check (session vs token on signOut / refresh / emailVerify)
 *   - service delegation (args forwarded correctly)
 *   - null userId guard in requestEmailVerification
 *
 * Endpoints:
 *   POST /api/v1/auth/signin                 → 200 { user, memberships }
 *   POST /api/v1/auth/signout                → 204 No Content
 *   POST /api/v1/auth/refresh                → 204 No Content
 *   POST /api/v1/auth/password-reset/request → 202 No Content
 *   POST /api/v1/auth/password-reset/confirm → 204 No Content
 *   POST /api/v1/auth/email/verify/request   → 202 No Content
 *   POST /api/v1/auth/email/verify/confirm   → 204 No Content
 */
import "reflect-metadata";

// RT-625 test 21: every line the controller and the public-auth limiter log is
// recorded, so a test can prove no email or IP reaches a log line.
const mockLogLines: unknown[][] = [];
jest.mock("@data-pulse-2/shared", () => {
  const actual = jest.requireActual("@data-pulse-2/shared");
  const record = (...args: unknown[]): void => {
    mockLogLines.push(args);
  };
  const logger = { trace: record, debug: record, info: record, warn: record, error: record, fatal: record };
  return { ...actual, createLogger: () => ({ ...logger, child: () => logger }) };
});

import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AuthGuard } from "../../src/auth/auth.guard";
import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import type { AuthedRequest } from "../../src/auth/auth.guard";
import type { Principal } from "../../src/auth/auth.guard";
import { AuthService } from "../../src/auth/auth.service";
import { RateLimiter } from "../../src/auth/rate-limit";
import type { RateLimitDecision, RedisLike, WindowHit } from "../../src/auth/rate-limit";
import { emailIpPairKey } from "../../src/auth/public-auth-keys";
import { fixedWindowHit, type FixedWindowEntry } from "../_helpers/fixed-window-hit";
import { AuthController } from "../../src/auth/auth.controller";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import type { SignInResult } from "../../src/auth/dto";
import type { RefreshResult } from "../../src/auth/auth.service";
import * as signInFailureMetrics from "../../src/observability/metrics/auth-signin-failure.metrics";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const USER_ID    = "0c000000-0000-7000-8000-000000000001";
const SESSION_ID = "0c000000-0000-7000-8000-000000000002";
const SESSION_CREDENTIAL = "cspnrg-cookie-value-not-the-row-id";
const TOKEN_ID   = "0c000000-0000-7000-8000-000000000003";
const TENANT_ID  = "0c000000-0000-7000-8000-000000000004";

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Fake AuthService
// ---------------------------------------------------------------------------

interface SignOutCall { sessionId: string }
interface RefreshCall { sessionId: string }
interface RequestPasswordResetCall { email: string }
interface ConfirmPasswordResetCall { rawToken: string; newPassword: string }
interface RequestEmailVerificationCall { userId: string }
interface ConfirmEmailVerificationCall { rawToken: string }

class FakeAuthService {
  lastSignInArgs:                   { email: string; password: string } | null = null;
  lastSignOutArgs:                  SignOutCall | null = null;
  lastRefreshArgs:                  RefreshCall | null = null;
  lastRequestPasswordResetArgs:     RequestPasswordResetCall | null = null;
  lastConfirmPasswordResetArgs:     ConfirmPasswordResetCall | null = null;
  lastRequestEmailVerificationArgs: RequestEmailVerificationCall | null = null;
  lastConfirmEmailVerificationArgs: ConfirmEmailVerificationCall | null = null;

  signInResult: SignInResult = {
    sessionId: SESSION_ID,
    sessionCredential: SESSION_CREDENTIAL,
    userId: USER_ID,
    absoluteExpiresAt: FUTURE,
    user: { id: USER_ID, email: "user@example.com", display_name: null, is_platform_admin: false },
    memberships: [],
  };
  refreshResult: RefreshResult | null = {
    sessionId: SESSION_ID,
    userId: USER_ID,
    absoluteExpiresAt: FUTURE,
  };

  async signIn(input: { email: string; password: string }): Promise<SignInResult> {
    this.lastSignInArgs = input;
    return this.signInResult;
  }

  async signOut(sessionId: string): Promise<void> {
    this.lastSignOutArgs = { sessionId };
  }

  async refresh(sessionId: string): Promise<RefreshResult | null> {
    this.lastRefreshArgs = { sessionId };
    return this.refreshResult;
  }

  async requestPasswordReset(input: { email: string }): Promise<void> {
    this.lastRequestPasswordResetArgs = input;
  }

  /** RT-625 D2: the address the service reports for a successful confirm. */
  confirmResetEmail: string | null = "user@example.com";

  async confirmPasswordReset(input: { rawToken: string; newPassword: string }): Promise<string | null> {
    this.lastConfirmPasswordResetArgs = input;
    return this.confirmResetEmail;
  }

  async requestEmailVerification(input: { userId: string }): Promise<void> {
    this.lastRequestEmailVerificationArgs = input;
  }

  async confirmEmailVerification(input: { rawToken: string }): Promise<void> {
    this.lastConfirmEmailVerificationArgs = input;
  }

  // RT-937 item 2
  lastChangePasswordArgs: unknown = null;
  changePasswordError: Error | null = null;

  async changePassword(input: unknown): Promise<void> {
    this.lastChangePasswordArgs = input;
    if (this.changePasswordError) throw this.changePasswordError;
  }
}

// ---------------------------------------------------------------------------
// Fake RateLimiter
// ---------------------------------------------------------------------------

class FakeRateLimiter {
  /** Buckets forced to block. Every bucket not listed here allows. */
  private blockedBuckets = new Set<string>();
  /** Ordered record of bucket names that check() was actually called with. */
  calledBuckets: string[] = [];
  /** `resetMs` reported by a blocked bucket (RT-623: drives `Retry-After`). */
  blockedResetMs = 60_000;

  /** RT-626: buckets whose check() rejects, as a limiter outage would. */
  private failingBuckets = new Set<string>();

  blockBucket(bucketName: string): void {
    this.blockedBuckets.add(bucketName);
  }

  failBucket(bucketName: string): void {
    this.failingBuckets.add(bucketName);
  }

  allowAll(): void {
    this.blockedBuckets.clear();
    this.failingBuckets.clear();
  }

  /** RT-625: every (bucket, identifier) check() was called with, in order. */
  checks: Array<[string, string]> = [];

  async check(
    bucketName: string,
    identifier: string,
    _policy: { limit: number; windowMs: number },
  ): Promise<RateLimitDecision> {
    this.calledBuckets.push(bucketName);
    this.checks.push([bucketName, identifier]);
    if (this.failingBuckets.has(bucketName)) throw new Error("redis down");
    const allowed = !this.blockedBuckets.has(bucketName);
    return {
      allowed,
      count: allowed ? 1 : 100,
      remaining: allowed ? 99 : 0,
      resetMs: allowed ? 60_000 : this.blockedResetMs,
    };
  }

  /** Ordered record of bucket names that release() was called with (RT-136). */
  releasedBuckets: string[] = [];

  async release(bucketName: string, _identifier: string): Promise<void> {
    this.releasedBuckets.push(bucketName);
  }

  /** RT-625 D2: every (bucket, identifier) clear() was called with. */
  cleared: Array<[string, string]> = [];

  async clear(bucketName: string, identifier: string): Promise<void> {
    this.cleared.push([bucketName, identifier]);
  }
}

// ---------------------------------------------------------------------------
// Scripted AuthGuard
// ---------------------------------------------------------------------------

class ScriptedAuthGuard implements CanActivate {
  mode: "ok" | "reject" = "ok";
  principal: Principal = { kind: "session", sessionId: SESSION_ID, userId: USER_ID };

  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "reject") throw new UnauthorizedException("Unauthorized");
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    req.principal = this.principal;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function expectErrorEnvelope(body: unknown, expectedCode: string): void {
  expect(body).toMatchObject({
    error: {
      code: expectedCode,
      message: expect.any(String),
      request_id: expect.any(String),
    },
  });
}

// ---------------------------------------------------------------------------
// Fixture — one app instance for all tests in this file
// ---------------------------------------------------------------------------

let app: INestApplication;
let svc: FakeAuthService;
let rl: FakeRateLimiter;
let guard: ScriptedAuthGuard;

beforeAll(async () => {
  svc   = new FakeAuthService();
  rl    = new FakeRateLimiter();
  guard = new ScriptedAuthGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      { provide: AuthService,   useValue: svc },
      { provide: RateLimiter,   useValue: rl  },
    ],
  })
    .overrideGuard(AuthGuard).useValue(guard)
    // RT-141: email/verify/request is DashboardAuthGuard-gated; the same
    // scripted double stands in (its scope rules are unit-tested separately).
    .overrideGuard(DashboardAuthGuard).useValue(guard)
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  guard.mode = "ok";
  guard.principal = { kind: "session", sessionId: SESSION_ID, userId: USER_ID };
  rl.allowAll();
  rl.calledBuckets = [];
  rl.releasedBuckets = [];
  rl.checks = [];
  rl.cleared = [];
  svc.confirmResetEmail = "user@example.com";

  svc.lastSignInArgs                   = null;
  svc.lastSignOutArgs                  = null;
  svc.lastRefreshArgs                  = null;
  svc.lastRequestPasswordResetArgs     = null;
  svc.lastConfirmPasswordResetArgs     = null;
  svc.lastRequestEmailVerificationArgs = null;
  svc.lastConfirmEmailVerificationArgs = null;
  svc.lastChangePasswordArgs           = null;
  svc.changePasswordError              = null;

  svc.signInResult = {
    sessionId: SESSION_ID,
    sessionCredential: SESSION_CREDENTIAL,
    userId: USER_ID,
    absoluteExpiresAt: FUTURE,
    user: { id: USER_ID, email: "user@example.com", display_name: null, is_platform_admin: false },
    memberships: [],
  };
  svc.refreshResult = {
    sessionId: SESSION_ID,
    userId: USER_ID,
    absoluteExpiresAt: FUTURE,
  };
});

function http() {
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// POST /api/v1/auth/signin
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/signin", () => {
  it("happy path: 200 with user body and the service's memberships (here none)", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "secret123" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: {
        id: USER_ID,
        email: "user@example.com",
        display_name: null,
        is_platform_admin: false,
      },
      memberships: [],
    });
  });

  it("sets session cookie with correct attributes", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "secret123" });

    const setCookie: string | string[] | undefined = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as string];
    const sessionCookie = cookies.find((c) => c.startsWith("dp2_session="));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).toMatch(/Path=\//i);
    // NODE_ENV=test → Secure flag must NOT be present
    expect(sessionCookie).not.toMatch(/;\s*Secure/i);
    // Cookie value is the CSPRNG credential, not the sessions row id.
    expect(sessionCookie).toContain(`dp2_session=${SESSION_CREDENTIAL}`);
    expect(sessionCookie).not.toContain(`dp2_session=${SESSION_ID}`);
  });

  it("forwards email and password to authService.signIn", async () => {
    await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "mypassword" });

    expect(svc.lastSignInArgs).not.toBeNull();
    expect(svc.lastSignInArgs!.email).toBe("user@example.com");
    expect(svc.lastSignInArgs!.password).toBe("mypassword");
  });

  // RT-430: login CSRF. A foreign Origin is refused before any rate-limit or
  // credential work; a missing Origin is admitted (no ambient credential).
  it("refuses a sign-in from a foreign Origin with 403 origin_rejected", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .set("Host", "api.test")
      .set("Origin", "http://sibling.api.test")
      .send({ email: "user@example.com", password: "secret123" });

    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "origin_rejected");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(svc.lastSignInArgs).toBeNull();
    expect(rl.calledBuckets).toEqual([]);
  });

  it("admits a sign-in from the API's own Origin", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .set("Host", "api.test")
      .set("Origin", "http://api.test")
      .send({ email: "user@example.com", password: "secret123" });

    expect(res.status).toBe(200);
  });

  it("admits a sign-in with no Origin", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "secret123" });

    expect(res.status).toBe(200);
    expect(svc.lastSignInArgs).not.toBeNull();
  });

  it("RT-625 test 3: checks the pair, then the account, then the IP bucket", async () => {
    await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "p" });

    expect(rl.calledBuckets).toEqual(["signin_pair", "signin_account", "signin_ip"]);
  });

  it("RT-625 test 3: a locked pair stops at [signin_pair] and gives nothing back", async () => {
    rl.blockBucket("signin_pair");
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "p" });

    expect(res.status).toBe(429);
    expectErrorEnvelope(res.body, "rate_limited");
    expect(rl.calledBuckets).toEqual(["signin_pair"]);
    expect(rl.releasedBuckets).toEqual([]);
    expect(svc.lastSignInArgs).toBeNull();
  });

  it("returns 429 when per-account bucket is exhausted — per-IP not checked", async () => {
    rl.blockBucket("signin_account");
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "p" });

    expect(res.status).toBe(429);
    expectErrorEnvelope(res.body, "rate_limited");
    // Per-IP must not have been called (short-circuit)
    expect(rl.calledBuckets).toEqual(["signin_pair", "signin_account"]);
    expect(svc.lastSignInArgs).toBeNull();
  });

  it("returns 429 when per-IP bucket is exhausted — service not called", async () => {
    rl.blockBucket("signin_ip");
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "p" });

    expect(res.status).toBe(429);
    expectErrorEnvelope(res.body, "rate_limited");
    expect(svc.lastSignInArgs).toBeNull();
  });

  it("returns 401 when authService.signIn throws UnauthorizedException", async () => {
    svc.signIn = async () => { throw new UnauthorizedException("Unauthorized"); };

    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "wrong" });

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    svc.signIn = async (input) => { svc.lastSignInArgs = input; return svc.signInResult; };
  });

  // RT-136 / RT-625: only a failed authentication keeps its failure-only hits.
  it("RT-625 test 6: a success releases the pair and account hits; signin_ip is never released", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "secret123" });

    expect(res.status).toBe(200);
    expect(rl.releasedBuckets).toEqual(["signin_pair", "signin_account"]);
  });

  it("RT-625 test 7: a 401 keeps both failure-only hits", async () => {
    svc.signIn = async () => { throw new UnauthorizedException("Invalid credentials"); };

    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "wrong" });

    expect(res.status).toBe(401);
    expect(rl.releasedBuckets).toEqual([]);
    svc.signIn = async (input) => { svc.lastSignInArgs = input; return svc.signInResult; };
  });

  it("RT-625 test 8: a signin_ip refusal releases both the pair and the account hits", async () => {
    rl.blockBucket("signin_ip");
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "p" });

    expect(res.status).toBe(429);
    expect(rl.releasedBuckets).toEqual(["signin_pair", "signin_account"]);
  });

  it("RT-625 test 8: a 500 (non-authentication failure) releases both", async () => {
    svc.signIn = async () => { throw new Error("database unavailable"); };

    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "secret123" });

    expect(res.status).toBe(500);
    expect(rl.releasedBuckets).toEqual(["signin_pair", "signin_account"]);
    svc.signIn = async (input) => { svc.lastSignInArgs = input; return svc.signInResult; };
  });

  it("RT-625 test 8: a provider 503 releases both", async () => {
    svc.signIn = async () => { throw new ServiceUnavailableException("identity provider unavailable"); };

    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "secret123" });

    expect(res.status).toBe(503);
    expect(rl.releasedBuckets).toEqual(["signin_pair", "signin_account"]);
    svc.signIn = async (input) => { svc.lastSignInArgs = input; return svc.signInResult; };
  });

  it("RT-625 test 8: an account refusal releases the pair hit only", async () => {
    rl.blockBucket("signin_account");
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "p" });

    expect(res.status).toBe(429);
    expect(rl.releasedBuckets).toEqual(["signin_pair"]);
  });

  it.each([
    ["signin_pair", []],
    ["signin_account", ["signin_pair"]],
    ["signin_ip", ["signin_pair", "signin_account"]],
  ])("RT-625 test 8: a limiter 503 on %s releases %p", async (bucket, released) => {
    rl.failBucket(bucket);
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "p" });

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(rl.releasedBuckets).toEqual(released);
    expect(svc.lastSignInArgs).toBeNull();
  });

  it("a failed release does not turn a successful sign-in into an error", async () => {
    rl.release = async () => { throw new Error("redis down"); };

    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password: "secret123" });

    expect(res.status).toBe(200);
    rl.release = FakeRateLimiter.prototype.release;
  });

  it("returns 400 (validation_error) for missing email — rate limiter not called", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ password: "secret123" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(rl.calledBuckets).toHaveLength(0);
    expect(svc.lastSignInArgs).toBeNull();
  });

  it("returns 400 (validation_error) for invalid email format", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "not-an-email", password: "secret123" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastSignInArgs).toBeNull();
  });

  it("returns 400 (validation_error) for missing password", async () => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastSignInArgs).toBeNull();
  });

  // RT-153: the maximum is 1024 Unicode code points, not UTF-16 units.
  it("RT-153: accepts a 1024-code-point non-BMP password (2048 UTF-16 units) and forwards it unchanged", async () => {
    const password = "\u{1F600}".repeat(1024);
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password });

    expect(res.status).toBe(200);
    expect(svc.lastSignInArgs!.password).toBe(password);
  });

  it.each([
    ["1025 ASCII", "a".repeat(1025)],
    ["1025 non-BMP emoji", "\u{1F600}".repeat(1025)],
  ])("RT-153: returns 400 (validation_error) for %s — rate limiter and service not called", async (_label, password) => {
    const res = await http()
      .post("/api/v1/auth/signin")
      .send({ email: "user@example.com", password });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(rl.calledBuckets).toHaveLength(0);
    expect(svc.lastSignInArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/signout
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/signout", () => {
  it("happy path (session principal): 204 and cookie cleared", async () => {
    const res = await http().post("/api/v1/auth/signout");

    expect(res.status).toBe(204);
    const setCookie: string | string[] | undefined = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as string];
    const cleared = cookies.find((c) => c.startsWith("dp2_session="));
    expect(cleared).toBeDefined();
    // Express clears cookie by setting Expires in the past or Max-Age=0
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });

  it("forwards sessionId to authService.signOut", async () => {
    await http().post("/api/v1/auth/signout");

    expect(svc.lastSignOutArgs).not.toBeNull();
    expect(svc.lastSignOutArgs!.sessionId).toBe(SESSION_ID);
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    guard.mode = "reject";
    const res = await http().post("/api/v1/auth/signout");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastSignOutArgs).toBeNull();
  });

  it("returns 401 when principal is kind='token' — service not called", async () => {
    guard.principal = { kind: "token", tokenId: TOKEN_ID, tenantId: TENANT_ID, userId: USER_ID, scope: "dashboard_api" as const } as Principal;
    const res = await http().post("/api/v1/auth/signout");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastSignOutArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/refresh
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/refresh", () => {
  it("happy path: 204 and cookie re-issued", async () => {
    const res = await http()
      .post("/api/v1/auth/refresh")
      .set("Cookie", [`dp2_session=${SESSION_CREDENTIAL}`]);

    expect(res.status).toBe(204);
    const setCookie: string | string[] | undefined = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    const reissued = cookies.find((c) => c.startsWith("dp2_session="));
    expect(reissued).toBeDefined();
    expect(reissued).toContain(`dp2_session=${SESSION_CREDENTIAL}`);
  });

  it("forwards sessionId to authService.refresh", async () => {
    await http().post("/api/v1/auth/refresh");

    expect(svc.lastRefreshArgs).not.toBeNull();
    expect(svc.lastRefreshArgs!.sessionId).toBe(SESSION_ID);
  });

  it("returns 401 when authService.refresh returns null", async () => {
    svc.refreshResult = null;
    const res = await http().post("/api/v1/auth/refresh");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 401 when AuthGuard rejects", async () => {
    guard.mode = "reject";
    const res = await http().post("/api/v1/auth/refresh");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastRefreshArgs).toBeNull();
  });

  it("returns 401 when principal is kind='token'", async () => {
    guard.principal = { kind: "token", tokenId: TOKEN_ID, tenantId: TENANT_ID, userId: USER_ID, scope: "dashboard_api" as const } as Principal;
    const res = await http().post("/api/v1/auth/refresh");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastRefreshArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/password-reset/request
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/password-reset/request", () => {
  it("happy path: 202 with empty body", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: "user@example.com" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
  });

  it("forwards email to authService.requestPasswordReset", async () => {
    await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: "user@example.com" });

    expect(svc.lastRequestPasswordResetArgs).not.toBeNull();
    expect(svc.lastRequestPasswordResetArgs!.email).toBe("user@example.com");
  });

  it("returns 429 when per-IP rate limit blocks — service not called", async () => {
    rl.blockBucket("pwreset_ip");
    const res = await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: "user@example.com" });

    expect(res.status).toBe(429);
    expectErrorEnvelope(res.body, "rate_limited");
    expect(svc.lastRequestPasswordResetArgs).toBeNull();
  });

  it("returns 400 (validation_error) for missing email", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/request")
      .send({});

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(rl.calledBuckets).toHaveLength(0);
  });

  it("returns 400 (validation_error) for invalid email format", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: "not-an-email" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/password-reset/confirm
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/password-reset/confirm", () => {
  it("happy path: 204 with empty body", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "some-token", new_password: "newpassword12345" });

    expect(res.status).toBe(204);
  });

  it("forwards token and new_password to authService.confirmPasswordReset", async () => {
    await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "tok123", new_password: "newpassword12345" });

    expect(svc.lastConfirmPasswordResetArgs).not.toBeNull();
    expect(svc.lastConfirmPasswordResetArgs!.rawToken).toBe("tok123");
    expect(svc.lastConfirmPasswordResetArgs!.newPassword).toBe("newpassword12345");
  });

  it("returns 400 (validation_error) when service throws BadRequestException", async () => {
    svc.confirmPasswordReset = async () => {
      throw new BadRequestException("Invalid or expired token");
    };

    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "expired", new_password: "newpassword12345" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    svc.confirmPasswordReset = FakeAuthService.prototype.confirmPasswordReset;
  });

  it("returns 400 (validation_error) for too-short new_password (<12 chars)", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "tok", new_password: "short" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastConfirmPasswordResetArgs).toBeNull();
  });

  it("returns 400 (validation_error) for missing token field", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ new_password: "newpassword12345" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastConfirmPasswordResetArgs).toBeNull();
  });

  it("RT-153: accepts a 1024-code-point non-BMP new_password and forwards it unchanged", async () => {
    const newPassword = "\u{1F600}".repeat(1024);
    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "tok", new_password: newPassword });

    expect(res.status).toBe(204);
    expect(svc.lastConfirmPasswordResetArgs!.newPassword).toBe(newPassword);
  });

  it.each([
    ["1025 ASCII", "a".repeat(1025)],
    ["1025 non-BMP emoji", "\u{1F600}".repeat(1025)],
  ])("RT-153: returns 400 (validation_error) for a %s new_password — service not called", async (_label, newPassword) => {
    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "tok", new_password: newPassword });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastConfirmPasswordResetArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/email/verify/request
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/email/verify/request", () => {
  it("happy path (session principal with userId): 202", async () => {
    const res = await http().post("/api/v1/auth/email/verify/request");

    expect(res.status).toBe(202);
    expect(svc.lastRequestEmailVerificationArgs).not.toBeNull();
    expect(svc.lastRequestEmailVerificationArgs!.userId).toBe(USER_ID);
  });

  it("happy path (token principal with non-null userId): 202", async () => {
    guard.principal = { kind: "token", tokenId: TOKEN_ID, tenantId: TENANT_ID, userId: USER_ID, scope: "dashboard_api" as const } as Principal;
    const res = await http().post("/api/v1/auth/email/verify/request");

    expect(res.status).toBe(202);
    expect(svc.lastRequestEmailVerificationArgs).not.toBeNull();
    expect(svc.lastRequestEmailVerificationArgs!.userId).toBe(USER_ID);
  });

  it("returns 400 when token principal has null userId", async () => {
    guard.principal = { kind: "token", tokenId: TOKEN_ID, tenantId: TENANT_ID, userId: null, scope: "dashboard_api" as const } as Principal;
    const res = await http().post("/api/v1/auth/email/verify/request");

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastRequestEmailVerificationArgs).toBeNull();
  });

  it("returns 401 when AuthGuard rejects", async () => {
    guard.mode = "reject";
    const res = await http().post("/api/v1/auth/email/verify/request");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastRequestEmailVerificationArgs).toBeNull();
  });

  it("RT-141: is gated by DashboardAuthGuard (human authority only)", () => {
    const guards = Reflect.getMetadata(
      "__guards__",
      AuthController.prototype.requestEmailVerification,
    ) as unknown[];
    expect(guards).toEqual([DashboardAuthGuard]);
  });

  it("RT-141: checks the per-user bucket before sending", async () => {
    rl.calledBuckets = [];
    const res = await http().post("/api/v1/auth/email/verify/request");
    expect(res.status).toBe(202);
    expect(rl.calledBuckets).toEqual(["email_verify_user"]);
    expect(svc.lastRequestEmailVerificationArgs!.userId).toBe(USER_ID);
  });

  it("RT-141: over the per-user limit → still 202, but nothing is sent", async () => {
    rl.blockBucket("email_verify_user");
    const res = await http().post("/api/v1/auth/email/verify/request");
    expect(res.status).toBe(202);
    expect(svc.lastRequestEmailVerificationArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/email/verify/confirm
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/email/verify/confirm", () => {
  it("happy path: 204 with empty body", async () => {
    const res = await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({ token: "verify-token" });

    expect(res.status).toBe(204);
  });

  it("forwards token to authService.confirmEmailVerification", async () => {
    await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({ token: "verify-token" });

    expect(svc.lastConfirmEmailVerificationArgs).not.toBeNull();
    expect(svc.lastConfirmEmailVerificationArgs!.rawToken).toBe("verify-token");
  });

  it("returns 400 (validation_error) when service throws BadRequestException", async () => {
    svc.confirmEmailVerification = async () => {
      throw new BadRequestException("Invalid or expired token");
    };

    const res = await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({ token: "expired" });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    svc.confirmEmailVerification = async (input) => { svc.lastConfirmEmailVerificationArgs = input; };
  });

  it("returns 400 (validation_error) for missing token field", async () => {
    const res = await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({});

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastConfirmEmailVerificationArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B5.0 — requestEmailVerification !principal defensive branch
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/email/verify/request — !principal defensive branch", () => {
  it("B5.0: guard succeeds but principal is undefined → 401 (defensive guard)", async () => {
    // ScriptedAuthGuard sets req.principal = this.principal. Setting
    // principal to undefined makes canActivate succeed while leaving
    // req.principal unset, exercising the !principal branch in the handler.
    guard.principal = undefined as unknown as Principal;

    const res = await http().post("/api/v1/auth/email/verify/request");

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastRequestEmailVerificationArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RT-623 — Retry-After on every public-auth 429
// ---------------------------------------------------------------------------

describe("public-auth 429 carries Retry-After (RT-623)", () => {
  const signIn = (): Promise<request.Response> =>
    http().post("/api/v1/auth/signin").send({ email: "user@example.com", password: "p" });

  afterEach(() => {
    rl.blockedResetMs = 60_000;
  });

  it("signin_account 429: Retry-After is the bucket's seconds until reset", async () => {
    rl.blockBucket("signin_account");
    rl.blockedResetMs = 42_000;
    const res = await signIn();

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("42");
    expectErrorEnvelope(res.body, "rate_limited");
  });

  it("signin_ip 429 carries Retry-After", async () => {
    rl.blockBucket("signin_ip");
    rl.blockedResetMs = 90_000;
    const res = await signIn();

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("90");
  });

  it("password-reset/request 429 carries Retry-After", async () => {
    rl.blockBucket("pwreset_ip");
    rl.blockedResetMs = 30_000;
    const res = await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: "user@example.com" });

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("30");
  });

  it("password-reset/confirm 429 carries Retry-After", async () => {
    rl.blockBucket("pwreset_confirm_ip");
    rl.blockedResetMs = 120_000;
    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "tok", new_password: "newpassword12345" });

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("120");
  });

  it("rounds a partial second up, so a client never retries too early", async () => {
    rl.blockBucket("signin_account");
    rl.blockedResetMs = 1_500;

    expect((await signIn()).headers["retry-after"]).toBe("2");
  });

  it.each([
    ["an already-elapsed window (0 ms)", 0, "1"],
    ["a stub client that keeps no TTL (-1)", -1, "1"],
    ["a sub-second remainder", 200, "1"],
    ["a window longer than the cap", 86_400_000, "3600"],
  ])("clamps to [1, 3600]: %s", async (_label, resetMs, expected) => {
    rl.blockBucket("signin_account");
    rl.blockedResetMs = resetMs;

    expect((await signIn()).headers["retry-after"]).toBe(expected);
  });

  it("an allowed request carries no Retry-After", async () => {
    const res = await signIn();

    expect(res.status).toBe(200);
    expect(res.headers["retry-after"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/password/change (RT-937 item 2)
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/password/change", () => {
  const body = { current_password: "Old-Password-1!", new_password: "New-Password-2!" };

  it("happy path: 204, forwards the session's user and session id plus both passwords", async () => {
    const res = await http().post("/api/v1/auth/password/change").send(body);

    expect(res.status).toBe(204);
    expect(svc.lastChangePasswordArgs).toEqual({
      userId: USER_ID,
      sessionId: SESSION_ID,
      currentPassword: "Old-Password-1!",
      newPassword: "New-Password-2!",
      // The request-id interceptor is not mounted in this unit module.
      requestId: null,
    });
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    guard.mode = "reject";
    const res = await http().post("/api/v1/auth/password/change").send(body);

    expect(res.status).toBe(401);
    expect(svc.lastChangePasswordArgs).toBeNull();
  });

  it("returns 401 for a bearer-token principal: cookie session only", async () => {
    guard.principal = { kind: "token", tokenId: TOKEN_ID, tenantId: TENANT_ID, userId: USER_ID, scope: "dashboard_api" as const } as Principal;
    const res = await http().post("/api/v1/auth/password/change").send(body);

    expect(res.status).toBe(401);
    expect(svc.lastChangePasswordArgs).toBeNull();
  });

  it.each([
    ["missing current_password", { new_password: "New-Password-2!" }],
    ["missing new_password", { current_password: "Old-Password-1!" }],
    ["empty new_password", { current_password: "Old-Password-1!", new_password: "" }],
    ["unknown field", { ...body, extra: "x" }],
  ])("returns 400 validation_error for %s — service not called", async (_name, payload) => {
    const res = await http().post("/api/v1/auth/password/change").send(payload);

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastChangePasswordArgs).toBeNull();
  });

  it("rate-limits per user BEFORE any provider work: 429 with Retry-After", async () => {
    rl.blockBucket("pwchange_user");
    const res = await http().post("/api/v1/auth/password/change").send(body);

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(rl.calledBuckets).toEqual(["pwchange_user"]);
    expect(svc.lastChangePasswordArgs).toBeNull();
  });

  it("releases the attempt on success, so only failed attempts count", async () => {
    await http().post("/api/v1/auth/password/change").send(body);
    expect(rl.releasedBuckets).toEqual(["pwchange_user"]);
  });

  it("keeps the attempt counted when the refusal is the generic 400 (a failed guess)", async () => {
    svc.changePasswordError = new BadRequestException("The password could not be changed");
    const res = await http().post("/api/v1/auth/password/change").send(body);

    expect(res.status).toBe(400);
    expect(rl.releasedBuckets).toEqual([]);
  });

  it("releases the attempt when the failure is not a failed guess (409 / 503)", async () => {
    svc.changePasswordError = new ServiceUnavailableException("Identity provider unavailable");
    const res = await http().post("/api/v1/auth/password/change").send(body);

    expect(res.status).toBe(503);
    expect(rl.releasedBuckets).toEqual(["pwchange_user"]);
  });

  it("never echoes either password in an error response", async () => {
    svc.changePasswordError = new BadRequestException("The password could not be changed");
    const res = await http().post("/api/v1/auth/password/change").send(body);

    expect(JSON.stringify(res.body)).not.toContain("Old-Password-1!");
    expect(JSON.stringify(res.body)).not.toContain("New-Password-2!");
  });
});

// ---------------------------------------------------------------------------
// RT-626 (RT-574 issue 5d) — new public-auth buckets and the failed-sign-in signal
// ---------------------------------------------------------------------------

describe("RT-626: password-reset/request per-email budget", () => {
  const send = (): Promise<request.Response> =>
    http().post("/api/v1/auth/password-reset/request").send({ email: "user@example.com" });

  it("RT-625: checks the per-IP bucket, then the (email, IP) pair, then the per-email bucket, then sends", async () => {
    const res = await send();

    expect(res.status).toBe(202);
    expect(rl.calledBuckets).toEqual(["pwreset_ip", "pwreset_pair", "pwreset_email"]);
    expect(rl.releasedBuckets).toEqual([]);
    expect(svc.lastRequestPasswordResetArgs).toEqual({ email: "user@example.com" });
  });

  it("RT-625 test 24: over the per-email limit: still 202 with no body and no Retry-After, nothing sent, the pair hit given back", async () => {
    rl.blockBucket("pwreset_email");
    const res = await send();

    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(svc.lastRequestPasswordResetArgs).toBeNull();
    expect(rl.releasedBuckets).toEqual(["pwreset_pair"]);
  });

  it("RT-625 test 24: over the pair limit: 202, nothing sent, and the per-email budget is never touched", async () => {
    rl.blockBucket("pwreset_pair");
    const res = await send();

    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(rl.calledBuckets).toEqual(["pwreset_ip", "pwreset_pair"]);
    expect(svc.lastRequestPasswordResetArgs).toBeNull();
  });

  it("RT-625 test 24: a pair limiter outage still answers 202 and sends nothing", async () => {
    rl.failBucket("pwreset_pair");
    const res = await send();

    expect(res.status).toBe(202);
    expect(rl.calledBuckets).toEqual(["pwreset_ip", "pwreset_pair"]);
    expect(svc.lastRequestPasswordResetArgs).toBeNull();
  });

  it("a per-email limiter outage still answers 202 and sends nothing", async () => {
    rl.failBucket("pwreset_email");
    const res = await send();

    expect(res.status).toBe(202);
    expect(svc.lastRequestPasswordResetArgs).toBeNull();
  });

  it("a per-IP refusal is still a 429 and never reaches the per-email bucket", async () => {
    rl.blockBucket("pwreset_ip");
    const res = await send();

    expect(res.status).toBe(429);
    expect(rl.calledBuckets).toEqual(["pwreset_ip"]);
  });
});

describe("RT-626: email/verify/confirm per-IP limit", () => {
  const send = (): Promise<request.Response> =>
    http().post("/api/v1/auth/email/verify/confirm").send({ token: "verify-token" });

  afterEach(() => {
    rl.blockedResetMs = 60_000;
  });

  it("checks the per-IP bucket before confirming", async () => {
    const res = await send();

    expect(res.status).toBe(204);
    expect(rl.calledBuckets).toEqual(["email_verify_confirm_ip"]);
  });

  it("over the limit: 429 rate_limited with Retry-After, service not called", async () => {
    rl.blockBucket("email_verify_confirm_ip");
    rl.blockedResetMs = 600_000;
    const res = await send();

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("600");
    expectErrorEnvelope(res.body, "rate_limited");
    expect(svc.lastConfirmEmailVerificationArgs).toBeNull();
  });

  it("a limiter outage fails closed: 503 service_unavailable with Retry-After: 30", async () => {
    rl.failBucket("email_verify_confirm_ip");
    const res = await send();

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expectErrorEnvelope(res.body, "service_unavailable");
    expect(svc.lastConfirmEmailVerificationArgs).toBeNull();
  });

  it("validates the body before spending the budget", async () => {
    const res = await http().post("/api/v1/auth/email/verify/confirm").send({});

    expect(res.status).toBe(400);
    expect(rl.calledBuckets).toEqual([]);
  });
});

describe("RT-626: auth_signin_failure_total emission", () => {
  const signIn = (): Promise<request.Response> =>
    http().post("/api/v1/auth/signin").send({ email: "user@example.com", password: "p" });

  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(signInFailureMetrics, "recordSignInFailure");
  });

  afterEach(() => {
    svc.signIn = async (input) => { svc.lastSignInArgs = input; return svc.signInResult; };
  });

  it("a credential failure (401) counts once as invalid_credentials", async () => {
    svc.signIn = async () => { throw new UnauthorizedException("Invalid credentials"); };

    expect((await signIn()).status).toBe(401);
    expect(spy.mock.calls).toEqual([[{ cause: "invalid_credentials" }]]);
  });

  it.each(["signin_pair", "signin_account", "signin_ip"])("RT-625 test 21: a %s 429 counts once as rate_limited", async (bucket) => {
    rl.blockBucket(bucket);

    expect((await signIn()).status).toBe(429);
    expect(spy.mock.calls).toEqual([[{ cause: "rate_limited" }]]);
  });

  it("a successful sign-in counts nothing", async () => {
    expect((await signIn()).status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a limiter outage (503) and a non-authentication error (500) count nothing", async () => {
    rl.failBucket("signin_account");
    expect((await signIn()).status).toBe(503);
    rl.allowAll();

    svc.signIn = async () => { throw new Error("database unavailable"); };
    expect((await signIn()).status).toBe(500);

    expect(spy).not.toHaveBeenCalled();
  });

  it("a 429 on a non-sign-in bucket counts nothing", async () => {
    rl.blockBucket("email_verify_confirm_ip");
    await http().post("/api/v1/auth/email/verify/confirm").send({ token: "t" });

    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RT-625 D2 / P4 — a successful reset confirm clears the sign-in lockout
// ---------------------------------------------------------------------------

describe("RT-625 D2: password-reset/confirm clears the sign-in lockout", () => {
  const confirm = (): Promise<request.Response> =>
    http().post("/api/v1/auth/password-reset/confirm").send({ token: "tok", new_password: "newpassword12345" });

  beforeEach(() => {
    svc.confirmPasswordReset = FakeAuthService.prototype.confirmPasswordReset;
  });

  afterEach(() => {
    svc.confirmPasswordReset = FakeAuthService.prototype.confirmPasswordReset;
  });

  it("test 16 (unit): a successful confirm clears the account bucket and the confirming IP pair, keyed like sign-in", async () => {
    svc.confirmResetEmail = "  User@Example.COM ";
    expect((await confirm()).status).toBe(204);
    await http().post("/api/v1/auth/signin").send({ email: "user@example.com", password: "p" });

    const signInKeys = rl.checks.filter(([bucket]) => bucket === "signin_pair" || bucket === "signin_account");
    expect(rl.cleared).toEqual(expect.arrayContaining(signInKeys));
    expect(rl.cleared).toHaveLength(2);
  });

  it("test 17 (unit): a failed or expired confirm clears nothing", async () => {
    svc.confirmPasswordReset = async () => {
      throw new BadRequestException("Invalid or expired token");
    };
    expect((await confirm()).status).toBe(400);
    expect(rl.cleared).toEqual([]);
  });

  it("test 17 (unit): a confirm that changed no live user clears nothing", async () => {
    svc.confirmResetEmail = null;
    expect((await confirm()).status).toBe(204);
    expect(rl.cleared).toEqual([]);
  });

  it("a failing clear does not turn the 204 into an error", async () => {
    rl.clear = async () => {
      throw new Error("redis down");
    };
    expect((await confirm()).status).toBe(204);
    rl.clear = FakeRateLimiter.prototype.clear;
  });
});

// ---------------------------------------------------------------------------
// RT-625 test 21 — no log line holds an email or an IP
// ---------------------------------------------------------------------------

describe("RT-625 test 21: sign-in and reset refusals log no email or IP", () => {
  const EMAIL = "pii-probe@example.com";
  const IP = "198.51.100.77";

  it.each(["signin_pair", "signin_account", "signin_ip"])("a %s 429 and outage 503 log the bucket only", async (bucket) => {
    mockLogLines.length = 0;
    rl.blockBucket(bucket);
    await http().post("/api/v1/auth/signin").set("X-Forwarded-For", IP).send({ email: EMAIL, password: "p" });
    rl.allowAll();
    rl.failBucket(bucket);
    await http().post("/api/v1/auth/signin").set("X-Forwarded-For", IP).send({ email: EMAIL, password: "p" });
    rl.failBucket("pwreset_pair");
    await http().post("/api/v1/auth/password-reset/request").set("X-Forwarded-For", IP).send({ email: EMAIL });

    expect(mockLogLines.length).toBeGreaterThan(0);
    const text = JSON.stringify(mockLogLines);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(IP);
    expect(text).not.toContain("127.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// RT-625 — real counters: the real RateLimiter over an in-memory Redis twin,
// behind one trusted proxy hop (TRUST_PROXY=1), so X-Forwarded-For sets the
// client IP. Tests 1, 2, 4, 5, 12, 13, 16, 17, 19, 22, 23.
// ---------------------------------------------------------------------------

class MemoryRedis implements RedisLike {
  readonly store = new Map<string, FixedWindowEntry>();
  now = 1_000_000;

  async incrWindow(key: string, ttlMs: number): Promise<WindowHit> {
    return fixedWindowHit(this.store, key, ttlMs, this.now);
  }
  async pttl(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry) return -2;
    return entry.expiresAt === null ? -1 : entry.expiresAt - this.now;
  }
  async decr(key: string): Promise<number> {
    const entry = this.live(key) ?? { value: 0, expiresAt: null };
    this.store.set(key, entry);
    entry.value -= 1;
    return entry.value;
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
  count(key: string): number {
    return this.live(key)?.value ?? 0;
  }
  private live(key: string): FixedWindowEntry | undefined {
    const entry = this.store.get(key);
    return entry && (entry.expiresAt === null || this.now < entry.expiresAt) ? entry : undefined;
  }
}

describe("RT-625 real counters behind one trusted proxy hop", () => {
  const E = "owner@example.com";
  const RIGHT = "right-password";
  const X = "203.0.113.10";
  const Y = "198.51.100.20";
  const FIFTEEN_MINUTES = 15 * 60 * 1000;

  let realApp: INestApplication;
  let redis: MemoryRedis;
  const auth = new FakeAuthService();
  const sentResets: string[] = [];

  beforeAll(async () => {
    redis = new MemoryRedis();
    auth.signIn = async (input) => {
      if (input.password !== RIGHT) throw new UnauthorizedException("Invalid credentials");
      return auth.signInResult;
    };
    auth.requestPasswordReset = async (input) => {
      sentResets.push(input.email);
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: RateLimiter, useValue: new RateLimiter(redis) },
      ],
    })
      .overrideGuard(AuthGuard).useValue(new ScriptedAuthGuard())
      .overrideGuard(DashboardAuthGuard).useValue(new ScriptedAuthGuard())
      .compile();
    realApp = moduleRef.createNestApplication({ bufferLogs: true });
    (realApp.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }).set("trust proxy", 1);
    realApp.useGlobalPipes(new ZodValidationPipe());
    realApp.useGlobalFilters(new GlobalExceptionFilter());
    await realApp.init();
  });

  afterAll(async () => {
    if (realApp) await realApp.close();
  });

  beforeEach(() => {
    redis.store.clear();
    sentResets.length = 0;
    auth.confirmResetEmail = E;
  });

  const signIn = (from: string, password: string, email = E): Promise<request.Response> =>
    request(realApp.getHttpServer()).post("/api/v1/auth/signin").set("X-Forwarded-For", from).send({ email, password });

  const resetRequest = (from: string, email = E): Promise<request.Response> =>
    request(realApp.getHttpServer()).post("/api/v1/auth/password-reset/request").set("X-Forwarded-For", from).send({ email });

  async function fail(from: string, times: number, email = E): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 0; i < times; i++) statuses.push((await signIn(from, "wrong", email)).status);
    return statuses;
  }

  const accountCount = (email = E): number => redis.count(`rl:signin_account:${email}`);

  it("test 1: five failures from X lock X; a correct sign-in for E from Y still succeeds", async () => {
    expect(await fail(X, 5)).toEqual([401, 401, 401, 401, 401]);
    expect((await signIn(X, RIGHT)).status).toBe(429);
    expect((await signIn(Y, RIGHT)).status).toBe(200);
  });

  it("test 2: twenty more requests from a locked X leave the account count unchanged; Y still signs in", async () => {
    await fail(X, 5);
    const before = accountCount();
    expect(before).toBe(5);
    const statuses = await fail(X, 20);
    expect(new Set(statuses)).toEqual(new Set([429]));
    expect(accountCount()).toBe(before);
    expect((await signIn(Y, RIGHT)).status).toBe(200);
  });

  it("test 4: four IPs x five failures lock E everywhere, a fifth IP with the correct password included (accepted risk)", async () => {
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"]) {
      expect(await fail(ip, 5)).toEqual([401, 401, 401, 401, 401]);
    }
    expect(accountCount()).toBe(20);
    expect((await signIn("192.0.2.5", RIGHT)).status).toBe(429);
  });

  it("test 5: the pair window is fixed: over-limit hits do not extend it, and a correct sign-in succeeds after it", async () => {
    // Open the account window 5 minutes before X's pair window, so the two
    // windows end apart and the test proves the pair window on its own.
    await fail(Y, 1);
    redis.now += 5 * 60_000;
    await fail(X, 5);
    redis.now += FIFTEEN_MINUTES - 5 * 60_000 + 1; // the account window has ended; X's pair has not
    expect((await signIn(X, RIGHT)).status).toBe(429);
    redis.now += 4 * 60_000;
    expect((await signIn(X, RIGHT)).status).toBe(429);
    redis.now += 60_000; // X's pair window ends 15 minutes after its first hit, not later
    expect((await signIn(X, RIGHT)).status).toBe(200);
  });

  it("test 12: addresses in one IPv6 /64 share the pair; another /64 does not", async () => {
    await fail("2001:db8:1:2::1", 5);
    expect((await signIn("2001:db8:1:2:ffff:ffff:ffff:ffff", RIGHT)).status).toBe(429);
    expect((await signIn("2001:db8:1:3::1", RIGHT)).status).toBe(200);
  });

  it("test 12: addresses in one IPv6 /64 share one signin_ip budget", async () => {
    for (let i = 1; i <= 30; i++) {
      expect((await signIn(`2001:db8:9:9::${i.toString(16)}`, RIGHT, `user${i}@example.com`)).status).toBe(200);
    }
    expect((await signIn("2001:db8:9:9::ffff", RIGHT, "fresh@example.com")).status).toBe(429);
    expect((await signIn("2001:db8:9:a::1", RIGHT, "fresh@example.com")).status).toBe(200);
  });

  it("test 13: an IPv4-mapped address and its IPv4 form share the pair", async () => {
    await fail("::ffff:203.0.113.5", 5);
    expect((await signIn("203.0.113.5", RIGHT)).status).toBe(429);
  });

  it("test 14: E in another case and padded shares the pair and the account bucket", async () => {
    await fail(X, 5, "  OWNER@Example.com ");
    expect((await signIn(X, RIGHT)).status).toBe(429);
    expect(accountCount()).toBe(5);
  });

  it("test 19: a client-supplied extra X-Forwarded-For hop does not change the pair key", async () => {
    await fail(X, 5);
    const spoofed = await request(realApp.getHttpServer())
      .post("/api/v1/auth/signin")
      .set("X-Forwarded-For", `192.0.2.99, ${X}`)
      .send({ email: E, password: RIGHT });
    expect(spoofed.status).toBe(429);
  });

  it("test 16: with the account at 20 and the pair for Y at 5, a successful confirm from Y clears both", async () => {
    await fail(Y, 5);
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) await fail(ip, 5);
    expect(accountCount()).toBe(20);
    expect((await signIn(Y, RIGHT)).status).toBe(429);

    const confirm = await request(realApp.getHttpServer())
      .post("/api/v1/auth/password-reset/confirm")
      .set("X-Forwarded-For", Y)
      .send({ token: "tok", new_password: "newpassword12345" });
    expect(confirm.status).toBe(204);
    expect(accountCount()).toBe(0);
    expect((await signIn(Y, RIGHT)).status).toBe(200);
    // Another IP pair is not cleared (it expires with its own window).
    expect((await signIn("192.0.2.1", RIGHT)).status).toBe(429);
  });

  it("test 17: a failed or expired confirm clears nothing", async () => {
    await fail(Y, 5);
    auth.confirmPasswordReset = async () => {
      throw new BadRequestException("Invalid or expired token");
    };
    let confirm: request.Response;
    try {
      confirm = await request(realApp.getHttpServer())
        .post("/api/v1/auth/password-reset/confirm")
        .set("X-Forwarded-For", Y)
        .send({ token: "expired", new_password: "newpassword12345" });
    } finally {
      auth.confirmPasswordReset = FakeAuthService.prototype.confirmPasswordReset;
    }
    expect(confirm.status).toBe(400);
    expect(accountCount()).toBe(5);
    expect((await signIn(Y, RIGHT)).status).toBe(429);
  });

  it("test 22: five reset requests for E from X stop further emails from X; Y still gets one (202 throughout)", async () => {
    for (let i = 0; i < 6; i++) expect((await resetRequest(X)).status).toBe(202);
    expect(sentResets).toHaveLength(5);
    expect((await resetRequest(Y)).status).toBe(202);
    expect(sentResets).toHaveLength(6);
  });

  it("test 22: the over-limit requests from X do not spend the per-email budget", async () => {
    for (let i = 0; i < 30; i++) await resetRequest(X);
    expect(redis.count(`rl:pwreset_email:${E}`)).toBe(5);
  });

  it("test 23: four IPs x five requests use the per-email cap; a fifth IP answers 202 and sends nothing", async () => {
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"]) {
      for (let i = 0; i < 5; i++) expect((await resetRequest(ip)).status).toBe(202);
    }
    expect(sentResets).toHaveLength(20);
    const fifth = await resetRequest("192.0.2.5");
    expect(fifth.status).toBe(202);
    expect(fifth.body).toEqual({});
    expect(sentResets).toHaveLength(20);
    // The refused request gave its pair hit back: nothing was sent.
    expect(redis.count(`rl:pwreset_pair:${emailIpPairKey(E, "192.0.2.5")}`)).toBe(0);
  });
});
