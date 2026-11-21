/**
 * RT-1535 (spec 049 S4c): the import parse runs in a worker thread. Same answers as the in-thread parser, a clean
 * `file_unreadable` for a timeout, a resource-limit kill or a dead worker, and the event loop stays free while a
 * maximal XLSX is parsed.
 */
import { resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { Logger } from "@nestjs/common";

import { ImportFileRejectedError } from "../../../src/catalog/catalog-import/import-file-rejected";
import { parseImportFile, type ImportParseOptions } from "../../../src/catalog/catalog-import/import-file-parser";
import {
  DEFAULT_OFFTHREAD_PARSE_CONFIG,
  parseImportFileOffThread,
  type OffThreadParseConfig,
} from "../../../src/catalog/catalog-import/import-parse.offthread";
import { buildXlsx, type XlsxCell } from "./__support__/zip-fixtures";

const NONE: ImportParseOptions = { sheet: null, delimiter: null };
const FAKE = resolve(__dirname, "__support__/fake-parse-workers.ts");
const TINY = Buffer.from("a\n1\n", "utf8");

function maximalXlsx(): Buffer {
  const header: XlsxCell[] = Array.from({ length: 50 }, (_v, c) => `col${c}`);
  const rows: (readonly XlsxCell[])[] = [header];
  for (let r = 0; r < 5000; r += 1) rows.push(Array.from({ length: 50 }, (_v, c) => (c % 3 === 0 ? { num: String(r * 50 + c) } : `v${r}-${c}`)));
  return buildXlsx([{ name: "Products", rows }]);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "accepted";
  } catch (err) {
    if (err instanceof ImportFileRejectedError) return err.code;
    throw err;
  }
}

describe("off-thread parse: same outputs", () => {
  it("returns exactly what the in-thread parser returns, for a CSV and an XLSX", async () => {
    const csv = Buffer.from("sku,name\nA1,Tea\nA2,Coffee\n", "utf8");
    expect(await parseImportFileOffThread(csv, NONE)).toEqual(await parseImportFile(csv, NONE));
    const book = buildXlsx([{ name: "Products", rows: [["sku", "qty"], ["A1", { num: "007" }], ["A2", { formula: "1+1", cached: { num: "2" } }]] }]);
    const options: ImportParseOptions = { sheet: "Products", delimiter: null };
    expect(await parseImportFileOffThread(book, options)).toEqual(await parseImportFile(book, options));
  });

  it("does not detach the caller's buffer", async () => {
    const csv = Buffer.from("a,b\n1,2\n", "utf8");
    await parseImportFileOffThread(csv, NONE);
    expect(csv.byteLength).toBe(8);
  });

  it.each<[string, Buffer, ImportParseOptions]>([
    ["file_type_unsupported", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), NONE],
    ["validation_error", Buffer.from("a,b\n1,2\n"), { sheet: "S", delimiter: null }],
    ["encoding_not_utf8", Buffer.from([0x61, 0x2c, 0xff, 0xfe, 0x0a, 0x31]), NONE],
    ["sheet_not_found", buildXlsx([{ name: "Products", rows: [["a"], ["1"]] }]), { sheet: "Nope", delimiter: null }],
    ["no_data_rows", Buffer.from("a,b\n"), NONE],
  ])("keeps the refusal %s", async (code, bytes, options) => {
    expect(await codeOf(parseImportFile(bytes, options))).toBe(code);
    expect(await codeOf(parseImportFileOffThread(bytes, options))).toBe(code);
  });
});

describe("off-thread parse: worker failures are file_unreadable", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  const fake = (extra: Partial<OffThreadParseConfig> = {}): OffThreadParseConfig => ({ ...DEFAULT_OFFTHREAD_PARSE_CONFIG, workerFile: FAKE, ...extra });
  const mode = (name: string): ImportParseOptions => ({ sheet: name, delimiter: null });

  it("a wall-clock timeout terminates the worker and refuses", async () => {
    const started = Date.now();
    expect(await codeOf(parseImportFileOffThread(TINY, mode("hang"), fake({ timeoutMs: 300 })))).toBe("file_unreadable");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("timeout after 300 ms"));
  });

  it("a timeout kills a real parse of a maximal workbook long before it ends", async () => {
    const started = Date.now();
    expect(await codeOf(parseImportFileOffThread(maximalXlsx(), NONE, { ...DEFAULT_OFFTHREAD_PARSE_CONFIG, timeoutMs: 100 }))).toBe("file_unreadable");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("a resource-limit kill (heap) refuses and the process survives", async () => {
    const resourceLimits = { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 };
    expect(await codeOf(parseImportFileOffThread(maximalXlsx(), NONE, { ...DEFAULT_OFFTHREAD_PARSE_CONFIG, resourceLimits }))).toBe("file_unreadable");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ERR_WORKER_OUT_OF_MEMORY/));
  });

  it("a worker that dies with no answer refuses", async () => {
    expect(await codeOf(parseImportFileOffThread(TINY, mode("crash"), fake()))).toBe("file_unreadable");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit 3 with no answer"));
    expect(await codeOf(parseImportFileOffThread(TINY, mode("silent-exit"), fake()))).toBe("file_unreadable");
  });

  it("a parser bug (not a refusal) refuses and is logged by message only", async () => {
    expect(await codeOf(parseImportFileOffThread(TINY, mode("unexpected"), fake()))).toBe("file_unreadable");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("parser error TypeError: boom"));
  });
});

describe("off-thread parse: the event loop stays free", () => {
  it("serves a concurrent request while a 5,000 x 50 XLSX parses", async () => {
    const book = maximalXlsx();
    const histogram = monitorEventLoopDelay({ resolution: 5 });
    let served = 0;
    let lastServedAt = 0;
    const started = Date.now();
    // A stand-in for a concurrent request: a tick of the event loop every 10 ms, each answered at once.
    const ticker = setInterval(() => {
      served += 1;
      lastServedAt = Date.now() - started;
    }, 10);
    histogram.enable();
    const parsed = await parseImportFileOffThread(book, NONE);
    const parseMs = Date.now() - started;
    histogram.disable();
    clearInterval(ticker);
    const maxMs = histogram.max / 1e6;
    // eslint-disable-next-line no-console
    console.info(
      `RT-1535 measurement: parse ${parseMs} ms off-thread, event-loop delay max ${maxMs.toFixed(1)} ms, p99 ${(histogram.percentile(99) / 1e6).toFixed(1)} ms, ${served} ticks served, last at ${lastServedAt} ms`,
    );
    expect(parsed.grid.rows).toHaveLength(5000);
    expect(maxMs).toBeLessThan(250);
    expect(served).toBeGreaterThan(parseMs / 10 / 3);
    expect(lastServedAt).toBeGreaterThan(parseMs * 0.8);
  });
});
