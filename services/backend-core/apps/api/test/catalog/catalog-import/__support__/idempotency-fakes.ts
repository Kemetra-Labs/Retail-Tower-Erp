/**
 * RT-1505 — the shared `IdempotencyInterceptor` over an in-memory Redis, for the import HTTP specs (the upload is
 * `@Idempotent("required")`). Only the store's backends are fake; the interceptor is the real one.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import type { Provider } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";

import { IDEMPOTENCY_KEY_STORE, IdempotencyInterceptor } from "../../../../src/idempotency/idempotency.interceptor";
import { INFLIGHT_REDIS, InProgressMarker } from "../../../../src/idempotency/in-progress-marker";

class FakeRedis {
  private readonly s = new Map<string, { value: string; expiresAt: number }>();
  async get(k: string): Promise<string | null> {
    const e = this.s.get(k);
    if (!e || Date.now() > e.expiresAt) return null;
    return e.value;
  }
  async set(k: string, v: string, o: { px: number }): Promise<unknown> {
    this.s.set(k, { value: v, expiresAt: Date.now() + o.px });
    return "OK";
  }
}

class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
}

export function idempotencyProviders(): Provider[] {
  const redis = new FakeRedis();
  const marker = new FakeMarker();
  const store = new IdempotencyKeyStore({
    redis,
    pgWriter: { async insert(): Promise<void> {} },
    pgReader: {
      async find(): Promise<null> {
        return null;
      },
    },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  return [
    { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
    { provide: INFLIGHT_REDIS, useValue: redis },
    { provide: InProgressMarker, useValue: marker },
    { provide: APP_INTERCEPTOR, useValue: new IdempotencyInterceptor(new Reflector(), store, marker as unknown as InProgressMarker) },
  ];
}
