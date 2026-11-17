/**
 * RT-1439 — the harness of the store deletion specs: real Postgres (every migration) through the
 * Nest HTTP pipeline on the non-superuser app role (RLS in force), the real `IdempotencyInterceptor`
 * over an in-memory store, and an in-memory Redis stand-in for the re-authentication grant and its
 * failed-attempt budget.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. Same Docker-less soft skip as
 * `stores.timezone.http.integration.spec.ts` (`MIGRATION_TEST_ALLOW_SKIP=1`).
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { hashPassword } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import type { Pool } from "pg";
import request from "supertest";

import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL, REDIS_CLIENT } from "../../src/auth/auth.module";
import { EMAIL_JOB_ENQUEUER, NoOpEmailJobEnqueuer } from "../../src/auth/email-job.enqueuer";
import type { WindowHit } from "../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { LoggingInterceptor } from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { ContextModule } from "../../src/context/context.module";
import { StoresModule } from "../../src/stores/stores.module";
import { idempotencyProviders } from "./idempotency-providers";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "./postgres-container";
import { SAME_ORIGIN } from "./same-origin";
import { enterTenantAsPlatformAdmin } from "./support-session";

/** In-memory Redis: the grant surface, the rate-limit surface and a settable clock. */
export class TestRedis {
  private readonly values = new Map<string, { value: string; expiresAt: number }>();
  private readonly windows = new Map<string, { count: number; expiresAt: number }>();
  /** Added to the clock, so a spec can age a grant past its 5 minutes. */
  offsetMs = 0;
  /** Every value ever written, for "the secret was never stored" assertions. */
  readonly everWritten: string[] = [];
  failNextSet = false;

