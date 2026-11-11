/**
 * RT-1327 — the provider sign-out failure alert fires, in a test.
 *
 * Datadog has no local evaluator, so this spec pins the monitor definition in
 * `deploy/datadog/monitors.json` (same approach as the RT-626 sign-in monitor):
 *   - the query watches the counter the api exports, under the name the Datadog
 *     OpenMetrics check gives it, and the agent's scrape allowlist admits it;
 *   - the alert policy of deploy/datadog/README.md holds: email placeholder
 *     only, alert on missing data, no `default_zero`, OBS-1 tags only;
 *   - a single failure in the window alerts: one surviving provider session
 *     after a password reset is already worth a look.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

import { PROVIDER_SIGNOUT_FAILURE_METRIC_NAME } from "../../src/observability/metrics/auth-provider-signout.metrics";

const serviceRoot = resolve(__dirname, "..", "..", "..", "..");
const MONITOR_ID = "p2-api-provider-signout-fail";
const ALLOWED_QUERY_TAGS = new Set(["env", "service", "version", "route", "status_class", "host"]);

interface Monitor {
  key: string;
  type: string;
  query: string;
  message: string;
  priority: number;
  options: {
    thresholds: { critical: number; warning?: number };
    notify_no_data: boolean;
    no_data_timeframe: number;
  };
}

function loadMonitor(): Monitor {
  const monitors = JSON.parse(
    readFileSync(resolve(serviceRoot, "deploy", "datadog", "monitors.json"), "utf8"),
  ) as Monitor[];
  const found = monitors.filter((m) => m.key === MONITOR_ID);
  expect(found).toHaveLength(1);
  return found[0]!;
}

const QUERY_SHAPE =
  /^sum\(last_(\d+)m\):sum:([a-z0-9_.]+)\{([^}]*)\}\.as_count\(\) > (\d+(?:\.\d+)?)$/;

function parseQuery(query: string): { windowMinutes: number; metric: string; tags: Record<string, string>; threshold: number } {
  const m = QUERY_SHAPE.exec(query);
  if (!m) throw new Error(`unexpected monitor query shape: ${query}`);
  const tags = Object.fromEntries(m[3]!.split(",").map((t) => t.split(":") as [string, string]));
  return { windowMinutes: Number(m[1]), metric: m[2]!, tags, threshold: Number(m[4]) };
}

function evaluate(monitor: Monitor, failures: number): "OK" | "ALERT" {
  return failures > monitor.options.thresholds.critical ? "ALERT" : "OK";
}

describe("RT-1327: p2-api-provider-signout-fail monitor", () => {
  const monitor = loadMonitor();
  const parsed = parseQuery(monitor.query);

  it("watches the exported counter under its Datadog name", () => {
    expect(parsed.metric).toBe(`dp2.${PROVIDER_SIGNOUT_FAILURE_METRIC_NAME.replace(/_total$/, "")}.count`);
    expect(parsed.metric).toBe("dp2.auth_provider_signout_failure.count");
    expect(parsed.tags).toEqual({ env: "staging", service: "backend-api" });
  });

  it("the agent's OpenMetrics allowlist scrapes the counter", () => {
    const compose = load(readFileSync(resolve(serviceRoot, "docker-compose.prod.yml"), "utf8")) as {
      configs: { dd_openmetrics: { content: string } };
    };
    const conf = load(compose.configs.dd_openmetrics.content) as {
      instances: { namespace: string; metrics: string[] }[];
    };
    const api = conf.instances.find((i) => i.namespace === "dp2");
    expect(api).toBeDefined();
    expect(api!.metrics.some((pattern) => new RegExp(pattern).test(PROVIDER_SIGNOUT_FAILURE_METRIC_NAME))).toBe(true);
  });

  it("follows the alert policy: email placeholder only, alerts on missing data, OBS-1 tags only", () => {
    expect(monitor.type).toBe("query alert");
    expect(monitor.priority).toBe(2);
    expect(monitor.message).toContain("__ALERT_RECIPIENTS__");
    expect(monitor.message).not.toMatch(/@[\w.-]/);
    expect(monitor.options.notify_no_data).toBe(true);
    expect(monitor.query).not.toContain("default_zero");
    expect(monitor.options.no_data_timeframe).toBeGreaterThanOrEqual(parsed.windowMinutes);
    for (const tag of Object.keys(parsed.tags)) expect(ALLOWED_QUERY_TAGS.has(tag)).toBe(true);
  });

  it("the query threshold is the critical threshold, 0", () => {
    expect(monitor.options.thresholds).toEqual({ critical: 0 });
    expect(parsed.threshold).toBe(0);
  });

  it.each([
    [0, "OK"],
    [1, "ALERT"],
    [10, "ALERT"],
  ] as const)("%i failed provider sign-outs in the window evaluate to %s", (failures, expected) => {
    expect(evaluate(monitor, failures)).toBe(expected);
  });
});
