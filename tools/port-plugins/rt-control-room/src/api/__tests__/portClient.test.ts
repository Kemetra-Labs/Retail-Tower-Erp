import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPortClient, type PortQuery } from "../portClient";

const BASE = "https://api.getport.io";
const QUERY: PortQuery = {
  combinator: "and",
  rules: [{ property: "$blueprint", operator: "=", value: "service" }],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sentBody(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
}

describe("createPortClient", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows next cursors, sends each as from, and concatenates entities", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ ok: true, entities: [{ identifier: "a" }], next: "c1" }))
      .mockResolvedValueOnce(json({ ok: true, entities: [{ identifier: "b" }], next: "c2" }))
      .mockResolvedValueOnce(json({ ok: true, entities: [{ identifier: "c" }] }));
    const client = createPortClient(BASE, () => "tok", vi.fn());
    const out = await client.search<{ identifier: string }>("service", QUERY);
    expect(out.map((e) => e.identifier)).toEqual(["a", "b", "c"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map(sentBody);
    expect(bodies[0].from).toBeUndefined();
    expect(bodies[1].from).toBe("c1");
    expect(bodies[2].from).toBe("c2");
  });

  it("posts to the blueprint search path with the query nested and limit 1000", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, entities: [] }));
    const client = createPortClient(`${BASE}/`, () => "tok", vi.fn());
    await client.search("sentryIssue", QUERY, { include: ["title", "properties.status"] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(`${BASE}/v1/blueprints/sentryIssue/entities/search`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(sentBody(fetchMock.mock.calls[0])).toEqual({
      query: QUERY,
      limit: 1000,
      include: ["title", "properties.status"],
    });
  });

  it("honours an explicit limit", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, entities: [] }));
    const client = createPortClient(BASE, () => "tok", vi.fn());
    await client.search("service", QUERY, { limit: 50 });
    expect(sentBody(fetchMock.mock.calls[0]).limit).toBe(50);
  });

  it("on 401 calls onUnauthorized exactly once and rejects with Unauthorized", async () => {
    fetchMock.mockResolvedValue(json({ ok: false, error: "unauthorized" }, 401));
    const onUnauthorized = vi.fn();
    const client = createPortClient(BASE, () => "tok", onUnauthorized);
    await expect(client.search("service", QUERY)).rejects.toThrow("Unauthorized");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("on 401 in a later page still calls onUnauthorized once and stops paging", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ ok: true, entities: [{ identifier: "a" }], next: "c1" }))
      .mockResolvedValueOnce(json({}, 401));
    const onUnauthorized = vi.fn();
    const client = createPortClient(BASE, () => "tok", onUnauthorized);
    await expect(client.search("service", QUERY)).rejects.toThrow("Unauthorized");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects without calling the network when no token is available", async () => {
    const client = createPortClient(BASE, () => null, vi.fn());
    await expect(client.search("service", QUERY)).rejects.toThrow("No Port token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces non-401 failures by status only, never the token or body", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "tok-secret leaked" }, 403));
    const onUnauthorized = vi.fn();
    const client = createPortClient(BASE, () => "tok-secret", onUnauthorized);
    const err = await client.search("service", QUERY).catch((e: Error) => e);
    expect((err as Error).message).toBe("Port API 403");
    expect((err as Error).message).not.toContain("tok-secret");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("stops if the host repeats a cursor instead of looping forever", async () => {
    fetchMock.mockImplementation(async () =>
      json({ ok: true, entities: [{ identifier: "a" }], next: "same" }),
    );
    const client = createPortClient(BASE, () => "tok", vi.fn());
    await expect(client.search("service", QUERY)).rejects.toThrow("Port API paging did not advance");
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("get issues an authorised GET and returns the parsed body", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, integrations: [] }));
    const client = createPortClient(BASE, () => "tok", vi.fn());
    const out = await client.get<{ integrations: unknown[] }>("/v1/integration");
    expect(out.integrations).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(`${BASE}/v1/integration`);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("get on 401 calls onUnauthorized once and rejects with Unauthorized", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401));
    const onUnauthorized = vi.fn();
    const client = createPortClient(BASE, () => "tok", onUnauthorized);
    await expect(client.get("/v1/integration")).rejects.toThrow("Unauthorized");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("get rejects a path that is not an absolute API path", async () => {
    const client = createPortClient(BASE, () => "tok", vi.fn());
    await expect(client.get("//evil.com/x")).rejects.toThrow("Invalid Port API path");
    await expect(client.get("v1/integration")).rejects.toThrow("Invalid Port API path");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
