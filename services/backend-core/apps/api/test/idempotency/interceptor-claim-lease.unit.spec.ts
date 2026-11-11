/**
 * RT-1325 (RT-1125 R-03) — the in-flight claim never outlives its purpose
 * silently.
 *
 *   - failed release: when the handler fails and the claim release fails too,
 *     the client still gets the handler's own error (not the release error),
 *     and the leftover claim is warn-logged with when it expires;
 *   - failed save: when the handler succeeded but the replay record could not
 *     be saved, the response stands and the warn-log says how long the claim
 *     still answers 425.
 *
 * Docker-free: the store and marker are fakes; the handler is a tiny route.
 */
import "reflect-metadata";
import {
  Controller,
  HttpException,
  HttpStatus,
  Post,
  Res,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";

import type { IdempotencyKeyStore, Logger } from "@data-pulse-2/shared";

import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { Idempotent } from "../../src/idempotency/idempotent.decorator";
import { IdempotencyInterceptor } from "../../src/idempotency/idempotency.interceptor";
import type { InProgressMarker } from "../../src/idempotency/in-progress-marker";

const KEY = "rt1325-aaaaaaaaaaaaaaaaaa";
const TENANT = "13250000-0000-4000-8000-000000000101";
const USER = "13250000-0000-4000-8000-000000000103";

const LEASE_SEC = 90;
const HOUR_MS = 60 * 60 * 1000;

@Controller()
class LeaseController {
  public fail: Error | null = null;
  public calls = 0;

  @Post("lease")
  @Idempotent("required")
  create(@Res({ passthrough: true }) res: Response): { ok: true } {
    this.calls += 1;
    if (this.fail) throw this.fail;
    res.status(HttpStatus.CREATED);
    return { ok: true };
  }

  @Post("leased")
  @Idempotent("required", { claimLeaseSec: LEASE_SEC })
  createLeased(@Res({ passthrough: true }) res: Response): { ok: true } {
    this.calls += 1;
    if (this.fail) throw this.fail;
    res.status(HttpStatus.CREATED);
    return { ok: true };
  }
}

describe("IdempotencyInterceptor claim lifetime (RT-1325, RT-1125 R-03)", () => {
  let app: INestApplication;
  let controller: LeaseController;
  const store = {
    findOrCreate: jest.fn(),
    claim: jest.fn(),
    releaseClaim: jest.fn(),
    save: jest.fn(),
  };
  const marker = { trySet: jest.fn(), del: jest.fn() };
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };

  beforeAll(async () => {
    const interceptor = new IdempotencyInterceptor(
      new Reflector(),
      store as unknown as IdempotencyKeyStore,
      marker as unknown as InProgressMarker,
      null,
      logger as unknown as Logger,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [LeaseController],
      providers: [{ provide: APP_INTERCEPTOR, useValue: interceptor }],
    }).compile();
    controller = moduleRef.get(LeaseController);
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use((req: Request, _res: Response, next: NextFunction) => {
      Object.assign(req, {
        context: { tenantId: TENANT, storeId: null, userId: USER },
        principal: { userId: USER },
        requestId: "req-lease-1",
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
    controller.fail = null;
    controller.calls = 0;
    store.findOrCreate.mockReset().mockResolvedValue({ hit: false, entry: null });
    store.claim.mockReset().mockResolvedValue("inserted");
    store.releaseClaim.mockReset().mockResolvedValue(undefined);
    store.save.mockReset().mockResolvedValue(undefined);
    marker.trySet.mockReset().mockResolvedValue(true);
    marker.del.mockReset().mockResolvedValue(undefined);
    logger.warn.mockReset();
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  }

  const post = (path = "/lease") =>
    request(app.getHttpServer()).post(path).set("Idempotency-Key", KEY).send({ a: 1 });

  function saveExpiries(): { replay: Date; claim: Date } {
    const call = store.save.mock.calls[0]!;
    return { replay: call[6] as Date, claim: call[7] as Date };
  }

  it("default route: the claim lifetime is unchanged (the claim expires with the 72 h replay record)", async () => {
    const before = Date.now();
    const res = await post();
    await settle();
    expect(res.status).toBe(201);
    const claim = claimExpiry().getTime();
    expect(claim).toBeGreaterThanOrEqual(before + 72 * HOUR_MS);
    expect(claim).toBeLessThanOrEqual(Date.now() + 72 * HOUR_MS);
    expect(saveExpiries().replay.getTime()).toBe(claim);
    expect(saveExpiries().claim.getTime()).toBe(claim);
  });

  it("opt-in route: the claim is a short lease, and the saved result still gets the full replay TTL", async () => {
    const before = Date.now();
    const res = await post("/leased");
    await settle();
    expect(res.status).toBe(201);
    const claim = claimExpiry().getTime();
    expect(claim).toBeGreaterThanOrEqual(before + LEASE_SEC * 1000);
    expect(claim).toBeLessThanOrEqual(Date.now() + LEASE_SEC * 1000);
    const { replay, claim: fence } = saveExpiries();
    expect(replay.getTime()).toBeGreaterThanOrEqual(before + 72 * HOUR_MS);
    // The completion is fenced to this request's own claim.
    expect(fence.getTime()).toBe(claim);
  });

  it("opt-in route: a failed handler releases only its own claim (fenced by the claim's expiry)", async () => {
    controller.fail = new Error("handler boom");
    await post("/leased");
    await settle();
    expect(store.releaseClaim).toHaveBeenCalledWith(
      expect.objectContaining({ claimExpiresAt: claimExpiry() }),
    );
  });

  it("app clock ahead of the database: a lost claim on a lapsed lease retries once, then answers 425", async () => {
    // findOrCreate (app clock) sees the claim as expired; the claim insert
    // (database now()) still sees it live. Without a bound this loops.
    store.claim.mockReset().mockResolvedValue("conflict");
    const res = await post("/leased");
    await settle();
    expect(res.status).toBe(425);
    expect(res.headers["retry-after"]).toBe("2");
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(controller.calls).toBe(0);
  });

  function claimExpiry(): Date {
    return (store.claim.mock.calls[0]?.[0] as { expiresAt: Date }).expiresAt;
  }

  it("failed release: the handler's own error reaches the client, and the leftover claim is logged", async () => {
    controller.fail = new HttpException({ code: "validation_failed", message: "bad" }, 422);
    store.releaseClaim.mockRejectedValueOnce(new Error("pg down"));
    const res = await post();
    await settle();
    expect(res.status).toBe(422);
    expect(store.releaseClaim).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "POST:/lease",
        key_fingerprint: expect.any(String),
        claim_expires_at: claimExpiry().toISOString(),
      }),
      expect.stringContaining("claim release failed"),
    );
    expect(marker.del).toHaveBeenCalledTimes(1);
  });

  it("failed release never logs the raw Idempotency-Key", async () => {
    controller.fail = new Error("handler boom");
    store.releaseClaim.mockRejectedValueOnce(new Error("pg down"));
    await post();
    await settle();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(KEY);
  });

  it("failed save: the response stands and the log says until when the claim answers 425", async () => {
    store.save.mockRejectedValueOnce(new Error("save failed"));
    const res = await post();
    await settle();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "POST:/lease",
        key_fingerprint: expect.any(String),
        claim_expires_at: claimExpiry().toISOString(),
      }),
      "IdempotencyInterceptor: replay-record save failed; idempotency degraded (response returned, retry may re-execute handler)",
    );
  });
});
