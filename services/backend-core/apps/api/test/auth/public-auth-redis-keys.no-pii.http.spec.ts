/**
 * RT-1043 criterion 1 — after the sign-in, password-reset, email-verify and
 * invitation-accept flows have run, no in-scope `rl:` key holds the raw email
 * or the raw client IP.
 *
 * The controller specs fake `RateLimiter` at the bucket-name level, so they
 * never see a key. This one mounts the real controllers over a real
 * `RateLimiter` and a `RedisLike` that records every key it is asked to touch,
 * then inspects those keys. IPv6, IPv4-mapped and mixed-case inputs are used on
 * purpose: they are the inputs whose normalized form differs from the raw one.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AuthController } from "../../src/auth/auth.controller";
import { AuthGuard } from "../../src/auth/auth.guard";
import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { AuthService } from "../../src/auth/auth.service";
import { RateLimiter, type RedisLike, type WindowHit } from "../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { InvitationAcceptController } from "../../src/memberships/invitation-accept.controller";
import { InvitationsService } from "../../src/memberships/invitations.service";
import { fixedWindowHit, type FixedWindowEntry } from "../_helpers/fixed-window-hit";

/** Every key the limiter touched, plus the live counters. */
class RecordingRedis implements RedisLike {
  readonly store = new Map<string, FixedWindowEntry>();
  readonly touched = new Set<string>();
  readonly deleted = new Set<string>();

  async incrWindow(key: string, ttlMs: number): Promise<WindowHit> {
    this.touched.add(key);
    return fixedWindowHit(this.store, key, ttlMs, Date.now());
  }
  async pttl(key: string): Promise<number> {
    this.touched.add(key);
    return 60_000;
  }
  async decr(key: string): Promise<number> {
    this.touched.add(key);
    const entry = this.store.get(key);
    if (entry) entry.value -= 1;
    return entry?.value ?? -1;
  }
  async del(key: string): Promise<number> {
    this.touched.add(key);
    this.deleted.add(key);
    return this.store.delete(key) ? 1 : 0;
  }
  liveKeys(prefix: string): string[] {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

class OpenGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

const RIGHT = "correct-password-1234";
const EMAIL_MIXED = "  Owner.Person@Example.COM ";
const EMAIL = "owner.person@example.com";
const IPV6 = "2001:db8:1:2:aaaa:bbbb:cccc:dddd";
const IPV6_PREFIX = "2001:db8:1:2::/64";
const MAPPED = "::ffff:203.0.113.5";
const IPV4 = "203.0.113.5";

const IN_SCOPE_BUCKETS = [
  "signin_pair",
  "signin_account",
  "signin_ip",
  "pwreset_ip",
  "pwreset_confirm_ip",
  "pwreset_pair",
  "pwreset_email",
  "email_verify_confirm_ip",
  "invitation_accept_ip",
] as const;

let app: INestApplication;
let redis: RecordingRedis;
let confirmEmail: string | null;

beforeAll(async () => {
  redis = new RecordingRedis();
  const authService = {
    async signIn(input: { email: string; password: string }) {
      if (input.password !== RIGHT) throw new UnauthorizedException("Invalid credentials");
      return {
        sessionId: "s1",
        sessionCredential: "cred",
        userId: "u1",
        absoluteExpiresAt: new Date(Date.now() + 3_600_000),
        user: { id: "u1", email: input.email, display_name: null, is_platform_admin: false },
        memberships: [],
      };
    },
    async requestPasswordReset(): Promise<void> {},
    async confirmPasswordReset(): Promise<string | null> {
      return confirmEmail;
    },
    async confirmEmailVerification(): Promise<void> {},
  };
  const invitations = {
    async acceptInvitation() {
      return {
        tenantId: "t1",
        membership: {
          membershipId: "m1",
          user: { id: "u1", email: EMAIL, displayName: null },
          roleCode: "store_manager",
          storeAccessKind: "all",
          accessibleStoreIds: [],
          revokedAt: null,
        },
        session: null,
      };
    },
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController, InvitationAcceptController],
    providers: [
      { provide: AuthService, useValue: authService },
      { provide: InvitationsService, useValue: invitations },
      { provide: RateLimiter, useValue: new RateLimiter(redis) },
    ],
  })
    .overrideGuard(AuthGuard).useValue(new OpenGuard())
    .overrideGuard(DashboardAuthGuard).useValue(new OpenGuard())
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  (app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }).set("trust proxy", 1);
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  redis.store.clear();
  redis.touched.clear();
  redis.deleted.clear();
  confirmEmail = EMAIL;
});

const http = () => request(app.getHttpServer());
const from = (ip: string) => ({ "X-Forwarded-For": ip });

