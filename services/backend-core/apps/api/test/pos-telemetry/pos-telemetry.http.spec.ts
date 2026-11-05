/**
 * RT-1252 — the POS device telemetry tunnel over HTTP.
 *
 * A minimal Nest app mounts only the tunnel controller, with the real
 * GlobalExceptionFilter, the real RateLimiter over an in-memory Redis fake
 * and a fetch spy in place of the network. `PosDeviceAuthGuard` is replaced
 * by a stub that publishes the device scope exactly as the real guard does
 * (`posDeviceId` + `context`) for two known bearers and answers the generic
 * 401 otherwise; the real guard is covered by its own specs and by
 * `route-auth-markers.enforcement.spec.ts`. Supertest drives real requests.
 */
import "reflect-metadata";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { UnauthorizedException, type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { PosDeviceAuthGuard } from "../../src/auth/pos-device-auth.guard";
import { RateLimiter, type RedisLike } from "../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { ROOT_LOGGER } from "../../src/common/logging.interceptor";
import type { TenantContextRequest } from "../../src/context/types";
import { PosTelemetryController } from "../../src/pos-telemetry/pos-telemetry.controller";
import { POS_TELEMETRY_FETCH, PosTelemetryForwarder } from "../../src/pos-telemetry/pos-telemetry.forwarder";
import { POS_TELEMETRY_BUCKETS } from "../../src/pos-telemetry/pos-telemetry.limits";
import { mintFleetRefs } from "../../src/pos-telemetry/pos-telemetry.refs";

const PATH = "/api/pos/v1/telemetry/envelope";
const CONFIG_PATH = "/api/pos/v1/telemetry/config";
const POS_DSN = "https://poskey@o4500.ingest.de.sentry.io/4512";
const UPSTREAM = "https://o4500.ingest.de.sentry.io/api/4512/envelope/";
const REF_KEY = "k".repeat(40);
const EVENT_ID = "0123456789abcdef0123456789abcdef";

const DEVICE_A = {
  deviceId: "01928f3e-7b1c-7d2a-9e4f-0000000000a1",
  tenantId: "01928f3e-7b1c-7d2a-9e4f-0000000000c1",
  storeId: "01928f3e-7b1c-7d2a-9e4f-0000000000d1",
};
const DEVICE_B = { ...DEVICE_A, deviceId: "01928f3e-7b1c-7d2a-9e4f-0000000000a2", storeId: "01928f3e-7b1c-7d2a-9e4f-0000000000d2" };
const BEARERS: Record<string, typeof DEVICE_A> = { "token-a": DEVICE_A, "token-b": DEVICE_B };

/** Publishes the scope like `PosDeviceAuthGuard`; anything else is the generic 401. */
class StubDeviceGuard implements CanActivate {
  /** Publishes the known device's scope, or throws the generic 401. */
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<TenantContextRequest>();
    const auth = req.headers["authorization"];
    const device = typeof auth === "string" ? BEARERS[auth.replace(/^Bearer /, "")] : undefined;
    if (device === undefined) throw new UnauthorizedException("Unauthorized");
    req.posDeviceId = device.deviceId;
    req.context = { tenantId: device.tenantId, storeId: device.storeId } as NonNullable<TenantContextRequest["context"]>;
    return true;
  }
}

/** An in-memory window counter standing in for Redis. */
class MapRedis implements RedisLike {
  readonly store = new Map<string, number>();
  /** Increments a counter in a fixed window. */
  async incrWindow(key: string): Promise<{ count: number; ttlMs: number }> {
    const next = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, next);
    return { count: next, ttlMs: 42_000 };
  }
  /** A fixed remaining window. */
  async pttl(): Promise<number> {
    return 42_000;
  }
  /** Decrements a counter. */
  async decr(key: string): Promise<number> {
    const next = (this.store.get(key) ?? 0) - 1;
    this.store.set(key, next);
    return next;
  }
  /** Deletes a counter. */
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

