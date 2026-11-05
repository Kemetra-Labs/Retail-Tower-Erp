/**
 * RT-1211 — metric name / kind / description / label-set / meter-scope snapshot
 * for the worker. Written BEFORE the refactor and unchanged by it: the table-
 * driven worker metrics and the shared pool-gauge helpers must register exactly
 * these instruments, under meter scope "worker", with exactly these label sets.
 *
 * Capture: `getMeter` and `assertMetricLabels` from `@data-pulse-2/shared` are
 * wrapped to record what the module registers at load. Nothing else is mocked.
 */
interface Recorded {
  readonly scope: string;
  readonly kind: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly unit: string | undefined;
}

const mockInstruments: Recorded[] = [];
const mockLabels: Array<{ metric: string; labels: string[] }> = [];

jest.mock("@data-pulse-2/shared", () => {
  const actual = jest.requireActual("@data-pulse-2/shared");
  const instrument = (scope: string, kind: string) =>
    (name: string, opts?: { description?: string; unit?: string }) => {
      mockInstruments.push({
        scope,
        kind,
        name,
        description: opts?.description,
        unit: opts?.unit,
      });
      return {
        add: () => undefined,
        record: () => undefined,
        addCallback: () => undefined,
        removeCallback: () => undefined,
      };
    };
  return {
    ...actual,
    getMeter: (scope: string) => ({
      createCounter: instrument(scope, "counter"),
      createUpDownCounter: instrument(scope, "updowncounter"),
      createHistogram: instrument(scope, "histogram"),
      createGauge: instrument(scope, "gauge"),
      createObservableGauge: instrument(scope, "observable_gauge"),
      createObservableCounter: instrument(scope, "observable_counter"),
      createObservableUpDownCounter: instrument(scope, "observable_updowncounter"),
    }),
    assertMetricLabels: (metric: string, labels: readonly string[]) => {
      actual.assertMetricLabels(metric, labels);
      mockLabels.push({ metric, labels: [...labels].sort() });
    },
  };
});

import { WORKER_METRIC_NAMES } from "../../src/observability/metrics/worker.metrics";

const byName = <T extends { name?: string; metric?: string }>(a: T, b: T): number =>
  (a.name ?? a.metric ?? "").localeCompare(b.name ?? b.metric ?? "");

describe("RT-1211 worker metric snapshot", () => {
  it("registers exactly these instruments (scope, kind, name, description, unit)", () => {
    expect([...mockInstruments].sort(byName)).toMatchSnapshot();
  });

  it("asserts exactly these label sets", () => {
    expect([...mockLabels].sort(byName)).toMatchSnapshot();
  });

  it("every instrument is on meter scope \"worker\"", () => {
    expect(new Set(mockInstruments.map((i) => i.scope))).toEqual(new Set(["worker"]));
  });

  it("WORKER_METRIC_NAMES is exactly the registered instrument names that have emission helpers", () => {
    expect([...WORKER_METRIC_NAMES].sort()).toMatchSnapshot();
  });
});
