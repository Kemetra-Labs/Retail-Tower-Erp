/**
 * invitations.accept.controller.unit.spec.ts — RT-937 item 4, HTTP layer.
 *
 * `POST /api/v1/invitations/accept` is PUBLIC: the single-use accept token is the
 * credential. This pins the controller's own responsibilities: validation, the
 * per-IP limiter (fail closed on an outage), the Origin check (a cookie is set
 * for a NEW user, so a foreign Origin is refused as login CSRF), the session
 * cookie for a new user only, and a response that never carries the token or the
 * password. The domain rules are pinned in invitations.accept-provisioning.unit.spec.ts.
 *
 * Docker-free: AuthService-free; InvitationsService and RateLimiter are fakes.
 */
import "reflect-metadata";

import {
  BadRequestException,
  ConflictException,
  type INestApplication,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { InvitationAcceptController } from "../../src/memberships/invitation-accept.controller";
import {
  InvitationsService,
  type AcceptInvitationInput,
  type AcceptInvitationResult,
} from "../../src/memberships/invitations.service";
import { RateLimiter } from "../../src/auth/rate-limit";
import type { RateLimitDecision } from "../../src/auth/rate-limit";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

const TENANT_ID = "0c000000-0000-7000-8000-0000000000a1";
const USER_ID = "0c000000-0000-7000-8000-000000000001";
const MEMBERSHIP_ID = "0c000000-0000-7000-8000-000000000002";
const STORE_ID = "0c000000-0000-7000-8000-000000000003";
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);
const PASSWORD = "Correct-Horse-Battery-9!";

function result(session: boolean): AcceptInvitationResult {
  return {
    tenantId: TENANT_ID,
    membership: {
      membershipId: MEMBERSHIP_ID,
      user: { id: USER_ID, email: "a@b.co", displayName: "A" },
      roleCode: "store_manager",
      storeAccessKind: "specific",
      accessibleStoreIds: [STORE_ID],
      revokedAt: null,
    },
    session: session
      ? { sessionId: "sess-1", sessionCredential: "cookie-value-1", absoluteExpiresAt: FUTURE }
      : null,
  };
}

class FakeInvitationsService {
  lastInput: AcceptInvitationInput | null = null;
  next: AcceptInvitationResult | Error = result(true);

  async acceptInvitation(input: AcceptInvitationInput): Promise<AcceptInvitationResult> {
    this.lastInput = input;
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

class FakeRateLimiter {
  blocked = new Set<string>();
  broken = false;
  calledBuckets: string[] = [];

  async check(bucketName: string): Promise<RateLimitDecision> {
    this.calledBuckets.push(bucketName);
    if (this.broken) throw new Error("redis down");
    const allowed = !this.blocked.has(bucketName);
    return { allowed, count: allowed ? 1 : 100, remaining: allowed ? 19 : 0, resetMs: 90_000 };
  }

  async release(): Promise<void> {
    /* not used by this route */
  }
}

let app: INestApplication;
let svc: FakeInvitationsService;
let rl: FakeRateLimiter;

beforeAll(async () => {
  svc = new FakeInvitationsService();
  rl = new FakeRateLimiter();
  const moduleRef = await Test.createTestingModule({
    controllers: [InvitationAcceptController],
    providers: [
      { provide: InvitationsService, useValue: svc },
      { provide: RateLimiter, useValue: rl },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  svc.lastInput = null;
  svc.next = result(true);
  rl.blocked.clear();
  rl.broken = false;
  rl.calledBuckets = [];
});

const body = { token: "raw-accept-token", password: PASSWORD, display_name: "New Hire" };

function post(payload: unknown = body) {
  return request(app.getHttpServer()).post("/api/v1/invitations/accept").send(payload as object);
}

describe("POST /api/v1/invitations/accept", () => {
  it("new user: 200 with the Membership, the session cookie set, and the input forwarded", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: MEMBERSHIP_ID,
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      role_code: "store_manager",
      store_access_kind: "specific",
      accessible_store_ids: [STORE_ID],
      revoked_at: null,
    });
    expect(svc.lastInput).toEqual({ token: "raw-accept-token", password: PASSWORD, displayName: "New Hire" });

    const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    const session = cookies.find((c) => c.startsWith("dp2_session="));
    expect(session).toBeDefined();
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toContain("cookie-value-1");
  });

  it("existing user: 200 with the Membership and NO cookie", async () => {
    svc.next = result(false);
    const res = await post({ token: "raw-accept-token" });

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(svc.lastInput).toEqual({ token: "raw-accept-token" });
  });

  it("never echoes the token or the password in the response", async () => {
    const res = await post();
    expect(JSON.stringify(res.body)).not.toContain("raw-accept-token");
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
  });

  it.each([
    ["missing token", { password: PASSWORD }],
    ["empty token", { token: "" }],
    ["oversized token", { token: "x".repeat(1025) }],
    ["empty display_name", { token: "t", display_name: "   " }],
    ["unknown field", { token: "t", tenant_id: "x" }],
    ["unknown role field", { token: "t", role_code: "owner" }],
  ])("returns 400 validation_error for %s — service not called", async (_name, payload) => {
    const res = await post(payload);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "validation_error" } });
    expect(svc.lastInput).toBeNull();
  });

  it("is rate-limited per IP BEFORE any work: 429 with Retry-After, service not called", async () => {
    rl.blocked.add("invitation_accept_ip");
    const res = await post();

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("90");
    expect(rl.calledBuckets).toEqual(["invitation_accept_ip"]);
    expect(svc.lastInput).toBeNull();
  });

  it("fails closed with 503 and Retry-After when the limiter is down (RT-628 posture)", async () => {
    rl.broken = true;
    const res = await post();

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(svc.lastInput).toBeNull();
  });

  it("refuses a foreign Origin with 403 (login CSRF), and admits a missing Origin", async () => {
    const foreign = await request(app.getHttpServer())
      .post("/api/v1/invitations/accept")
      .set("Origin", "https://evil.example")
      .send(body);
    expect(foreign.status).toBe(403);
    expect(foreign.body).toMatchObject({ error: { code: "origin_rejected" } });
    expect(svc.lastInput).toBeNull();

    const none = await post();
    expect(none.status).toBe(200);
  });

  it.each([
    ["opaque 400", new BadRequestException("Invalid or expired invitation token"), 400],
    ["409 conflict", new ConflictException("An account already exists for this invitation"), 409],
    ["503 provider unavailable", new ServiceUnavailableException("Identity provider unavailable"), 503],
  ])("passes the service's %s through the error envelope with no cookie", async (_name, error, status) => {
    svc.next = error;
    const res = await post();

    expect(res.status).toBe(status);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain("raw-accept-token");
  });
});