/** Records the bucket keys in call order; the fleet's global bucket is already spent. */
class GlobalSpentRedis extends MapRedis {
  readonly keys: string[] = [];
  override async incrWindow(key: string): Promise<{ count: number; ttlMs: number }> {
    this.keys.push(key);
    if (key.includes("pos_telemetry_global")) return { count: 1_000_000, ttlMs: 42_000 };
    return super.incrWindow(key);
  }
}

/** A rate-limit store that is unavailable. */
class BrokenRedis extends MapRedis {
  override async incrWindow(): Promise<{ count: number; ttlMs: number }> {
    throw new Error("redis down");
  }
}

interface Harness {
  app: INestApplication;
  fetchSpy: jest.Mock;
  warn: jest.Mock;
}

interface EventOptions {
  readonly captureTerminal?: string | null;
  readonly value?: string;
  readonly tags?: Record<string, string>;
}

/** A Sentry envelope with one error event captured under DEVICE_A unless told otherwise. */
function envelope(options: EventOptions = {}): string {
  const capture = options.captureTerminal === undefined ? DEVICE_A.deviceId : options.captureTerminal;
  const event = JSON.stringify({
    event_id: EVENT_ID,
    platform: "node",
    level: "error",
    release: "abcdef012345",
    server_name: "TILL-PC-OWNER",
    user: { email: "owner@example.com" },
    tags: { version: "abcdef012345", ...(capture === null ? {} : { capture_terminal_id: capture }), ...options.tags },
    exception: { values: [{ type: "Error", value: options.value ?? "boom for owner@example.com" }] },
  });
  return [
    JSON.stringify({ event_id: EVENT_ID, sent_at: "2026-11-05T10:00:00Z", dsn: "https://evil@o1.ingest.us.sentry.io/1" }),
    JSON.stringify({ type: "event", length: Buffer.byteLength(event) }),
    event,
    "",
  ].join("\n");
}

const ENV_KEYS = ["POS_SENTRY_DSN", "POS_TELEMETRY_REF_KEY", "SENTRY_ENVIRONMENT", "DEPLOYMENT_ENVIRONMENT"] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

/** Sets exactly the given tunnel env values and unsets the others. */
function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Boots the tunnel controller with the given env and store, a fetch spy and the stub guard. */
async function boot(
  env: Partial<Record<(typeof ENV_KEYS)[number], string>> = { POS_SENTRY_DSN: POS_DSN, POS_TELEMETRY_REF_KEY: REF_KEY, SENTRY_ENVIRONMENT: "staging" },
  redis: MapRedis = new MapRedis(),
): Promise<Harness> {
  setEnv(env);
  const fetchSpy = jest.fn().mockResolvedValue({ status: 200, body: null });
  const warn = jest.fn();
  const moduleRef = await Test.createTestingModule({
    controllers: [PosTelemetryController],
    providers: [
      PosTelemetryForwarder,
      { provide: PosDeviceAuthGuard, useValue: {} },
      { provide: POS_TELEMETRY_FETCH, useValue: fetchSpy },
      { provide: RateLimiter, useValue: new RateLimiter(redis) },
      { provide: ROOT_LOGGER, useValue: { warn, info: jest.fn(), error: jest.fn() } },
    ],
  })
    .overrideGuard(PosDeviceAuthGuard)
    .useValue(new StubDeviceGuard())
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  return { app, fetchSpy, warn };
}

/** POSTs an envelope with a device bearer. */
function post(h: Harness, body: string | Buffer, bearer = "token-a", contentType = "text/plain;charset=UTF-8") {
  return request(h.app.getHttpServer())
    .post(PATH)
    .set("Authorization", `Bearer ${bearer}`)
    .set("Content-Type", contentType)
    .send(body);
}

/** Lets the fire-and-forget forward run. */
async function settle(): Promise<void> {
  await new Promise((resolveTick) => setImmediate(resolveTick));
}

/** The single event the spy forwarded. */
function forwardedEvent(spy: jest.Mock): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  const [url, init] = spy.mock.calls[0] as [string, { body: Buffer }];
  expect(url).toBe(UPSTREAM);
  const lines = init.body.toString("utf8").split("\n");
  return JSON.parse(lines[2]!) as Record<string, unknown>;
}

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.app.close();
  harness = null;
  setEnv(ORIGINAL_ENV as Partial<Record<(typeof ENV_KEYS)[number], string>>);
});

