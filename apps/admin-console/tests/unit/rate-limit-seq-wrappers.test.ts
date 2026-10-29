import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// The generated client reads its base URL and its fetch at import, so both are set first
// (node cannot build a Request from "/"). `answer` is what the stubbed network returns.
const net = vi.hoisted(() => {
  vi.stubEnv("VITE_API_BASE_URL", "http://console.test");
  const state = { answer: (): Response => new Response("[]", { status: 200 }) };
  vi.stubGlobal("fetch", async () => state.answer());
  return state;
});

import { apiClient } from "@/generated/client";
import {
  getRateLimitState,
  installRateLimitTracking,
  rateLimitSeqOf,
  reportRateLimited,
  resetRateLimit,
} from "@/lib/rate-limit";
import { listTenants } from "@/lib/rf2-queries";
import { openSupportSession } from "@/lib/support-session-queries";

/**
 * RT-940: the two wrappers the platform surfaces claim a 429 from hand back the
 * `seq` the middleware recorded for THEIR response. The real chain, with the
 * real generated client and the real rate-limit middleware: only the network is
 * stubbed.
 */
beforeAll(() => {
  installRateLimitTracking(apiClient);
});
beforeEach(() => {
  resetRateLimit();
});

const tooMany = () =>
  new Response(JSON.stringify({ error: { code: "rate_limited", message: "x" } }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "5" },
  });
const json = (status: number, body: unknown = []) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const OPEN_BODY = { tenant_id: "0190f000-0000-7000-8000-0000000000d1", purpose: "incident" };

describe.each([
  ["listTenants", () => listTenants()],
  ["openSupportSession", () => openSupportSession(OPEN_BODY as never)],
])("%s", (_name, call) => {
  test("a 429 returns its own seq, even after another 429 lands before the caller looks", async () => {
    net.answer = tooMany;
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.rateLimitSeq).toBe(1);

    // The session bar's request is answered 429 after this one's response is in hand.
    reportRateLimited(5);
    expect(getRateLimitState().seq).toBe(2);
    expect(res.rateLimitSeq).toBe(1);
  });

  test("a response that is not a 429 carries no seq", async () => {
    net.answer = () => json(200);
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.rateLimitSeq).toBeUndefined();
    expect(getRateLimitState().seq).toBe(0);
  });
});

test("rateLimitSeqOf knows only the responses the middleware saw", () => {
  expect(rateLimitSeqOf(tooMany())).toBeUndefined();
});
