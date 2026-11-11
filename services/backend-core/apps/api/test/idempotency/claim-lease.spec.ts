/**
 * RT-1325 (RT-1125 R-03) — the in-flight claim as a lease, against the REAL
 * Postgres idempotency mirror (`PgIdempotencyMirror` on the RLS app pool),
 * with a retaining FakeRedis as the fast path. Docker-gated.
 *
 *   - an orphaned claim (the handler succeeded but its result save failed)
 *     answers 425 while its lease runs, is then taken over, and the retry
 *     runs the handler and succeeds (AC 2);
 *   - the completed result is replayed from Postgres for the full replay TTL,
 *     not the lease (AC 2);
 *   - fencing: after a takeover, the first claimant's late release or
 *     completion is refused; only the taker's own claim is completed.
 */
import "reflect-metadata";

import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  HttpStatus,
  type INestApplication,
  Post,
  Res,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Response } from "express";
import type { Pool } from "pg";
import request from "supertest";

import { IdempotencyKeyStore, type StoredResult } from "@data-pulse-2/shared";

import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import type { ResolvedContext } from "../../src/context/types";
import { Idempotent } from "../../src/idempotency/idempotent.decorator";
import { IdempotencyInterceptor } from "../../src/idempotency/idempotency.interceptor";
import type { InProgressMarker } from "../../src/idempotency/in-progress-marker";
import { PgIdempotencyMirror } from "../../src/idempotency/pg-mirror";
import { ACTOR_A, TENANT_A, seedCatalogIsolationFixture } from "../catalog/__support__/isolation-harness";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import { assertIdempotencyRedisRetains } from "./require-retaining-redis";

const LEASE_SEC = 1;
const HOUR_MS = 60 * 60 * 1000;
const LEASE_IDEM = "rt1325-lease-key-000001";

class FakeRedis {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.map.set(key, value);
    return "OK";
  }
  clear(): void {
    this.map.clear();
  }
}

/** The Redis in-flight marker is out of scope here: always free. */
class FreeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
}

/** The real mirror, whose next completion can be made to fail once. */
class FlakyMirror extends PgIdempotencyMirror {
  failNextInsert = false;
  override async insert(row: Parameters<PgIdempotencyMirror["insert"]>[0]): Promise<void> {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      throw new Error("simulated save failure");
    }
    return super.insert(row);
  }
}

@Controller()
class LeaseProbeController {
  calls = 0;

  @Post("lease-probe")
  @Idempotent("required", { claimLeaseSec: LEASE_SEC })
  create(@Res({ passthrough: true }) res: Response): { n: number } {
    this.calls += 1;
    res.status(HttpStatus.CREATED);
    return { n: 1 };
  }
}

class ContextGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext; principal?: { userId?: string } }>();
    req.context = { userId: ACTOR_A, tenantId: TENANT_A, storeId: null, isPlatformAdmin: false, source: "session" };
    req.principal = { userId: ACTOR_A };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let controller: LeaseProbeController;
let mirror: FlakyMirror;
const redis = new FakeRedis();
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[claim-lease.spec] Docker NOT AVAILABLE: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);
  await assertIdempotencyRedisRetains(redis, "claim-lease");
  mirror = new FlakyMirror(env.app as unknown as Pool);
  const store = new IdempotencyKeyStore({ redis, pgWriter: mirror, pgReader: mirror, defaultTtlMs: 72 * HOUR_MS });
  const interceptor = new IdempotencyInterceptor(new Reflector(), store, new FreeMarker() as unknown as InProgressMarker);
  const moduleRef = await Test.createTestingModule({
    controllers: [LeaseProbeController],
    providers: [{ provide: APP_INTERCEPTOR, useValue: interceptor }],
  }).compile();
  controller = moduleRef.get(LeaseProbeController);
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(new ContextGuard());
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  return dockerSkipped || !app;
}

const post = () => request(app!.getHttpServer()).post("/lease-probe").set("Idempotency-Key", LEASE_IDEM).send({ a: 1 });