describe("POS telemetry auth", () => {
  it("answers the generic 401 without a device bearer, on both routes", async () => {
    harness = await boot();
    await request(harness.app.getHttpServer()).get(CONFIG_PATH).expect(401);
    await post(harness, envelope(), "unknown-token").expect(401);
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POS telemetry config", () => {
  it("answers 200 no-store with the tunnel and environment, never a DSN", async () => {
    harness = await boot();
    const res = await request(harness.app.getHttpServer()).get(CONFIG_PATH).set("Authorization", "Bearer token-a").expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ enabled: true, tunnel: PATH, environment: "staging" });
    expect(JSON.stringify(res.body)).not.toContain("poskey");
  });

  it.each([
    ["no DSN", { POS_TELEMETRY_REF_KEY: REF_KEY }],
    ["no ref key", { POS_SENTRY_DSN: POS_DSN }],
    ["a ref key under 32 characters", { POS_SENTRY_DSN: POS_DSN, POS_TELEMETRY_REF_KEY: "short" }],
    ["a malformed DSN", { POS_SENTRY_DSN: "not-a-dsn", POS_TELEMETRY_REF_KEY: REF_KEY }],
  ])("answers 204 no-store when inert (%s)", async (_label, env) => {
    harness = await boot(env);
    const res = await request(harness.app.getHttpServer()).get(CONFIG_PATH).set("Authorization", "Bearer token-a").expect(204);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("never logs the DSN or the key when refusing them", async () => {
    harness = await boot({ POS_SENTRY_DSN: POS_DSN, POS_TELEMETRY_REF_KEY: "tiny-secret-value" });
    const logged = JSON.stringify(harness.warn.mock.calls);
    expect(logged).toContain("POS_TELEMETRY_REF_KEY");
    expect(logged).not.toContain("poskey");
    expect(logged).not.toContain("tiny-secret-value");
  });
});

describe("POS telemetry envelope", () => {
  it("is a 204 no-op when inert, without reading the body", async () => {
    harness = await boot({ POS_TELEMETRY_REF_KEY: REF_KEY });
    await post(harness, "not an envelope").expect(204);
    await settle();
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards the scrubbed event with service=pos and the device's refs, and no raw ids", async () => {
    harness = await boot();
    await post(harness, envelope()).expect(204);
    await settle();
    const event = forwardedEvent(harness.fetchSpy);
    expect(event["tags"]).toEqual({
      service: "pos",
      version: "abcdef012345",
      ...mintFleetRefs(REF_KEY, DEVICE_A),
    });
    expect(event["release"]).toBe("abcdef012345");
    expect(event["environment"]).toBe("staging");
    expect(event).not.toHaveProperty("user");
    expect(event).not.toHaveProperty("server_name");
    const raw = harness.fetchSpy.mock.calls[0]![1].body.toString("utf8") as string;
    for (const id of Object.values(DEVICE_A)) expect(raw).not.toContain(id);
    expect(raw).not.toContain("owner@example.com");
    expect(raw).not.toContain("evil@");
  });

  it("discards client-sent refs and raw ids and stamps the server's", async () => {
    harness = await boot();
    const forged = { tenant_ref: "forged", store_ref: "forged", terminal_ref: "forged", tenant_id: DEVICE_B.tenantId, user_id: "u1", service: "x" };
    await post(harness, envelope({ tags: forged })).expect(204);
    await settle();
    const tags = forwardedEvent(harness.fetchSpy)["tags"] as Record<string, string>;
    expect(tags).toEqual({ service: "pos", version: "abcdef012345", ...mintFleetRefs(REF_KEY, DEVICE_A) });
  });

  it("stamps each device's own refs (two stores filter apart)", async () => {
    harness = await boot();
    await post(harness, envelope({ captureTerminal: DEVICE_B.deviceId }), "token-b").expect(204);
    await settle();
    const tags = forwardedEvent(harness.fetchSpy)["tags"] as Record<string, string>;
    expect(tags["store_ref"]).toBe(mintFleetRefs(REF_KEY, DEVICE_B).store_ref);
    expect(tags["store_ref"]).not.toBe(mintFleetRefs(REF_KEY, DEVICE_A).store_ref);
  });

  it.each([
    ["missing", null],
    ["another device's id (captured before a move or re-pair)", DEVICE_B.deviceId],
  ])("drops an event whose capture_terminal_id is %s, still 204 (R1)", async (_label, capture) => {
    harness = await boot();
    await post(harness, envelope({ captureTerminal: capture })).expect(204);
    await settle();
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it("limits per device: a noisy terminal gets 429 while another terminal is still forwarded", async () => {
    harness = await boot();
    for (let i = 0; i < POS_TELEMETRY_BUCKETS.perDevice.limit; i += 1) await post(harness, envelope()).expect(204);
    const res = await post(harness, envelope()).expect(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    harness.fetchSpy.mockClear();
    await post(harness, envelope({ captureTerminal: DEVICE_B.deviceId }), "token-b").expect(204);
    await settle();
    expect(harness.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("checks the device budget first, then the fleet's global budget (429 when it is spent)", async () => {
    const redis = new GlobalSpentRedis();
    harness = await boot(undefined, redis);
    const res = await post(harness, envelope()).expect(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(redis.keys).toHaveLength(2);
    expect(redis.keys[0]).toContain("pos_telemetry_device");
    expect(redis.keys[0]).toContain(DEVICE_A.deviceId);
    expect(redis.keys[1]).toContain("pos_telemetry_global");
    await settle();
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it("replaces the device's raw ids inside messages and frames with their refs", async () => {
    harness = await boot();
    const value = `GET https://api.example.invalid/devices/${DEVICE_A.deviceId.toUpperCase()}/stores/${DEVICE_A.storeId} for ${DEVICE_A.tenantId} failed`;
    await post(harness, envelope({ value })).expect(204);
    await settle();
    const raw = harness.fetchSpy.mock.calls[0]![1].body.toString("utf8") as string;
    for (const id of Object.values(DEVICE_A)) expect(raw.toLowerCase()).not.toContain(id);
    const refs = mintFleetRefs(REF_KEY, DEVICE_A);
    const message = (forwardedEvent(harness.fetchSpy)["exception"] as { values: Array<{ value: string }> }).values[0]!.value;
    expect(message).toContain(refs.terminal_ref);
    expect(message).toContain(refs.store_ref);
  });

  it("drops quietly (204, nothing forwarded) when the rate-limit store is unavailable", async () => {
    harness = await boot(undefined, new BrokenRedis());
    await post(harness, envelope()).expect(204);
    await settle();
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a JSON body (415), an oversized body (413) and a malformed envelope (400)", async () => {
    harness = await boot();
    await post(harness, "{}", "token-a", "application/json").expect(415);
    await post(harness, Buffer.alloc(64 * 1024 + 1, 0x61), "token-a", "application/octet-stream").expect(413);
    const bad = await post(harness, "not json\n").expect(400);
    expect(bad.body.error.code).toBe("envelope_malformed");
    expect(JSON.stringify(bad.body)).not.toContain("not json");
  });
});

interface GoldenVector {
  readonly id: string;
  readonly input: string;
  readonly expected: string;
}

const GOLDEN = JSON.parse(
  readFileSync(resolve(__dirname, "..", "..", "..", "..", "packages", "shared", "__tests__", "observability", "obs1-golden-vectors.json"), "utf8"),
) as { vectors: GoldenVector[] };

describe("OBS-1 §3.5 golden vectors on the POS tunnel path", () => {
  it.each(GOLDEN.vectors.map((v) => [v.id, v] as const))("%s", async (_id, vector) => {
    harness = await boot();
    await post(harness, envelope({ value: vector.input })).expect(204);
    await settle();
    const exception = forwardedEvent(harness.fetchSpy)["exception"] as { values: Array<{ value: string }> };
    expect(exception.values[0]!.value).toBe(vector.expected);
  });
});
