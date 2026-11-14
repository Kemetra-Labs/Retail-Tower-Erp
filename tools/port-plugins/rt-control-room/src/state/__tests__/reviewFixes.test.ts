import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortClient } from "../../api/portClient";
import { fetchSnapshot } from "../fetchSnapshot";
import { isSilent, SILENT_AFTER_MS } from "../useBoard";
import { NOW, fakeClient } from "./testkit";

// Fixes from the 2026-11-14 expert review of RT-1381.

const sentryRules = (client: ReturnType<typeof fakeClient>) =>
  client.searches.filter((c) => c.blueprint === "sentryIssue").map((c) => JSON.stringify(c.query.rules));

describe("Sentry reads", () => {
  it("a full read filters unresolved on the server", async () => {
    const client = fakeClient({});
    await fetchSnapshot(client, null, true, { now: NOW });
    expect(sentryRules(client).join()).toContain('"status"');
  });

  it("a delta read does not filter on status, so an issue resolved since the last poll comes back and clears", async () => {
    const client = fakeClient({});
    const since = new Date(NOW.getTime() - 60_000).toISOString();
    await fetchSnapshot(client, since, false, { now: NOW, neverRead: new Set() });
    const rules = sentryRules(client).join();
    expect(rules).not.toContain('"status"');
    expect(rules).toContain('"$updatedAt"');
  });
});

describe("Port requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("every request carries an abort signal, so a hung request fails instead of hanging the poll", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response("[]", { status: 200 });
    });
    const client = createPortClient("https://api.getport.io", () => "t", () => {});
    await client.get("/v1/integration");
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("silent board", () => {
  it("turns stale when no good core read arrived for two poll intervals", () => {
    const t0 = 1_000_000;
    expect(isSilent(null, t0)).toBe(false);
    expect(isSilent(t0, t0 + SILENT_AFTER_MS)).toBe(false);
    expect(isSilent(t0, t0 + SILENT_AFTER_MS + 1)).toBe(true);
  });
});
