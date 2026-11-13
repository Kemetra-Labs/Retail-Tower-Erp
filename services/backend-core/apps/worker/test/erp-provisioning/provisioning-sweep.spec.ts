/**
 * RT-1358 — the worker side of the ERP provisioning sweep: the processor (job
 * name, payload, counts-only log), the no-DB runner and the cadence config.
 * The sweep itself is tested against real Postgres in the api package
 * (`provisioning-sweep.integration.spec.ts`).
 */
import {
  MalformedProvisioningSweepJobError,
  NoOpProvisioningSweepRunner,
  PROVISIONING_SWEEP_JOB_NAME,
  ProvisioningSweepProcessor,
  UnknownProvisioningSweepJobError,
  type ProvisioningSweepRunner,
} from "../../src/erp-provisioning/provisioning-sweep.processor";
import { resolveHeartbeatTimeoutMs, resolveProvisioningSweepIntervalMs } from "../../src/erp-provisioning/provisioning-sweep.config";

describe("ProvisioningSweepProcessor", () => {
  const NOW = new Date("2026-11-14T10:00:00Z");

  it("runs the sweep with the clock and the heartbeat timeout, and logs counts only", async () => {
    const calls: Array<[Date, number]> = [];
    const runner: ProvisioningSweepRunner = {
      run: (now, ms) => {
        calls.push([now, ms]);
        return Promise.resolve({ leasesReclaimed: 2, succeeded: 1, timedOut: 0 });
      },
    };
    const lines: Array<Record<string, unknown>> = [];
    const p = new ProvisioningSweepProcessor(runner, 1_800_000, (l) => lines.push(l), () => NOW);
    await expect(p.process(PROVISIONING_SWEEP_JOB_NAME, {})).resolves.toEqual({ leasesReclaimed: 2, succeeded: 1, timedOut: 0 });
    expect(calls).toEqual([[NOW, 1_800_000]]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ component: "erp-provisioning.sweep", leasesReclaimed: 2, succeeded: 1, timedOut: 0, level: "info" });
    expect(Object.keys(lines[0]!).sort()).toEqual(["component", "durationMs", "leasesReclaimed", "level", "message", "succeeded", "timedOut"]);
  });

  it("warns when a request timed out, refuses an unknown job and a malformed payload", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const p = new ProvisioningSweepProcessor({ run: () => Promise.resolve({ leasesReclaimed: 0, succeeded: 0, timedOut: 1 }) }, 60_000, (l) => lines.push(l));
    await p.process(PROVISIONING_SWEEP_JOB_NAME, undefined);
    expect(lines[0]!["level"]).toBe("warn");
    await expect(p.process("other", {})).rejects.toBeInstanceOf(UnknownProvisioningSweepJobError);
    await expect(p.process(PROVISIONING_SWEEP_JOB_NAME, "nope")).rejects.toBeInstanceOf(MalformedProvisioningSweepJobError);
  });

  it("the no-DB runner sweeps nothing", async () => {
    await expect(new NoOpProvisioningSweepRunner().run()).resolves.toEqual({ leasesReclaimed: 0, succeeded: 0, timedOut: 0 });
  });
});

describe("sweep config", () => {
  it("defaults to every minute and a 30-minute heartbeat timeout; refuses a bad value", () => {
    expect(resolveProvisioningSweepIntervalMs({})).toBe(60_000);
    expect(resolveHeartbeatTimeoutMs({})).toBe(1_800_000);
    expect(resolveProvisioningSweepIntervalMs({ ERP_PROVISIONING_SWEEP_INTERVAL_MS: "30000" })).toBe(30_000);
    expect(() => resolveProvisioningSweepIntervalMs({ ERP_PROVISIONING_SWEEP_INTERVAL_MS: "5" })).toThrow();
    expect(() => resolveHeartbeatTimeoutMs({ ERP_PROVISIONING_HEARTBEAT_TIMEOUT_MS: "soon" })).toThrow();
  });
});
