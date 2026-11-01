import { afterEach, describe, expect, test, vi } from "vitest";

// The generated client reads its base URL and its fetch at import, so both are set
// first. Every request is captured; `answer` is what the stubbed network returns.
const net = vi.hoisted(() => {
  vi.stubEnv("VITE_API_BASE_URL", "http://console.test");
  const state = {
    requests: [] as Request[],
    answer: (): Response =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  };
  vi.stubGlobal("fetch", async (input: Request) => {
    state.requests.push(input);
    return state.answer();
  });
  return state;
});

import {
  consoleDeleteTenantLogo,
  consoleGetTenantLogo,
  consolePreviewTenantLogo,
  consolePutTenantLogo,
} from "@/lib/tenant-branding-queries";
import { TENANT_ID, VERSION_B } from "./branding-fixtures";

/**
 * RT-474: the four Console wrappers over the v0.3.3 tenant-branding contract,
 * through the real generated client (only the network is stubbed). The upload is
 * the raw file bytes under `application/octet-stream` (contract: "Admin-Console
 * sends application/octet-stream"), never a JSON-encoded body: the RT-473 #430
 * failure mode.
 */
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const file = () => new File([bytes], "logo.png", { type: "image/png" });

afterEach(() => {
  net.requests.length = 0;
});

async function bodyOf(request: Request): Promise<Uint8Array> {
  return new Uint8Array(await request.arrayBuffer());
}

describe("tenant branding wrappers", () => {
  test("read: GET the tenant's logo path", async () => {
    await consoleGetTenantLogo(TENANT_ID);
    const [req] = net.requests;
    expect(req.method).toBe("GET");
    expect(new URL(req.url).pathname).toBe(`/api/v1/tenants/${TENANT_ID}/logo`);
  });

  test("preview: POST the exact file bytes as application/octet-stream", async () => {
    await consolePreviewTenantLogo(TENANT_ID, file());
    const [req] = net.requests;
    expect(req.method).toBe("POST");
    expect(new URL(req.url).pathname).toBe(`/api/v1/tenants/${TENANT_ID}/logo/preview`);
    expect(req.headers.get("content-type")).toBe("application/octet-stream");
    expect(await bodyOf(req)).toEqual(bytes);
  });

  test("save: PUT the bytes with preview_version and expected_revision", async () => {
    await consolePutTenantLogo(TENANT_ID, file(), {
      previewVersion: VERSION_B,
      expectedRevision: 3,
    });
    const [req] = net.requests;
    const url = new URL(req.url);
    expect(req.method).toBe("PUT");
    expect(url.pathname).toBe(`/api/v1/tenants/${TENANT_ID}/logo`);
    expect(url.searchParams.get("preview_version")).toBe(VERSION_B);
    expect(url.searchParams.get("expected_revision")).toBe("3");
    expect(req.headers.get("content-type")).toBe("application/octet-stream");
    expect(await bodyOf(req)).toEqual(bytes);
  });

  test("remove: DELETE with expected_revision and no body", async () => {
    await consoleDeleteTenantLogo(TENANT_ID, { expectedRevision: 0 });
    const [req] = net.requests;
    const url = new URL(req.url);
    expect(req.method).toBe("DELETE");
    expect(url.pathname).toBe(`/api/v1/tenants/${TENANT_ID}/logo`);
    expect(url.searchParams.get("expected_revision")).toBe("0");
    expect((await bodyOf(req)).length).toBe(0);
  });

  test("a 429 hands back status and Retry-After", async () => {
    net.answer = () =>
      new Response(JSON.stringify({ error: { code: "rate_limited", message: "x" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "7" },
      });
    const res = await consolePreviewTenantLogo(TENANT_ID, file());
    expect(res.status).toBe(429);
    expect(res.retryAfter).toBe("7");
  });

  test("the preview carries the caller's abort signal to the request", async () => {
    const controller = new AbortController();
    const pending = consolePreviewTenantLogo(TENANT_ID, file(), controller.signal);
    controller.abort();
    await pending.catch(() => undefined);
    const [req] = net.requests;
    expect(req.signal.aborted).toBe(true);
  });
});