  private now(): number {
    return Date.now() + this.offsetMs;
  }
  get(key: string): Promise<string | null> {
    const e = this.values.get(key);
    return Promise.resolve(!e || this.now() > e.expiresAt ? null : e.value);
  }
  set(key: string, value: string, options: { px: number } | { nx: true; ex: number }): Promise<"OK" | null> {
    if (this.failNextSet) {
      this.failNextSet = false;
      return Promise.reject(new Error("redis down"));
    }
    this.everWritten.push(key, value);
    if ("nx" in options) {
      if (this.values.has(key)) return Promise.resolve(null);
      this.values.set(key, { value, expiresAt: this.now() + options.ex * 1000 });
      return Promise.resolve("OK");
    }
    this.values.set(key, { value, expiresAt: this.now() + options.px });
    return Promise.resolve("OK");
  }
  del(key: string): Promise<number> {
    this.windows.delete(key);
    return Promise.resolve(this.values.delete(key) ? 1 : 0);
  }
  compareAndDelete(key: string, expected: string): Promise<boolean> {
    const e = this.values.get(key);
    if (!e || this.now() > e.expiresAt || e.value !== expected) return Promise.resolve(false);
    this.values.delete(key);
    return Promise.resolve(true);
  }
  incrWindow(key: string, ttlMs: number): Promise<WindowHit> {
    // The specs sign in many times from one address: the per-IP sign-in budget (30 per hour) is not under test.
    if (key.includes("signin_ip")) return Promise.resolve({ count: 1, ttlMs });
    const w = this.windows.get(key);
    const live = w && this.now() <= w.expiresAt ? w : { count: 0, expiresAt: this.now() + ttlMs };
    live.count += 1;
    this.windows.set(key, live);
    return Promise.resolve({ count: live.count, ttlMs: live.expiresAt - this.now() });
  }
  pttl(key: string): Promise<number> {
    const w = this.windows.get(key);
    return Promise.resolve(w ? w.expiresAt - this.now() : -2);
  }
  decr(key: string): Promise<number> {
    const w = this.windows.get(key);
    if (!w) return Promise.resolve(-1);
    w.count -= 1;
    return Promise.resolve(w.count);
  }
  /** `incrWindow` plus the window's end, on this fake's one clock (the adapter's script uses the server's). */
  async incrWindowWithEnd(key: string, ttlMs: number): Promise<WindowHit & { windowEndsAtMs: number }> {
    const hit = await this.incrWindow(key, ttlMs);
    return { ...hit, windowEndsAtMs: this.now() + hit.ttlMs };
  }
  /** The atomic window-checked decrement the ioredis adapter runs as one script. */
  decrIfWindowEnds(key: string, windowEndsAtMs: number, toleranceMs: number): Promise<boolean> {
    const w = this.windows.get(key);
    if (!w || this.now() > w.expiresAt) return Promise.resolve(false);
    if (Math.abs(w.expiresAt - windowEndsAtMs) > toleranceMs) return Promise.resolve(false);
    w.count -= 1;
    if (w.count < 0) this.windows.delete(key);
    return Promise.resolve(true);
  }
  /** The live (unexpired) grant keys. */
  grantKeys(): string[] {
    return [...this.values.keys()].filter((k) => k.startsWith("reauth:grant:") && this.now() <= this.values.get(k)!.expiresAt);
  }
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export const ACME_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const GLOBEX_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

export const USERS = {
  owner: { id: "11111111-1111-4111-8111-111111111111", email: "owen@example.com", password: "Owner-Password-123!" },
  ownerTwo: { id: "11111111-1111-4111-8111-222222222222", email: "olga@example.com", password: "OwnerTwo-Password-123!" },
  admin: { id: "22222222-2222-4222-8222-222222222222", email: "bob@example.com", password: "Bob-Password-123!" },
  manager: { id: "33333333-3333-4333-8333-333333333333", email: "mia@example.com", password: "Mia-Password-123!" },
  platform: { id: "44444444-4444-4444-8444-444444444444", email: "paul@example.com", password: "Paul-Password-123!" },
  globexOwner: { id: "55555555-5555-4555-8555-555555555555", email: "gina@example.com", password: "Gina-Password-123!" },
} as const;
export type UserKey = keyof typeof USERS;

const ROLE_IDS = {
  acmeOwner: "cccccccc-1111-4111-8111-cccccccccc01",
  acmeAdmin: "cccccccc-1111-4111-8111-cccccccccc02",
  acmeManager: "cccccccc-1111-4111-8111-cccccccccc03",
  globexOwner: "cccccccc-2222-4222-8222-cccccccccc01",
} as const;

export interface Harness {
  readonly env: PgTestEnv;
  readonly app: INestApplication;
  readonly redis: TestRedis;
  /** Docker was unavailable and `MIGRATION_TEST_ALLOW_SKIP=1`: the spec must skip. */
  readonly skipped: boolean;
  readonly admin: Pool;
  http(): ReturnType<typeof request>;
  /** Sign in (a NEW auth session each call) and select the tenant; returns the session cookie. */
  signIn(user: UserKey, tenantId?: string): Promise<string>;
  /** Sign in a platform admin and enter acme through an active support session. */
  signInPlatformAdmin(): Promise<string>;
  /** Re-enter the password, returning the grant token. Fails the test unless 200. */
  grantFor(cookie: string, storeId: string, password: string): Promise<string>;
  close(): Promise<void>;
}

async function seedBase(pg: Pool): Promise<void> {
  const all = Object.values(USERS);
  for (const u of all) {
    await pg.query(
      `INSERT INTO users (id, email, password_hash, is_platform_admin) VALUES ($1, $2, $3, $4)`,
      [u.id, u.email, await hashPassword(u.password), u.id === USERS.platform.id],
    );
  }
  await pg.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'acme', 'Acme'), ($2, 'globex', 'Globex')`, [
    ACME_ID,
    GLOBEX_ID,
  ]);
  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $4, 'owner', 'Owner'), ($2, $4, 'tenant_admin', 'Tenant Admin'),
       ($3, $4, 'store_manager', 'Store Manager'), ($5, $6, 'owner', 'Owner')`,
    [ROLE_IDS.acmeOwner, ROLE_IDS.acmeAdmin, ROLE_IDS.acmeManager, ACME_ID, ROLE_IDS.globexOwner, GLOBEX_ID],
  );
  const members: Array<[string, string, string]> = [
    [ACME_ID, USERS.owner.id, ROLE_IDS.acmeOwner],
    [ACME_ID, USERS.ownerTwo.id, ROLE_IDS.acmeOwner],
    [ACME_ID, USERS.admin.id, ROLE_IDS.acmeAdmin],
    [ACME_ID, USERS.manager.id, ROLE_IDS.acmeManager],
    [GLOBEX_ID, USERS.globexOwner.id, ROLE_IDS.globexOwner],
  ];
  for (const [tenantId, userId, roleId] of members) {
    await pg.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES ($1, $2, $3, $4, 'all')`,
      [randomUUID(), tenantId, userId, roleId],
    );
  }
}

/** Start the harness. `seed` adds a spec's own stores, devices and shifts on the superuser pool. */
export async function startHarness(seed: (admin: Pool) => Promise<void>): Promise<Harness> {
  const redis = new TestRedis();
  let env: PgTestEnv | null = null;
  let app: INestApplication | null = null;
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedBase(env.admin);
    await seed(env.admin);
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ContextModule, StoresModule],
      providers: idempotencyProviders(),
    })
      .overrideProvider(PG_POOL)
      .useValue(env.app)
      // RT-1249: sign-in reads password_hash on the lookup role, never app_test.
      .overrideProvider(AUTH_LOOKUP_POOL)
      .useValue(env.admin)
      .overrideProvider(REDIS_CLIENT)
      .useValue(redis)
      .overrideProvider(EMAIL_JOB_ENQUEUER)
      .useValue(new NoOpEmailJobEnqueuer())
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    app.useGlobalInterceptors(
      new RequestIdInterceptor(),
      new LoggingInterceptor(createLogger({ service: "api-test", level: "silent" })),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (env === null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[store-deletion] Docker NOT AVAILABLE: ${msg}\n`);
      return { skipped: true } as unknown as Harness;
    }
    if (env) await stopPgEnv(env);
    throw new Error(`Harness start failed: ${msg}`);
  }
  const theEnv = env;
  const theApp = app;
  const http = () => request(theApp.getHttpServer());
  const signIn = async (user: UserKey, tenantId: string = ACME_ID): Promise<string> => {
    const { email, password } = USERS[user];
    const res = await http().post("/api/v1/auth/signin").send({ email, password }).expect(200);
    const setCookie = res.headers["set-cookie"];
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const cookie = list.find((c: string) => c.startsWith("dp2_session="))?.split(";")[0];
    if (!cookie) throw new Error(`signIn(${email}): no session cookie`);
    await http().post("/api/v1/context/tenant").set("Cookie", cookie).set(SAME_ORIGIN).send({ tenant_id: tenantId }).expect(200);
    return cookie;
  };
  return {
    env: theEnv,
    app: theApp,
    redis,
    skipped: false,
    admin: theEnv.admin,
    http,
    signIn,
    signInPlatformAdmin: async () => {
      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: USERS.platform.email, password: USERS.platform.password })
        .expect(200);
      const setCookie = res.headers["set-cookie"];
      const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      const cookie = list.find((c: string) => c.startsWith("dp2_session="))!.split(";")[0]!;
      await enterTenantAsPlatformAdmin(theEnv.admin, USERS.platform.id, ACME_ID);
      return cookie;
    },
    grantFor: async (cookie, storeId, password) => {
      const res = await http()
        .post("/api/v1/auth/reauth")
        .set("Cookie", cookie)
        .set(SAME_ORIGIN)
        .send({ purpose: "store_deletion", storeId, password })
        .expect(200);
      return (res.body as { reauthToken: string }).reauthToken;
    },
    close: async () => {
      await theApp.close().catch(() => undefined);
      await stopPgEnv(theEnv);
    },
  };
}
