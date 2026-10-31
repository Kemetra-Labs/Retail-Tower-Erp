/**
 * RT-473 S2 — the logo upload body: the Content-Type passthrough that keeps
 * Nest's parsers off the two upload routes, and the capped raw reader
 * (413 `file_too_large`, 400 on an empty body, 500 when a parser got there first).
 */
import { PassThrough } from "node:stream";

import { BadRequestException, PayloadTooLargeException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

import { logoUploadPassthrough, readLogoBody } from "../../src/tenant-branding/logo-body";

const TENANT = "0a000000-0000-7000-8000-00000000ada1";

function stream(headers: Record<string, string> = {}, body?: unknown): Request {
  const s = Object.assign(new PassThrough(), { headers, body });
  return s as unknown as Request;
}

function passthrough(method: string, path: string, contentType = "application/json"): string | undefined {
  const req = { method, path, headers: { "content-type": contentType } } as unknown as Request;
  const next = jest.fn() as NextFunction;
  logoUploadPassthrough(req, {} as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  return req.headers["content-type"];
}

describe("logoUploadPassthrough", () => {
  it.each([
    ["POST", `/api/v1/tenants/${TENANT}/logo/preview`],
    ["PUT", `/api/v1/tenants/${TENANT}/logo`],
    ["PUT", `/api/v1/tenants/${TENANT}/logo/`],
  ])("marks %s %s as raw bytes", (method, path) => {
    expect(passthrough(method, path)).toBe("application/octet-stream");
  });

  it.each([
    ["GET", `/api/v1/tenants/${TENANT}/logo`],
    ["DELETE", `/api/v1/tenants/${TENANT}/logo`],
    ["POST", `/api/v1/tenants/${TENANT}/logo`],
    ["PUT", `/api/v1/tenants/${TENANT}/logo/preview/x`],
    ["POST", `/api/v1/tenants/${TENANT}/stores`],
    ["PUT", `/api/v1/tenants/${TENANT}/cash-variance-policy`],
  ])("leaves %s %s alone", (method, path) => {
    expect(passthrough(method, path)).toBe("application/json");
  });
});

describe("readLogoBody", () => {
  it("returns the streamed bytes", async () => {
    const req = stream();
    const read = readLogoBody(req, 16);
    (req as unknown as PassThrough).end(Buffer.from([0x89, 0x50]));
    await expect(read).resolves.toEqual(Buffer.from([0x89, 0x50]));
  });

  it("refuses a declared Content-Length over the cap with 413 file_too_large before reading", async () => {
    const err = await readLogoBody(stream({ "content-length": "17" }), 16).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect((err as PayloadTooLargeException).getResponse()).toMatchObject({ code: "file_too_large" });
  });

  it("refuses a chunked body as soon as it passes the cap", async () => {
    const req = stream();
    const read = readLogoBody(req, 4);
    (req as unknown as PassThrough).write(Buffer.alloc(5));
    await expect(read).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it("refuses an empty body with 400 validation_error", async () => {
    const req = stream();
    const read = readLogoBody(req, 16);
    (req as unknown as PassThrough).end();
    const err = await read.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: "validation_error" });
  });

  it("fails loudly (a plain Error → 500) when a body parser already consumed the body", async () => {
    const err = await readLogoBody(stream({}, { parsed: true }), 16).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BadRequestException);
  });
});
