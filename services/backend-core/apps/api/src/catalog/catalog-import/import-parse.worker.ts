/**
 * RT-1535 (spec 049 S4c): the worker-thread entry of the import parse. It runs
 * `parseImportFile` (type sniffing, zip guard, XLSX scans, `read-excel-file`,
 * `csv-parse`) off the API main thread; `import-parse.offthread.ts` starts it,
 * once per upload, with `workerData = { bytes, options }`, and bounds it with
 * `resourceLimits` and a wall-clock timeout.
 *
 * It only calls the existing parser and posts one message back. An
 * `ImportFileRejectedError` loses its class across `postMessage`, so it travels
 * as its `code` and the host throws it again.
 */
import { parentPort, workerData } from "node:worker_threads";

import { ImportFileRejectedError } from "./import-file-rejected";
import { parseImportFile, type ImportParseOptions, type ParsedImportFile } from "./import-file-parser";

export interface ImportParseJob {
  readonly bytes: Uint8Array;
  readonly options: ImportParseOptions;
}

/** The one message a worker posts. `unexpected` is a bug in the parser (anything but a refusal): the error NAME only, never its message (a library message can quote cell text). */
export type ImportParseReply =
  | { readonly ok: true; readonly parsed: ParsedImportFile }
  | { readonly ok: false; readonly code: string }
  | { readonly ok: false; readonly unexpected: string };

async function run(job: ImportParseJob): Promise<ImportParseReply> {
  try {
    return { ok: true, parsed: await parseImportFile(Buffer.from(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength), job.options) };
  } catch (err) {
    if (err instanceof ImportFileRejectedError) return { ok: false, code: err.code };
    return { ok: false, unexpected: err instanceof Error ? err.name : "non-error thrown" };
  }
}

if (parentPort !== null) {
  const port = parentPort;
  void run((workerData as { job: ImportParseJob }).job).then((reply) => port.postMessage(reply));
}
