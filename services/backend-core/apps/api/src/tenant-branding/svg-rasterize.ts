/**
 * SVG rasterization in a killable child process (RT-473 S2, spec 039 FR-07, FR-09).
 *
 * resvg's work is not bounded by the input size: a small SVG can still make
 * it render for minutes (layer and reference fan-out), and a native render
 * cannot be cancelled in-process. So the render runs in a short-lived child
 * `node` process that:
 *   - receives only the checked SVG text on stdin (an empty environment: no
 *     secret, no database URL);
 *   - loads no system font and has no resource directory;
 *   - is killed after SVG_RENDER_TIMEOUT_MS, which is refused as
 *     `svg_unsupported` (rasterizer limits exceeded, contract §5).
 * One render runs at a time per API process; the others wait their turn, so
 * a hostile upload costs one child for at most the timeout and never blocks
 * the event loop or the shared libuv threadpool.
 *
 * The child is the defence in depth behind the in-repo gate (svg-scan.ts),
 * which already refuses every `<image>` and every non-fragment reference.
 */
import { spawn } from "node:child_process";

import { MAX_SIDE_PX, SVG_RASTER_HEIGHT_PX, SVG_RENDER_TIMEOUT_MS } from "./logo-config";
import { reject } from "./logo-refusal";

/** The PNG a 4000 × 960 RGBA render can encode to, with headroom. */
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024 * 1024;

const RESVG_ENTRY = require.resolve("@resvg/resvg-js");

/** The child's whole program: stdin JSON → stdout PNG; any failure is a non-zero exit. */
const CHILD_SOURCE = `
const { Resvg } = require(${JSON.stringify(RESVG_ENTRY)});
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  try {
    const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const base = { font: { loadSystemFonts: false }, logLevel: "off" };
    const probe = new Resvg(job.svg, base);
    const fitTo = probe.width * job.height > job.maxWidth * probe.height
      ? { mode: "width", value: job.maxWidth }
      : { mode: "height", value: job.height };
    const png = new Resvg(job.svg, { ...base, fitTo }).render().asPng();
    process.stdout.write(png, () => process.exit(0));
  } catch {
    process.exit(3);
  }
});
`;

let queue: Promise<unknown> = Promise.resolve();

/** Runs `work` after every earlier render has settled (one at a time). */
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

function renderInChild(svg: string, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, rejectRender) => {
    const child = spawn(process.execPath, ["-e", CHILD_SOURCE], { env: {}, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      rejectRender(new Error("svg render failed"));
    };
    const timer = setTimeout(fail, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_CHILD_OUTPUT_BYTES) return fail();
      chunks.push(chunk);
    });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return fail();
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks, total));
    });
    child.stdin.end(JSON.stringify({ svg, height: SVG_RASTER_HEIGHT_PX, maxWidth: MAX_SIDE_PX }));
  });
}

/**
 * The PNG of a checked SVG at the FR-09 fixed size (height SVG_RASTER_HEIGHT_PX,
 * width capped at MAX_SIDE_PX). Any render failure or timeout is `svg_unsupported`.
 */
export function rasterizeCheckedSvg(svg: string, timeoutMs: number = SVG_RENDER_TIMEOUT_MS): Promise<Buffer> {
  return serialized(() => renderInChild(svg, timeoutMs)).catch(() => reject("svg_unsupported"));
}
