import { vi } from "vitest";
import raw from "../../model/__tests__/fixtures/snapshot-2026-11-13.json";
import type { PortClient, PortQuery } from "../../api/portClient";
import { PortApiError } from "../../api/portClient";
import type { Snapshot } from "../../model/types";

/** The fixture's own fetchedAt. */
export const NOW = new Date("2026-11-13T12:30:00Z");
export const BASE_URL = "https://api.getport.io";

/** A fresh copy per test: the imported JSON module object is shared. */
export const fixture = (): Snapshot => structuredClone(raw) as unknown as Snapshot;

export const BLUEPRINT_KEY = {
  service: "services",
  workload: "workloads",
  datadogHost: "hosts",
  sentryIssue: "sentryIssues",
  datadogMonitor: "monitors",
  jiraIssue: "jira",
  githubPullRequest: "prs",
  githubWorkflowRun: "runs",
  deployment: "deployments",
} as const;

export type Blueprint = keyof typeof BLUEPRINT_KEY;
export type Call = { blueprint: string; body: Record<string, unknown>; query: PortQuery; at: number };

/**
 * A Port REST stand-in behind `fetch`. It answers each blueprint search with
 * `data[blueprint]` (mutate it between polls to play a delta) in a single page,
 * records every request body, and can fail a blueprint with a status.
 */
export function createFakePort(snapshot: Snapshot = fixture()) {
  const data: Record<string, unknown[]> = {};
  for (const [blueprint, key] of Object.entries(BLUEPRINT_KEY)) data[blueprint] = snapshot[key] as unknown[];
  let integrations: unknown = snapshot.integrations;
  const failing = new Map<string, number>();
  let failAllStatus: number | null = null;
  const calls: Call[] = [];
  const gets: string[] = [];

  const answer = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const search = /^\/v1\/blueprints\/([^/]+)\/entities\/search$/.exec(path);
    const key = search ? decodeURIComponent(search[1]) : "integration";
    const status = failAllStatus ?? failing.get(key);
    if (search) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ blueprint: key, body, query: body.query as PortQuery, at: Date.now() });
    } else {
      gets.push(path);
    }
    if (status !== undefined && status !== null) return answer(status, { ok: false });
    if (search) return answer(200, { ok: true, entities: data[key] ?? [], next: null });
    if (integrations === "forbidden") return answer(403, { ok: false });
    return answer(200, { ok: true, integrations });
  });

  return {
    data,
    calls,
    gets,
    fetchFn,
    install: () => vi.stubGlobal("fetch", fetchFn),
    set: (blueprint: Blueprint, entities: unknown[]) => {
      data[blueprint] = entities;
    },
    setIntegrations: (value: unknown) => {
      integrations = value;
    },
    fail: (key: Blueprint | "integration", status: number) => failing.set(key, status),
    heal: (key: Blueprint | "integration") => failing.delete(key),
    failAll: (status: number) => {
      failAllStatus = status;
    },
    healAll: () => {
      failAllStatus = null;
      failing.clear();
    },
    callsFor: (blueprint: Blueprint) => calls.filter((c) => c.blueprint === blueprint),
  };
}

export type FakePort = ReturnType<typeof createFakePort>;

/** A PortClient over the same stand-in data, for fetchSnapshot unit tests (no fetch). */
export function fakeClient(
  data: Partial<Record<Blueprint, unknown[] | Error>>,
  integrations: unknown = [],
): PortClient & { searches: Call[] } {
  const searches: Call[] = [];
  return {
    searches,
    async search<T>(blueprint: string, query: PortQuery): Promise<T[]> {
      searches.push({ blueprint, body: { query }, query, at: Date.now() });
      const value = data[blueprint as Blueprint];
      if (value instanceof Error) throw value;
      return (value ?? []) as T[];
    },
    async get<T>(): Promise<T> {
      if (integrations instanceof Error) throw integrations;
      return integrations as T;
    },
  };
}

export const httpError = (status: number): PortApiError => new PortApiError(`Port API ${status}`, status);

type FakeObserver = { fire(isIntersecting: boolean): void };
/** The IntersectionObserver stubs of vitest.setup.ts that are still connected. */
export const observers = (): FakeObserver[] =>
  (globalThis as unknown as { __fakeObservers?: FakeObserver[] }).__fakeObservers ?? [];
