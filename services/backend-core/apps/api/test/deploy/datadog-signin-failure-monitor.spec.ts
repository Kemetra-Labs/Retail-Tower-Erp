/**
 * RT-626 (RT-574 issue 5d) — the failed-sign-in alert fires, in a test.
 *
 * Datadog has no local evaluator, so this spec pins the monitor definition in
 * `deploy/datadog/monitors.json` and evaluates its threshold against simulated
 * 15-minute counts:
 *   - the query watches the counter the api actually exports, under the name
 *     the Datadog OpenMetrics check gives it, and the agent's scrape allowlist
 *     in docker-compose.prod.yml admits it (a rename cannot silently blind the
 *     alert);
 *   - the alert policy of deploy/datadog/README.md holds: email placeholder
 *     only, alert on missing data (no `default_zero`, which would turn missing
 *     data into 0 and silence the no-data alert), only the OBS-1 tags in the query;
 *   - counts above the critical threshold alert, counts above the warning
 *     threshold warn, and counts at or under them stay OK.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

import { SIGNIN_FAILURE_METRIC_NAME } from "../../src/observability/metrics/auth-signin-failure.metrics";

const serviceRoot = resolve(__dirname, "..", "..", "..", "..");
const MONITOR_KEY = "p2-api-signin-failures";
/** OBS-1 tag set (deploy/datadog/README.md, alert policy). */
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
  const found = monitors.filter((m) => m.key === MONITOR_KEY);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** The Datadog name of an OpenMetrics counter: namespace, `_total` stripped, `.count`. */
function datadogCounterName(namespace: string, promName: string): string {
  return `${namespace}.${promName.replace(/_total$/, "")}.count`;
}

const QUERY_SHAPE =
  /^sum\(last_(\d+)m\):sum:([a-z0-9_.]+)\{([^}]*)\}\.as_count\(\) > (\d+(?:\.\d+)?)$/;

interface ParsedQuery {
  windowMinutes: number;
  metric: string;
  tags: Record<string, string>;
  threshold: number;
}

function parseQuery(query: string): ParsedQuery {
  const m = QUERY_SHAPE.exec(query);
  if (!m) throw new Error(`unexpected monitor query shape: ${query}`);
  const tags = Object.fromEntries(m[3]!.split(",").map((t) => t.split(":") as [string, string]));
  return { windowMinutes: Number(m[1]), metric: m[2]!, tags, threshold: Number(m[4]) };
}

/** Datadog's `sum(last_Nm) … > critical` with a warning threshold, over per-scrape increments. */
function evaluate(monitor: Monitor, increments: readonly number[]): "OK" | "WARN" | "ALERT" {
  const value = increments.reduce((a, b) => a + b, 0);
  const { critical, warning } = monitor.options.thresholds;
  if (value > critical) return "ALERT";
  if (warning !== undefined && value > warning) return "WARN";
  return "OK";
}

/** `n` failures spread over a 15-minute window of 15-second scrapes. */
function window(n: number): number[] {
  const scrapes = new Array<number>(60).fill(0);
  for (let i = 0; i < n; i++) scrapes[i % 60]! += 1;
  return scrapes;
}

describe("RT-626: p2-api-signin-failures monitor", () => {
  const monitor = loadMonitor();
  const parsed = parseQuery(monitor.query);

  it("watches the exported counter under its Datadog name, over 15 minutes", () => {
    expect(parsed.metric).toBe(datadogCounterName("dp2", SIGNIN_FAILURE_METRIC_NAME));
    expect(parsed.metric).toBe("dp2.auth_signin_failure.count");
    expect(parsed.windowMinutes).toBe(15);
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
    const admitted = api!.metrics.some((pattern) => new RegExp(pattern).test(SIGNIN_FAILURE_METRIC_NAME));
    expect(admitted).toBe(true);
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

  it("the query threshold is the critical threshold; the warning sits below it", () => {
    expect(monitor.options.thresholds).toEqual({ critical: 100, warning: 50 });
    expect(parsed.threshold).toBe(monitor.options.thresholds.critical);
  });

  it.each([
    [0, "OK"],
    [50, "OK"],
    [51, "WARN"],
    [100, "WARN"],
    [101, "ALERT"],
    [1_000, "ALERT"],
  ] as const)("%i failed sign-ins in 15 minutes evaluate to %s", (failures, expected) => {
    expect(evaluate(monitor, window(failures))).toBe(expected);
  });
});
