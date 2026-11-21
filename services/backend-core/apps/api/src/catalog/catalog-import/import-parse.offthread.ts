/**
 * RT-1535 (spec 049 S4c): runs `parseImportFile` in a `worker_threads` Worker so
 * a 5,000 x 50 XLSX (about 4.5 s of CPU in `read-excel-file`) no longer blocks
 * the API event loop, and therefore POS sync, auth and console traffic.
 *
 * One fresh worker per upload. The global upload gate (4 slots) already bounds
 * how many exist, and a fresh thread is the cleanest thing to kill. Limits:
 *
 *   - `resourceLimits` (heap) caps what a hostile file can allocate; the worker
 *     dies with `ERR_WORKER_OUT_OF_MEMORY`, the API process does not;
 *   - a wall-clock timeout terminates the worker.
 *
 * Every worker-level failure (limit kill, timeout, crash, an exit with no
 * answer, a parser bug) is the contract's existing 422 `file_unreadable`: no
 * 500, nothing written (the caller writes only after this returns). A parser
 * bug is logged by its error name (never a message, which can quote file content), so it is not hidden.
 * A refusal the parser throws keeps its own code.
 *
 * Worker file: next to this file, `.js` in `dist` and `.ts` under Jest. Jest's
 * transformer does not run inside a worker thread, so for `.ts` the worker
 * starts from a small bootstrap that compiles `.ts` on require with the
 * `typescript` devDependency (the same emit as ts-jest: CommonJS).
 */
import { extname, join } from "node:path";
import { Worker, type ResourceLimits } from "node:worker_threads";

import { Logger } from "@nestjs/common";

import { ImportFileRejectedError, type ImportFileRefusalCode } from "./import-file-rejected";
import type { ImportParseOptions, ParsedImportFile } from "./import-file-parser";
import type { ImportParseJob, ImportParseReply } from "./import-parse.worker";

export interface OffThreadParseConfig {
  /** Wall-clock budget of one parse, milliseconds. */
  readonly timeoutMs: number;
  readonly resourceLimits: ResourceLimits;
  /** A worker file to run instead of the real one (a test stands in a crashing or silent worker). */
  readonly workerFile?: string;
}

/**
 * Measured (RT-1535, Windows laptop, built `dist` worker): the worst accepted 5,000 x 50 shapes (30-character Arabic
 * cells near the 8M staged-character cap; 1,000 formats and styles at their caps) parse in 0.7 to 1.2 s and need a
 * worker heap of 96 to 128 MiB (96 MiB refused the Arabic one, 128 MiB accepted it). 384 MiB is 3x that and 20 s is
 * more than 15x the time, for a slow 2-vCPU runner. The heap limit does not cover Buffers (the zip inflate, up to
 * 50 MiB), so the process total per slot is higher; the API container's memory limit is not in this repository.
 */
export const DEFAULT_OFFTHREAD_PARSE_CONFIG: OffThreadParseConfig = {
  timeoutMs: 20_000,
  resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
};

const logger = new Logger("CatalogImportParse");

/** Compiles `.ts` on require, then loads the real entry (Jest only; see the file header). */
const TS_BOOTSTRAP = `
const fs = require("node:fs");
const { workerData } = require("node:worker_threads");
const ts = require(workerData.tsPath);
require.extensions[".ts"] = (module, filename) => {
  const out = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(out.outputText, filename);
};
require(workerData.entry);
`;

function startWorker(job: ImportParseJob, limits: ResourceLimits, workerFile: string | undefined): Worker {
  const entry = workerFile ?? join(__dirname, `import-parse.worker${extname(__filename)}`);
  if (extname(entry) === ".ts") {
    return new Worker(TS_BOOTSTRAP, { eval: true, resourceLimits: limits, workerData: { job, entry, tsPath: require.resolve("typescript") } });
  }
  return new Worker(entry, { resourceLimits: limits, workerData: { job } });
}

/** Parses an upload off-thread. Throws `ImportFileRejectedError`; nothing is written either way. */
export function parseImportFileOffThread(
  bytes: Buffer,
  options: ImportParseOptions,
  config: OffThreadParseConfig = DEFAULT_OFFTHREAD_PARSE_CONFIG,
): Promise<ParsedImportFile> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // A copy: the worker gets its own bytes, the caller's Buffer (a slice of a shared pool) is not detached.
    const worker = startWorker({ bytes: Uint8Array.from(bytes), options }, config.resourceLimits, config.workerFile);
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The thread is gone before the caller's gate slot is released.
      void worker.terminate().then(outcome, outcome);
    };
    const unreadable = (why: string): void => {
      if (settled) return;
      logger.warn(`import parse worker failed: ${why}`);
      settle(() => reject(new ImportFileRejectedError("file_unreadable")));
    };
    const timer = setTimeout(() => unreadable(`timeout after ${config.timeoutMs} ms`), config.timeoutMs);
    worker.once("message", (reply: ImportParseReply) => {
      if (reply.ok) return settle(() => resolve(reply.parsed));
      if ("code" in reply) return settle(() => reject(new ImportFileRejectedError(reply.code as ImportFileRefusalCode)));
      unreadable(`parser error ${reply.unexpected}`);
    });
    worker.once("error", (err: Error & { code?: string }) => unreadable(err.code ?? err.name));
    worker.once("exit", (exitCode) => unreadable(`exit ${exitCode} with no answer`));
  });
}