async function storedRow(): Promise<{ response_status: number; expires_at: Date }> {
  const r = await env!.admin.query<{ response_status: number; expires_at: Date }>(
    `SELECT response_status, expires_at FROM idempotency_keys WHERE tenant_id = $1 AND key LIKE $2`,
    [TENANT_A, `%${LEASE_IDEM}`],
  );
  expect(r.rows).toHaveLength(1);
  return r.rows[0]!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("claim lease against real Postgres (RT-1325, RT-1125 R-03)", () => {
  it("an orphaned claim answers 425 while its lease runs, then is taken over and the retry succeeds", async () => {
    if (skip()) return;
    mirror.failNextInsert = true;
    const first = await post();
    expect(first.status).toBe(201);
    expect(controller.calls).toBe(1);
    // The save failed: the claim row is left behind, with a lease expiry.
    const orphan = await storedRow();
    expect(orphan.response_status).toBe(0);
    expect(orphan.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + LEASE_SEC * 1000);

    expect((await post()).status).toBe(425);
    expect(controller.calls).toBe(1);

    await sleep(LEASE_SEC * 1000 + 1500);
    const retried = await post();
    expect(retried.status).toBe(201);
    expect(retried.headers["idempotent-replayed"]).toBeUndefined();
    expect(controller.calls).toBe(2);
  }, 30_000);

  it("the completed result is replayed from Postgres for the full replay TTL, not the lease", async () => {
    if (skip()) return;
    const done = await storedRow();
    expect(done.response_status).toBe(201);
    expect(done.expires_at.getTime()).toBeGreaterThan(Date.now() + 71 * HOUR_MS);

    redis.clear(); // force the Postgres mirror path
    await sleep(LEASE_SEC * 1000 + 500); // well past the lease
    const replay = await post();
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual({ n: 1 });
    expect(controller.calls).toBe(2);
  }, 30_000);

  describe("fencing after a takeover", () => {
    const FENCE_IDEM = "rt1325-fence-key-000001";
    const CLIENT = "rt1325-client";
    const FP = Buffer.alloc(32, 7);
    const RESULT: StoredResult = { status: 201, body: { late: true } };
    const scope = { tenantId: TENANT_A, storeId: null, clientId: CLIENT, key: FENCE_IDEM };

    async function fenceRow(): Promise<{ response_status: number; expires_at: Date }> {
      const r = await env!.admin.query<{ response_status: number; expires_at: Date }>(
        `SELECT response_status, expires_at FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`,
        [TENANT_A, FENCE_IDEM],
      );
      return r.rows[0]!;
    }

    it("the first claimant's late release and completion are refused; the taker completes its own claim", async () => {
      if (skip()) return;
      const lapsed = new Date(Date.now() - 60_000);
      const taken = new Date(Date.now() + 60_000);
      const replay = new Date(Date.now() + 72 * HOUR_MS);
      await mirror.claim({ ...scope, fingerprint: FP, expiresAt: lapsed });
      // Takeover: the lapsed claim is rewritten with the taker's expiry.
      await mirror.claim({ ...scope, fingerprint: FP, expiresAt: taken });
      expect((await fenceRow()).expires_at.getTime()).toBe(taken.getTime());

      await mirror.release({ ...scope, claimExpiresAt: lapsed });
      await mirror.insert({ ...scope, fingerprint: FP, result: RESULT, expiresAt: replay, claimExpiresAt: lapsed });
      const untouched = await fenceRow();
      expect(untouched.response_status).toBe(0);
      expect(untouched.expires_at.getTime()).toBe(taken.getTime());

      await mirror.insert({ ...scope, fingerprint: FP, result: RESULT, expiresAt: replay, claimExpiresAt: taken });
      const completed = await fenceRow();
      expect(completed.response_status).toBe(201);
      expect(completed.expires_at.getTime()).toBe(replay.getTime());
    });

    it("a claimant releases its own claim", async () => {
      if (skip()) return;
      await env!.admin.query(`DELETE FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`, [TENANT_A, FENCE_IDEM]);
      const own = new Date(Date.now() + 60_000);
      await mirror.claim({ ...scope, fingerprint: FP, expiresAt: own });
      await mirror.release({ ...scope, claimExpiresAt: own });
      const r = await env!.admin.query(`SELECT 1 FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`, [TENANT_A, FENCE_IDEM]);
      expect(r.rows).toHaveLength(0);
    });
  });
});
