/**
 * RT-1041 — `processLogo` off the event loop, bounded per process:
 *   - while the logo worker processes a 4000 × 4000 PNG, the main thread's
 *     event-loop delay stays under 100 ms;
 *   - past LOGO_MAX_PENDING_JOBS running or waiting, a job is refused at once
 *     with `RenderQueueFullError` (→ 429), while a file the byte checks
 *     refuse is still its 422;
 *   - a held queue drains and serves the next job;
 *   - a job with no reply in time fails and the next job gets a fresh worker.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";

import sharp from "sharp";

import { LOGO_MAX_PENDING_JOBS, MAX_SIDE_PX } from "../../src/tenant-branding/logo-config";
import { logoJobs, processLogo } from "../../src/tenant-branding/logo-pipeline";
import { LogoRejectedError } from "../../src/tenant-branding/logo-refusal";
import { RenderQueueFullError } from "../../src/tenant-branding/render-queue";
import { canvas, fillRect, logoPng, NAVY } from "./__support__/logo-images";

const SMALL = logoPng(1024, 256);

/** Holds every slot of the logo queue until `release()`. */
function holdQueue(): { release: () => Promise<void> } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const held = Array.from({ length: LOGO_MAX_PENDING_JOBS }, () => logoJobs.run(() => gate));
  return {
    release: async () => {
      open();
      await Promise.all(held);
    },
  };
}

describe("the event loop while a 4000 × 4000 PNG is processed", () => {
  let big: Buffer;

  beforeAll(async () => {
    // A 3600 × 1800 block (2:1) in a transparent 4000 × 4000 canvas. Built
    // with libvips: the in-repo level-9 encoder would stall this setup.
    const c = fillRect(canvas(MAX_SIDE_PX, MAX_SIDE_PX), 200, 1100, 3600, 1800, NAVY);
    big = await sharp(Buffer.from(c.data.buffer), { raw: { width: MAX_SIDE_PX, height: MAX_SIDE_PX, channels: 4 } })
      .png()
      .toBuffer();
    // Start the worker (and load its modules) before measuring.
    await processLogo(SMALL);
  }, 120_000);

  it("stays under 100 ms of delay for the whole job", async () => {
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const started = performance.now();
    const out = await processLogo(big);
    const elapsedMs = performance.now() - started;
    delay.disable();

    const maxDelayMs = delay.max / 1e6;
    // eslint-disable-next-line no-console
    console.info(`RT-1041 event loop: job ${elapsedMs.toFixed(0)} ms, max delay ${maxDelayMs.toFixed(1)} ms`);
    expect(out.master).toMatchObject({ width: 1024 });
    // The job itself took real time, so the probe overlapped real work.
    expect(elapsedMs).toBeGreaterThan(100);
    expect(maxDelayMs).toBeLessThan(100);
  }, 120_000);
});

describe("the per-process logo queue", () => {
  it("refuses one job past the cap with RenderQueueFullError, then serves again once drained", async () => {
    const queue = holdQueue();
    try {
      await expect(processLogo(SMALL)).rejects.toBeInstanceOf(RenderQueueFullError);
    } finally {
      await queue.release();
    }
    await expect(processLogo(SMALL)).resolves.toMatchObject({ master: { width: 1024 } });
  });

  it("still answers a file the byte checks refuse with its refusal, not the 429", async () => {
    const queue = holdQueue();
    try {
      const refused = processLogo(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      await expect(refused).rejects.toBeInstanceOf(LogoRejectedError);
      await expect(refused).rejects.toMatchObject({ code: "file_type_not_allowed" });
    } finally {
      await queue.release();
    }
  });

  it("runs the jobs it admits one at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const probe = (): Promise<void> =>
      logoJobs.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });
    await Promise.all(Array.from({ length: LOGO_MAX_PENDING_JOBS }, probe));
    expect(maxActive).toBe(1);
  });

  it("completes every job it admits", async () => {
    const all = await Promise.all(Array.from({ length: LOGO_MAX_PENDING_JOBS }, () => processLogo(SMALL)));
    expect(new Set(all.map((logo) => logo.version)).size).toBe(1);
  });
});

describe("a worker that does not reply", () => {
  it("fails the job (a plain Error, → 500) at the timeout, frees the queue and replaces the worker", async () => {
    const failed = processLogo(SMALL, 1);
    await expect(failed).rejects.not.toBeInstanceOf(LogoRejectedError);
    await expect(failed).rejects.toThrow("logo worker failed");
    await expect(processLogo(SMALL)).resolves.toMatchObject({ master: { width: 1024 } });
  });
});
