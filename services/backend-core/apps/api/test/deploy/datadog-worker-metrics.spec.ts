/**
 * RT-1281 — the Datadog agent can scrape the worker's load-diagnosis metrics.
 *
 * Pins docker-compose.prod.yml so a later edit cannot silently blind the queue
 * and outbox signals a load test depends on:
 *   - the worker's Prometheus listener binds the container network (not loopback)
 *     on 9091, is exposed only to the internal network, and publishes no host port;
 *   - the agent's OpenMetrics config has a worker instance that admits exactly
 *     the documented signals (signals.md §3) and nothing broader;
 *   - every admitted name is one the worker actually declares.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const serviceRoot = resolve(__dirname, "..", "..", "..", "..");

interface Service {
  environment?: Record<string, string>;
  expose?: string[];
  ports?: unknown[];
  networks?: string[];
  depends_on?: string[] | Record<string, unknown>;
}
interface Compose {
  services: Record<string, Service>;
  configs: { dd_openmetrics: { content: string } };
}
interface OpenMetricsInstance {
  openmetrics_endpoint: string;
  namespace: string;
  metrics: string[];
  tags: string[];
}

const compose = load(readFileSync(resolve(serviceRoot, "docker-compose.prod.yml"), "utf8")) as Compose;
const worker = compose.services["worker"]!;
const agent = compose.services["datadog-agent"]!;
const instances = (load(compose.configs.dd_openmetrics.content) as { instances: OpenMetricsInstance[] }).instances;
const workerInstance = instances.find((i) => i.openmetrics_endpoint === "http://worker:9091/metrics");

/** The load-diagnosis signals RT-1281 needs, as the worker names them. */
const REQUIRED = ["queue_lag_seconds", "outbox_pending_total"];
const ADMITTED = [
  ...REQUIRED,
  "worker_job_duration_seconds",
  "worker_processing_failure_total",
  "outbox_drain_duration_seconds",
  "db_pool_in_use",
  "db_pool_waiters",
];
/** Declared by the worker but deliberately not scraped (counters for later, not load diagnosis). */
const NOT_ADMITTED = [
  "queue_failed_total",
  "queue_dead_letter_total",
  "queue_retry_total",
  "outbox_dead_letter_total",
  "redis_command_duration_seconds",
  "db_slow_query_total",
  "erpnext_posting_reconciliation_total",
  "sale_redrive_total",
];

function admits(name: string): boolean {
  return workerInstance!.metrics.some((p) => new RegExp(p).test(name));
}

describe("RT-1281: worker metrics reach the Datadog agent", () => {
  it("binds the worker listener on the container network, port 9091", () => {
    expect(worker.environment?.["WORKER_METRICS_BIND_HOST"]).toBe("0.0.0.0");
    expect(worker.environment?.["WORKER_METRICS_PORT"]).toBe("9091");
  });

  it("exposes 9091 only to the internal network and publishes no host port", () => {
    expect(worker.expose).toEqual(["9091"]);
    expect(worker.ports).toBeUndefined();
    expect(worker.networks).toEqual(["dp2"]);
    expect(agent.networks).toEqual(["dp2"]);
  });

  it("starts the agent after the worker", () => {
    expect(agent.depends_on).toEqual(expect.arrayContaining(["api", "worker"]));
  });

  it("has a worker OpenMetrics instance tagged backend-worker under the dp2 namespace", () => {
    expect(workerInstance).toBeDefined();
    expect(workerInstance!.namespace).toBe("dp2");
    expect(workerInstance!.tags).toEqual(["service:backend-worker"]);
  });

  it.each(ADMITTED)("admits %s", (name) => {
    expect(admits(name)).toBe(true);
  });

  it.each(NOT_ADMITTED)("does not admit %s", (name) => {
    expect(admits(name)).toBe(false);
  });

  it("never uses a catch-all pattern", () => {
    for (const p of workerInstance!.metrics) {
      expect(p.startsWith("^")).toBe(true);
      expect(p).not.toContain(".*");
    }
  });

  it("only admits names the worker declares", () => {
    const declared = readFileSync(
      resolve(serviceRoot, "apps", "worker", "src", "observability", "metrics", "worker.metrics.ts"),
      "utf8",
    );
    for (const name of ADMITTED) expect(declared).toContain(`name: "${name}"`);
  });
});
