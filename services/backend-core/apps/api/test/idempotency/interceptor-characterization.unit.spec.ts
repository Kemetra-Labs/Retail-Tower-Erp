/**
 * RT-1223 — characterization matrix for `IdempotencyInterceptor.handle`.
 *
 * Written BEFORE `handle` is decomposed, against the code as it stood on main,
 * so the refactor must keep every row green. For each branch it pins the HTTP
 * status, the response body (after the GlobalExceptionFilter), the relevant
 * headers, the idempotency metrics, the catalog audit enqueue, the store calls
 * (including the RT-155 path-param store key) and the in-progress marker
 * lifecycle.
 *
 * Docker-free: the store and marker are scripted fakes; metrics are spied.
 */
import "reflect-metadata";
import {
  Controller,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Res,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";

import type {
  FindOrCreateResult,
  IdempotencyKeyStore,
  Logger,
  StoredResult,
} from "@data-pulse-2/shared";

import type { AuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { Idempotent } from "../../src/idempotency/idempotent.decorator";
import {
  IdempotencyInterceptor,
  bodyFingerprint,
  composeTuple,
} from "../../src/idempotency/idempotency.interceptor";
import type { InProgressMarker } from "../../src/idempotency/in-progress-marker";
import { nonReplayableMarker } from "../../src/idempotency/non-replayable";
import * as metrics from "../../src/observability/metrics/api.metrics";

const KEY = "char-key-0123456789abcdef";
const TENANT = "72300000-0000-4000-8000-000000000001";
const STORE = "72300000-0000-4000-8000-000000000002";
const USER = "72300000-0000-4000-8000-000000000003";
const RESOURCE = "72300000-0000-4000-8000-000000000004";
const REQUEST_ID = "req-char-1";

const COLLISION_MESSAGE =
  "The provided Idempotency-Key has already been used for a different request body. Generate a new key.";
const NON_REPLAYABLE_MESSAGE =
  "The provided Idempotency-Key already completed a request whose response is never replayed. Generate a new key.";
const REQUIRED_MESSAGE =
  "This endpoint requires an Idempotency-Key header. Generate a UUIDv7 and include it with every retry.";
const MALFORMED_MESSAGE =
  "Idempotency-Key must be 16–128 printable ASCII characters with no whitespace.";
const LEGACY_KEY_MESSAGE =
  "The provided Idempotency-Key was already used on this route before per-resource keying. Generate a new key.";

/** The GlobalExceptionFilter envelope every 4xx here is answered with. */
function errorBody(code: string, message: string): object {
  return { error: { code, message, request_id: REQUEST_ID } };
}

@Controller()
class CharController {
  public calls = 0;
  public fail: Error | null = null;

  private run(res: Response): { ok: true; n: number } {
    this.calls += 1;
    if (this.fail) throw this.fail;
    res.status(HttpStatus.CREATED);
    return { ok: true, n: this.calls };
  }

  @Post("char")
  @Idempotent("required")
  create(@Res({ passthrough: true }) res: Response): { ok: true; n: number } {
    return this.run(res);
  }

  @Post("char-optional")
  @Idempotent("optional")
  createOptional(@Res({ passthrough: true }) res: Response): { ok: true; n: number } {
    return this.run(res);
  }

  @Post("char/:id/act")
  @Idempotent("required")
  act(@Param("id") _id: string, @Res({ passthrough: true }) res: Response): { ok: true; n: number } {
    return this.run(res);
  }

  @Post("char-forbid")
  @Idempotent("required", { replay: "forbid", replayMarkerFields: ["id"] })
  forbid(@Res({ passthrough: true }) res: Response): { id: string; secret: string } {
    this.calls += 1;
    res.status(HttpStatus.CREATED);
    return { id: "r-1", secret: "s3cret" };
  }

  @Post("catalog/unknown-items")
  @Idempotent("required")
  capture(@Res({ passthrough: true }) res: Response): { ok: true; n: number } {
    return this.run(res);
  }
}

type FindOrCreate = (key: string) => Promise<FindOrCreateResult>;

interface Script {
  findOrCreate: FindOrCreate[];
  claim: Array<"inserted" | "conflict" | "unsupported">;
  markerSet: boolean;
}

const MISS: FindOrCreateResult = { hit: false, entry: null };

function hit(result: StoredResult): FindOrCreateResult {
  return { hit: true, entry: { fingerprint: Buffer.alloc(32), result, expiresAt: new Date(0) } };
}

describe("IdempotencyInterceptor characterization matrix (RT-1223)", () => {
  let app: INestApplication;
  let controller: CharController;
  let script: Script;
  const store = {
    findOrCreate: jest.fn(),
    claim: jest.fn(),
    releaseClaim: jest.fn(),
    save: jest.fn(),
  };
  const marker = { trySet: jest.fn(), del: jest.fn() };
  const auditEnqueuer = { enqueue: jest.fn() };
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };
  // Every row asserts metrics and audit: a row that does not inspect the
  // metrics itself must have recorded none, and only rows that opt in may
  // enqueue a catalog audit.
  let metricsChecked = false;
  let auditExpected = false;
  const NO_METRICS = { replay: [], conflict: [], inProgress: [], tokenMismatch: [] };
  let spies: Record<
    "replay" | "conflict" | "inProgress" | "tokenMismatch",
    jest.SpyInstance
  >;

  beforeAll(async () => {
    const interceptor = new IdempotencyInterceptor(
      new Reflector(),
      store as unknown as IdempotencyKeyStore,
      marker as unknown as InProgressMarker,
      auditEnqueuer as unknown as AuditJobEnqueuer,
      logger as unknown as Logger,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [CharController],
      providers: [{ provide: APP_INTERCEPTOR, useValue: interceptor }],
    }).compile();
    controller = moduleRef.get(CharController);
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use((req: Request, _res: Response, next: NextFunction) => {
      Object.assign(req, {
        context: { tenantId: TENANT, storeId: STORE, userId: USER },
        principal: { userId: USER },
        requestId: REQUEST_ID,
      });
      next();
    });
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    controller.calls = 0;
    controller.fail = null;
    script = { findOrCreate: [], claim: [], markerSet: true };
    store.findOrCreate.mockReset().mockImplementation(
      (_t: string, _s: null, _c: string, key: string) => {
        const next = script.findOrCreate.shift();
        if (!next) throw new Error(`unscripted findOrCreate(${key})`);
        return next(key);
      },
    );
    store.claim.mockReset().mockImplementation(async () => {
      const next = script.claim.shift();
      if (!next) throw new Error("unscripted claim");
      return next;
    });
    store.releaseClaim.mockReset().mockResolvedValue(undefined);
    store.save.mockReset().mockResolvedValue(undefined);
    marker.trySet.mockReset().mockImplementation(async () => script.markerSet);
    marker.del.mockReset().mockResolvedValue(undefined);
    auditEnqueuer.enqueue.mockReset().mockResolvedValue(undefined);
    logger.warn.mockReset();
    logger.error.mockReset();
    spies = {
      replay: jest.spyOn(metrics, "recordIdempotencyReplay"),
      conflict: jest.spyOn(metrics, "recordIdempotencyConflict"),
      inProgress: jest.spyOn(metrics, "recordIdempotencyInProgress"),
      tokenMismatch: jest.spyOn(metrics, "recordIdempotencyTokenMismatch"),
    };
  });

  afterEach(() => {
    if (!metricsChecked) expect(metricCalls()).toEqual(NO_METRICS);
    if (!auditExpected) expect(auditEnqueuer.enqueue).not.toHaveBeenCalled();
    metricsChecked = false;
    auditExpected = false;
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  }

  function post(path: string, body: object = { a: 1 }, key: string | null = KEY) {
    const req = request(app.getHttpServer()).post(path);
    if (key !== null) req.set("Idempotency-Key", key);
    return req.send(body);
  }

  function metricCalls(): Record<string, unknown[][]> {
    metricsChecked = true;
    return {
      replay: spies.replay.mock.calls,
      conflict: spies.conflict.mock.calls,
      inProgress: spies.inProgress.mock.calls,
      tokenMismatch: spies.tokenMismatch.mock.calls,
    };
  }

  const storeKey = (path: string, params = ""): string =>
    `POST:${path}${params}:${USER}:${KEY}`;
  const tuple = (path: string, params = ""): string =>
    composeTuple(TENANT, storeKey(path, params));

  // -------------------------------------------------------------------------
  // Header policy
  // -------------------------------------------------------------------------

  it("missing header on a required route: 400 idempotency_key_required, no store or marker", async () => {
    const res = await post("/char", { a: 1 }, null);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(errorBody("idempotency_key_required", REQUIRED_MESSAGE));
    expect(controller.calls).toBe(0);
    expect(marker.trySet).not.toHaveBeenCalled();
    expect(store.findOrCreate).not.toHaveBeenCalled();
  });

  it("missing header on an optional route: handler runs with no replay protection", async () => {
    const res = await post("/char-optional", { a: 1 }, null);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, n: 1 });
    expect(marker.trySet).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("malformed header: 400 idempotency_key_malformed", async () => {
    const res = await post("/char", { a: 1 }, "short");
    expect(res.status).toBe(400);
    expect(res.body).toEqual(errorBody("idempotency_key_malformed", MALFORMED_MESSAGE));
    expect(controller.calls).toBe(0);
    expect(marker.trySet).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Fresh claim
  // -------------------------------------------------------------------------

  it("fresh claim: handler runs once, result saved with its status, marker set then cleared", async () => {
    script.findOrCreate.push(async () => MISS);
    script.claim.push("inserted");
    const res = await post("/char", { b: 2, a: 1 });
    await settle();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, n: 1 });
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(marker.trySet).toHaveBeenCalledWith(tuple("/char"), expect.any(Number));
    expect(store.findOrCreate).toHaveBeenCalledWith(
      TENANT, null, USER, storeKey("/char"), bodyFingerprint({ a: 1, b: 2 }),
    );
    expect(store.claim).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, storeId: null, clientId: USER, key: storeKey("/char"),
    }));
    expect(store.save).toHaveBeenCalledWith(
      TENANT, null, USER, storeKey("/char"), bodyFingerprint({ a: 1, b: 2 }),
      { status: 201, body: { ok: true, n: 1 } }, expect.any(Date),
    );
    expect(marker.del).toHaveBeenCalledWith(tuple("/char"));
    expect(marker.del).toHaveBeenCalledTimes(1);
    expect(store.releaseClaim).not.toHaveBeenCalled();
    expect(metricCalls()).toEqual({ replay: [], conflict: [], inProgress: [], tokenMismatch: [] });
    expect(auditEnqueuer.enqueue).not.toHaveBeenCalled();
  });

  it("fresh claim on a param route binds the path param into the store key (RT-155) and probes the legacy key", async () => {
    script.findOrCreate.push(async () => MISS, async () => MISS);
    script.claim.push("inserted");
    const res = await post(`/char/${RESOURCE}/act`);
    await settle();
    expect(res.status).toBe(201);
    const keys = store.findOrCreate.mock.calls.map((c) => c[3] as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain(RESOURCE);
    expect(keys[1]).toBe(`POST:/char/:id/act:${USER}:${KEY}`);
    expect(store.save.mock.calls[0]?.[3]).toBe(keys[0]);
    expect(marker.del).toHaveBeenCalledTimes(1);
  });

  it("legacy template-only key occupied on a param route: 409 legacy message + conflict metric, handler not run", async () => {
    script.findOrCreate.push(async () => MISS, async () => ({ hit: "collision" }));
    const res = await post(`/char/${RESOURCE}/act`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual(errorBody("idempotency_key_conflict", LEGACY_KEY_MESSAGE));
    expect(controller.calls).toBe(0);
    expect(store.claim).not.toHaveBeenCalled();
    expect(metricCalls()).toEqual({
      replay: [], conflict: [[{ route: "POST:/char/:id/act" }]], inProgress: [], tokenMismatch: [],
    });
    expect(marker.del).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // In flight
  // -------------------------------------------------------------------------

  it("in-flight (marker held): 425 with Retry-After, in-progress metric, store untouched", async () => {
    script.markerSet = false;
    const res = await post("/char");
    expect(res.status).toBe(425);
    expect(res.body).toEqual({ error: "idempotency_in_progress", retryAfterSec: 2 });
    expect(res.headers["retry-after"]).toBe("2");
    expect(controller.calls).toBe(0);
    expect(store.findOrCreate).not.toHaveBeenCalled();
    expect(marker.del).not.toHaveBeenCalled();
    expect(metricCalls()).toEqual({
      replay: [], conflict: [], inProgress: [[{ route: "POST:/char" }]], tokenMismatch: [],
    });
  });

  it("in-flight (store reports in_progress): 425, marker released, in-progress metric", async () => {
    script.findOrCreate.push(async () => ({ hit: "in_progress" }));
    const res = await post("/char");
    expect(res.status).toBe(425);
    expect(res.body).toEqual({ error: "idempotency_in_progress", retryAfterSec: 2 });
    expect(res.headers["retry-after"]).toBe("2");
    expect(controller.calls).toBe(0);
    expect(store.claim).not.toHaveBeenCalled();
    expect(marker.del).toHaveBeenCalledWith(tuple("/char"));
    expect(marker.del).toHaveBeenCalledTimes(1);
    expect(metricCalls()).toEqual({
      replay: [], conflict: [], inProgress: [[{ route: "POST:/char" }]], tokenMismatch: [],
    });
  });

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  it("replay with the same body: stored status and body, Idempotent-Replayed header, replay metric", async () => {
    script.findOrCreate.push(async () => hit({ status: 200, body: { ok: true, n: 41 } }));
    const res = await post("/char");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, n: 41 });
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(controller.calls).toBe(0);
    expect(store.claim).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(marker.del).toHaveBeenCalledWith(tuple("/char"));
    expect(marker.del).toHaveBeenCalledTimes(1);
    expect(metricCalls()).toEqual({
      replay: [[{ route: "POST:/char" }]], conflict: [], inProgress: [], tokenMismatch: [],
    });
  });

  // -------------------------------------------------------------------------
  // Same key, different body
  // -------------------------------------------------------------------------

  it("collision on a generic route: 409, conflict metric only, no catalog audit", async () => {
    script.findOrCreate.push(async () => ({ hit: "collision" }));
    const res = await post("/char");
    expect(res.status).toBe(409);
    expect(res.body).toEqual(errorBody("idempotency_key_conflict", COLLISION_MESSAGE));
    expect(controller.calls).toBe(0);
    expect(marker.del).toHaveBeenCalledWith(tuple("/char"));
    expect(marker.del).toHaveBeenCalledTimes(2);
    expect(metricCalls()).toEqual({
      replay: [], conflict: [[{ route: "POST:/char" }]], inProgress: [], tokenMismatch: [],
    });
    expect(auditEnqueuer.enqueue).not.toHaveBeenCalled();
  });

  it("collision on the unknown-items capture route: 409, conflict + token-mismatch metrics, audit enqueued", async () => {
    auditExpected = true;
    script.findOrCreate.push(async () => ({ hit: "collision" }));
    const res = await post("/catalog/unknown-items");
    expect(res.status).toBe(409);
    expect(res.body).toEqual(errorBody("idempotency_key_conflict", COLLISION_MESSAGE));
    expect(metricCalls()).toEqual({
      replay: [],
      conflict: [[{ route: "POST:/catalog/unknown-items" }]],
      inProgress: [],
      tokenMismatch: [[]],
    });
    expect(marker.del).toHaveBeenCalledTimes(2);
    expect(auditEnqueuer.enqueue).toHaveBeenCalledTimes(1);
    expect(auditEnqueuer.enqueue).toHaveBeenCalledWith({
      actor_user_id: USER,
      actor_label: null,
      tenant_id: TENANT,
      store_id: STORE,
      action: "unknown_item.idempotency_mismatch_rejected",
      target_type: null,
      target_id: null,
      request_id: REQUEST_ID,
      metadata: null,
    });
  });

  it("collision audit enqueue failure is logged and the 409 still stands", async () => {
    auditExpected = true;
    script.findOrCreate.push(async () => ({ hit: "collision" }));
    auditEnqueuer.enqueue.mockRejectedValueOnce(new Error("bullmq down"));
    const res = await post("/catalog/unknown-items");
    await settle();
    expect(res.status).toBe(409);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ action: "unknown_item.idempotency_mismatch_rejected" }),
      "IdempotencyInterceptor: catalog audit enqueue failed on collision",
    );
    expect(metricCalls()).toEqual({
      replay: [],
      conflict: [[{ route: "POST:/catalog/unknown-items" }]],
      inProgress: [],
      tokenMismatch: [[]],
    });
  });

  // -------------------------------------------------------------------------
  // Lost claim (another request inserted the durable claim first)
  // -------------------------------------------------------------------------

  it("lost claim, winner completed: replays the stored result with the replay metric", async () => {
    script.findOrCreate.push(async () => MISS, async () => hit({ status: 201, body: { ok: true, n: 7 } }));
    script.claim.push("conflict");
    const res = await post("/char");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, n: 7 });
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(controller.calls).toBe(0);
    expect(marker.del).toHaveBeenCalledWith(tuple("/char"));
    expect(marker.del).toHaveBeenCalledTimes(1);
    expect(metricCalls()).toEqual({
      replay: [[{ route: "POST:/char" }]], conflict: [], inProgress: [], tokenMismatch: [],
    });
  });

  it("lost claim, winner has a different body: 409 with NO conflict metric and NO audit (current behaviour)", async () => {
    script.findOrCreate.push(async () => MISS, async () => ({ hit: "collision" }));
    script.claim.push("conflict");
    const res = await post("/catalog/unknown-items");
    expect(res.status).toBe(409);
    expect(res.body).toEqual(errorBody("idempotency_key_conflict", COLLISION_MESSAGE));
    expect(controller.calls).toBe(0);
    expect(marker.del).toHaveBeenCalledTimes(1);
    expect(metricCalls()).toEqual({ replay: [], conflict: [], inProgress: [], tokenMismatch: [] });
    expect(auditEnqueuer.enqueue).not.toHaveBeenCalled();
  });

  it("lost claim, winner still in flight: 425 with the in-progress metric", async () => {
    script.findOrCreate.push(async () => MISS, async () => ({ hit: "in_progress" }));
    script.claim.push("conflict");
    const res = await post("/char");
    expect(res.status).toBe(425);
    expect(res.body).toEqual({ error: "idempotency_in_progress", retryAfterSec: 2 });
    expect(marker.del).toHaveBeenCalledTimes(1);
    expect(metricCalls()).toEqual({
      replay: [], conflict: [], inProgress: [[{ route: "POST:/char" }]], tokenMismatch: [],
    });
  });

  it("lost claim, winner released: claims again and runs the handler once", async () => {
    script.findOrCreate.push(async () => MISS, async () => MISS);
    script.claim.push("conflict", "inserted");
    const res = await post("/char");
    await settle();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, n: 1 });
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(marker.del).toHaveBeenCalledTimes(2);
  });

  it("lost claim on a non-replayable route: 409 non-replayable message + conflict metric", async () => {
    script.findOrCreate.push(async () => MISS, async () => hit({ status: 201, body: { id: "r-1" } }));
    script.claim.push("conflict");
    const res = await post("/char-forbid");
    expect(res.status).toBe(409);
    expect(res.body).toEqual(errorBody("idempotency_key_conflict", NON_REPLAYABLE_MESSAGE));
    expect(marker.del).toHaveBeenCalledTimes(1);
    expect(metricCalls()).toEqual({
      replay: [], conflict: [[{ route: "POST:/char-forbid" }]], inProgress: [], tokenMismatch: [],
    });
  });

  // -------------------------------------------------------------------------
  // Non-replayable route (K3)
  // -------------------------------------------------------------------------

  it("non-replayable route, fresh: client gets the real body, store keeps only the marker", async () => {
    script.findOrCreate.push(async () => MISS);
    script.claim.push("inserted");
    const res = await post("/char-forbid");
    await settle();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "r-1", secret: "s3cret" });
    const saved = store.save.mock.calls[0]?.[5] as StoredResult;
    expect(saved.status).toBe(201);
    expect(JSON.stringify(saved.body)).not.toContain("s3cret");
  });

  it("non-replayable route, completed key: 409 non-replayable message + conflict metric, never a 2xx", async () => {
    script.findOrCreate.push(async () => hit({ status: 201, body: { id: "r-1" } }));
    const res = await post("/char-forbid");
    expect(res.status).toBe(409);
    expect(res.body).toEqual(errorBody("idempotency_key_conflict", NON_REPLAYABLE_MESSAGE));
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(controller.calls).toBe(0);
    expect(marker.del).toHaveBeenCalledWith(tuple("/char-forbid"));
    expect(marker.del).toHaveBeenCalledTimes(2);
    expect(metricCalls()).toEqual({
      replay: [], conflict: [[{ route: "POST:/char-forbid" }]], inProgress: [], tokenMismatch: [],
    });
  });

  it("store in_progress on a param route: 425 and NO legacy-key probe", async () => {
    script.findOrCreate.push(async () => ({ hit: "in_progress" }));
    const res = await post(`/char/${RESOURCE}/act`);
    expect(res.status).toBe(425);
    expect(res.body).toEqual({ error: "idempotency_in_progress", retryAfterSec: 2 });
    expect(store.findOrCreate).toHaveBeenCalledTimes(1);
    expect(marker.del).toHaveBeenCalledTimes(1);
    expect(metricCalls()).toEqual({
      replay: [], conflict: [], inProgress: [[{ route: "POST:/char/:id/act" }]], tokenMismatch: [],
    });
  });

  it("replay on a param route: stored result and NO legacy-key probe", async () => {
    script.findOrCreate.push(async () => hit({ status: 201, body: { ok: true, n: 9 } }));
    const res = await post(`/char/${RESOURCE}/act`);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, n: 9 });
    expect(store.findOrCreate).toHaveBeenCalledTimes(1);
    expect(marker.del).toHaveBeenCalledTimes(1);
    expect(metricCalls()).toEqual({
      replay: [[{ route: "POST:/char/:id/act" }]], conflict: [], inProgress: [], tokenMismatch: [],
    });
  });

  it("stored non-replayable marker on a normal route: 409, never replayed", async () => {
    script.findOrCreate.push(async () =>
      hit({ status: 201, body: nonReplayableMarker({ id: "r-1", secret: "x" }, ["id"]) }));
    const res = await post("/char");
    expect(res.status).toBe(409);
    expect(res.body).toEqual(errorBody("idempotency_key_conflict", NON_REPLAYABLE_MESSAGE));
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(controller.calls).toBe(0);
    expect(marker.del).toHaveBeenCalledTimes(2);
    expect(metricCalls()).toEqual({
      replay: [], conflict: [[{ route: "POST:/char" }]], inProgress: [], tokenMismatch: [],
    });
  });

  // -------------------------------------------------------------------------
  // Store and handler errors
  // -------------------------------------------------------------------------

  it("store error on lookup: 500, marker released, handler not run, no metrics", async () => {
    script.findOrCreate.push(async () => {
      throw new Error("redis down");
    });
    const res = await post("/char");
    expect(res.status).toBe(500);
    expect(res.body).toEqual(errorBody("internal_error", "Internal Server Error"));
    expect(controller.calls).toBe(0);
    expect(marker.del).toHaveBeenCalledWith(tuple("/char"));
    expect(marker.del).toHaveBeenCalledTimes(1);
    expect(metricCalls()).toEqual({ replay: [], conflict: [], inProgress: [], tokenMismatch: [] });
  });

  it("store error with a failing marker cleanup: the ORIGINAL error surfaces", async () => {
    script.findOrCreate.push(async () => {
      throw new HttpException("teapot", 418);
    });
    marker.del.mockRejectedValueOnce(new Error("redis down on del"));
    const res = await post("/char");
    expect(res.status).toBe(418);
    expect(controller.calls).toBe(0);
    expect(marker.del).toHaveBeenCalledTimes(1);
  });

  // CURRENT BEHAVIOUR, pinned on purpose: `handle` returns `runFresh(...)`
  // without awaiting it inside its try, so a claim rejection skips the
  // catch and the in-progress marker is NOT released (it expires by TTL).
  // A decomposition must not silently change this; changing it is a
  // separate, reviewed fix.
  it("store error on claim: 500, handler not run, marker NOT released (left to its TTL)", async () => {
    script.findOrCreate.push(async () => MISS);
    store.claim.mockRejectedValueOnce(new Error("pg down"));
    const res = await post("/char");
    expect(res.status).toBe(500);
    expect(res.body).toEqual(errorBody("internal_error", "Internal Server Error"));
    expect(controller.calls).toBe(0);
    expect(marker.trySet).toHaveBeenCalledWith(tuple("/char"), expect.any(Number));
    expect(marker.del).not.toHaveBeenCalled();
  });

  it("handler error: claim released, error surfaces, nothing saved, marker cleared", async () => {
    script.findOrCreate.push(async () => MISS);
    script.claim.push("inserted");
    controller.fail = new Error("handler boom");
    const res = await post("/char");
    await settle();
    expect(res.status).toBe(500);
    expect(res.body).toEqual(errorBody("internal_error", "Internal Server Error"));
    expect(store.releaseClaim).toHaveBeenCalledWith({
      tenantId: TENANT, storeId: null, clientId: USER, key: storeKey("/char"),
    });
    expect(store.save).not.toHaveBeenCalled();
    expect(marker.del).toHaveBeenCalledWith(tuple("/char"));
    expect(marker.del).toHaveBeenCalledTimes(1);
  });

  it("save failure: response still returned and the degradation is warn-logged", async () => {
    script.findOrCreate.push(async () => MISS);
    script.claim.push("inserted");
    store.save.mockRejectedValueOnce(new Error("save failed"));
    const res = await post("/char");
    await settle();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, n: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ route: "POST:/char", key_fingerprint: expect.any(String) }),
      "IdempotencyInterceptor: replay-record save failed; idempotency degraded (response returned, retry may re-execute handler)",
    );
  });
});
