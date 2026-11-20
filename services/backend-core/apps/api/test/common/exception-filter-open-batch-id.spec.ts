/**
 * RT-1505 (security review of PR #761, minor 8): `error.openBatchId` is the
 * product import's, and only on `import_batch_open`. `GlobalExceptionFilter` is
 * shared, so this pins two things: the filter lets the key through for that
 * code only, and no other source file names it (a new use needs this test, and
 * the contract, to change on purpose).
 */
import "reflect-metadata";

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { ConflictException, type ArgumentsHost } from "@nestjs/common";

import { GlobalExceptionFilter } from "../../src/common/exception.filter";

const SRC = path.join(__dirname, "../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

function emit(payload: Record<string, unknown>): { error: Record<string, unknown> } {
  let body: unknown;
  const response = {
    headersSent: false,
    status() {
      return this;
    },
    json(b: unknown) {
      body = b;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ requestId: "r", route: { path: "/x" } }), getResponse: () => response }),
    getClass: () => undefined,
    getHandler: () => undefined,
  } as unknown as ArgumentsHost;
  new GlobalExceptionFilter().catch(new ConflictException(payload), host);
  return body as { error: Record<string, unknown> };
}

describe("openBatchId through GlobalExceptionFilter", () => {
  const ID = "0192f000-0000-7000-8000-000000000001";

  it("surfaces for import_batch_open only", () => {
    expect(emit({ code: "import_batch_open", message: "m", openBatchId: ID }).error["openBatchId"]).toBe(ID);
    for (const code of ["alias_conflict", "version_conflict", "idempotency_key_conflict"]) {
      expect(emit({ code, message: "m", openBatchId: ID }).error).not.toHaveProperty("openBatchId");
    }
    expect(emit({ message: "m", openBatchId: ID }).error).not.toHaveProperty("openBatchId");
  });

  it("is named only by the filter and by the product import (a new emitter must change this list on purpose)", () => {
    const named = sourceFiles(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("openBatchId"))
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .sort();
    expect(named).toEqual(["catalog/catalog-import/catalog-import.controller.ts", "catalog/catalog-import/catalog-import.service.ts", "common/exception.filter.ts"]);
  });
});