async function runEveryFlow(ip: string, email: string): Promise<void> {
  expect((await http().post("/api/v1/auth/signin").set(from(ip)).send({ email, password: "wrong" })).status).toBe(401);
  expect((await http().post("/api/v1/auth/signin").set(from(ip)).send({ email, password: RIGHT })).status).toBe(200);
  expect((await http().post("/api/v1/auth/password-reset/request").set(from(ip)).send({ email })).status).toBe(202);
  expect(
    (await http().post("/api/v1/auth/password-reset/confirm").set(from(ip)).send({ token: "t", new_password: "newpassword12345" })).status,
  ).toBe(204);
  expect((await http().post("/api/v1/auth/email/verify/confirm").set(from(ip)).send({ token: "t" })).status).toBe(204);
  expect((await http().post("/api/v1/invitations/accept").set(from(ip)).send({ token: "t" })).status).toBe(200);
}

describe("RT-1043 criterion 1: no raw email or IP in an in-scope rl: key", () => {
  it.each([
    ["an IPv6 client", IPV6, [IPV6, IPV6_PREFIX, "2001", "db8"]],
    ["an IPv4-mapped client", MAPPED, [MAPPED, IPV4, "203.0.113"]],
    ["an IPv4 client", IPV4, [IPV4, "203.0.113"]],
  ])("%s", async (_name, ip, rawIpParts) => {
    await runEveryFlow(ip, EMAIL_MIXED);

    const keys = [...redis.touched];
    expect(keys.length).toBeGreaterThan(0);

    // Every bucket the flows reach is accounted for, so a new email- or
    // IP-keyed bucket cannot slip in unnoticed.
    const buckets = new Set(keys.map((k) => k.split(":")[1]));
    expect([...buckets].sort()).toEqual([...IN_SCOPE_BUCKETS].sort());

    for (const key of keys) {
      expect(key).toMatch(/^rl:[a-z_]+:[0-9a-f]{64}$/);
      const lower = key.toLowerCase();
      for (const raw of [EMAIL, "owner", "example.com", "@", ...rawIpParts]) {
        expect(lower).not.toContain(raw.toLowerCase());
      }
    }
  });

  it("the reset-confirm clear deletes the very keys sign-in created (same derivation on both paths)", async () => {
    for (let i = 0; i < 2; i++) {
      await http().post("/api/v1/auth/signin").set(from(IPV6)).send({ email: EMAIL_MIXED, password: "wrong" });
    }
    const account = redis.liveKeys("rl:signin_account:");
    const pair = redis.liveKeys("rl:signin_pair:");
    expect(account).toHaveLength(1);
    expect(pair).toHaveLength(1);

    await http().post("/api/v1/auth/password-reset/confirm").set(from(IPV6)).send({ token: "t", new_password: "newpassword12345" });

    expect(redis.liveKeys("rl:signin_account:")).toEqual([]);
    expect(redis.liveKeys("rl:signin_pair:")).toEqual([]);
    expect(redis.deleted.has(account[0]!)).toBe(true);
    expect(redis.deleted.has(pair[0]!)).toBe(true);
  });

  it("the four IP-only buckets use the RT-625 P2 normalization: one IPv6 /64 and an IPv4-mapped address share a key", async () => {
    const routes: ReadonlyArray<readonly [string, string, object]> = [
      ["rl:pwreset_ip:", "/api/v1/auth/password-reset/request", { email: EMAIL }],
      ["rl:pwreset_confirm_ip:", "/api/v1/auth/password-reset/confirm", { token: "t", new_password: "newpassword12345" }],
      ["rl:email_verify_confirm_ip:", "/api/v1/auth/email/verify/confirm", { token: "t" }],
      ["rl:invitation_accept_ip:", "/api/v1/invitations/accept", { token: "t" }],
    ];
    for (const [prefix, path, body] of routes) {
      await http().post(path).set(from("2001:db8:7:7::1")).send(body);
      await http().post(path).set(from("2001:db8:7:7:ffff::2")).send(body);
      await http().post(path).set(from("2001:db8:7:8::1")).send(body);
      await http().post(path).set(from(MAPPED)).send(body);
      await http().post(path).set(from(IPV4)).send(body);
      const counts = redis.liveKeys(prefix).map((k) => redis.store.get(k)?.value).sort();
      expect(counts).toEqual([1, 2, 2]); // other /64, the shared /64, the shared IPv4
    }
  });

  it("the same client and email map to the same keys on every request (counters accumulate)", async () => {
    for (let i = 0; i < 3; i++) {
      await http().post("/api/v1/auth/signin").set(from(IPV6)).send({ email: EMAIL_MIXED, password: "wrong" });
    }
    const [account] = redis.liveKeys("rl:signin_account:");
    expect(redis.store.get(account!)?.value).toBe(3);
  });
});
