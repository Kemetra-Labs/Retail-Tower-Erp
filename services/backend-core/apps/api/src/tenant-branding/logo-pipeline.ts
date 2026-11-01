/**
 * The tenant logo pipeline (RT-473 S2, spec 039 FR-03 … FR-13).
 *
 *   1. Type by magic bytes only (FR-03): PNG signature, or an SVG prolog /
 *      `<svg` root. Anything else is `file_type_not_allowed`.
 *   2. PNG: the in-repo chunk walk (header bomb guard, CRC, nothing after
 *      IEND). SVG: the in-repo gate, then resvg in a killable child process
 *      at a fixed size (svg-rasterize.ts). The SVG itself is never kept.
 *   3. The decode, trim, renditions and version (logo-render.ts) in the
 *      logo worker thread (RT-1041).
 *
 * Steps 1–2 are bounded byte checks on at most MAX_UPLOAD_BYTES, so a file
 * they refuse is a 422 even when the renderer is busy. Steps 2 (SVG render)
 * and 3 then run in the logo queue: one job at a time per API process and
 * at most LOGO_MAX_PENDING_JOBS running or waiting; one more is
 * `RenderQueueFullError` (→ 429). The event loop only copies the checked PNG
 * to the worker and the rendered PNGs back.
 */
import { extname, join } from "node:path";
import { Worker } from "node:worker_threads";

// sharp must be loaded on the main thread before any worker loads it, so its
// shared libraries stay loaded while workers come and go (sharp's worker
// thread guidance); logo-render.ts, which uses it, runs in the worker.
import "sharp";

import { LOGO_MAX_PENDING_JOBS } from "./logo-config";
import { fromReply, type LogoReply, type ProcessedLogo } from "./logo-render";
import { reject } from "./logo-refusal";
import { hasPngSignature, inspectPng } from "./png-codec";
import { renderQueue } from "./render-queue";
import { rasterizeCheckedSvg } from "./svg-rasterize";
import { hasSvgSignature, scanSvg } from "./svg-scan";

export {
  LOGO_WARNINGS,
  logoVersion,
  type LogoWarning,
  type ProcessedLogo,
  type ReceiptRenditionImage,
  type ScreenRenditionImage,
} from "./logo-render";

/** The worker entry beside this module: logo-worker.js in the build, logo-worker.ts when run from source. */
const WORKER_ENTRY = join(__dirname, `logo-worker${extname(__filename)}`);

/**
 * Run from the TypeScript sources (ts-jest), the worker transpiles them as
 * it requires them, with the `typescript` dev dependency; the production
 * build loads logo-worker.js and never takes this path.
 */
const TS_SOURCE_BOOTSTRAP = `
const { workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const ts = require(workerData.typescript);
require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};
require(workerData.entry);
`;

const jobs = renderQueue(LOGO_MAX_PENDING_JOBS);

let worker: Worker | null = null;

function startWorker(): Worker {
  const started =
    extname(WORKER_ENTRY) === ".js"
      ? new Worker(WORKER_ENTRY)
      : new Worker(TS_SOURCE_BOOTSTRAP, {
          eval: true,
          workerData: { entry: WORKER_ENTRY, typescript: require.resolve("typescript") },
        });
  // A job's own listeners report a failure; an idle one only drops the worker.
  started.on("error", () => undefined);
  started.on("exit", () => {
    if (worker === started) worker = null;
  });
  started.unref();
  return started;
}

/** One job on the (lazily started, long-lived) worker; a worker that fails is replaced on the next job. */
function renderInWorker(png: Buffer): Promise<ProcessedLogo> {
  const current = worker ?? (worker = startWorker());
  return new Promise<ProcessedLogo>((resolve, rejectJob) => {
    const settle = (finish: () => void): void => {
      current.off("message", onMessage).off("error", onError).off("exit", onExit);
      current.unref();
      finish();
    };
    const fail = (cause: unknown): void => {
      if (worker === current) worker = null;
      void current.terminate();
      settle(() => rejectJob(new Error("logo worker failed", { cause })));
    };
    const onMessage = (reply: LogoReply): void => {
      settle(() => {
        try {
          resolve(fromReply(reply));
        } catch (err) {
          rejectJob(err);
        }
      });
    };
    const onError = (err: Error): void => fail(err);
    const onExit = (code: number): void => fail(new Error(`exit code ${code}`));
    current.on("message", onMessage).on("error", onError).on("exit", onExit);
    current.ref();
    current.postMessage(png);
  });
}

/** The checked PNG of an upload: the upload itself, or the SVG child's render of it. */
function checkedPng(bytes: Buffer): () => Promise<Buffer> {
  if (hasPngSignature(bytes)) {
    inspectPng(bytes);
    return () => Promise.resolve(bytes);
  }
  if (hasSvgSignature(bytes)) {
    const svg = scanSvg(bytes);
    return () => rasterizeCheckedSvg(svg);
  }
  return reject("file_type_not_allowed");
}

/**
 * Validates, normalizes and renders an upload; throws `LogoRejectedError` on
 * a §5 refusal and `RenderQueueFullError` when the logo queue is full.
 */
export async function processLogo(bytes: Buffer): Promise<ProcessedLogo> {
  const png = checkedPng(bytes);
  return jobs.run(async () => renderInWorker(await png()));
}

/** Test seam: the logo queue itself, so a spec can hold its slots and see the 429. */
export const logoJobs = jobs;
