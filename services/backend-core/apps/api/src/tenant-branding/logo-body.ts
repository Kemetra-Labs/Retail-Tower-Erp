/**
 * The raw upload body of the logo preview and save (RT-473 S2, spec 039
 * FR-03, FR-04, OD-14).
 *
 * The contract takes the file bytes under ANY `Content-Type` (declared
 * `*\/*`); the header neither accepts nor refuses. Nest's global JSON and
 * urlencoded parsers run before any route and would consume (or fail on) a
 * body declared `application/json` or form-encoded. `logoUploadPassthrough`,
 * registered on the HTTP adapter BEFORE those parsers (main.ts, and the
 * tenant-branding test boot), marks the two upload routes'
 * body as `application/octet-stream` so no parser touches the stream.
 *
 * The handler then reads the stream itself, AFTER the guards (a 401 / 403 /
 * 404 never waits for a body), with the 1 MiB cap on `Content-Length` and
 * while streaming, so an oversized body is never buffered whole. The reader is
 * shared with the product import upload (`common/raw-body.ts`, RT-1505).
 */
import type { NextFunction, Request, Response } from "express";

import { readRawBody } from "../common/raw-body";
import { MAX_UPLOAD_BYTES } from "./logo-config";

/** The two upload operations, `PUT …/logo` and `POST …/logo/preview`; case-insensitive, as Express routing is. */
const SAVE_PATH_RE = /^\/api\/v1\/tenants\/[^/]+\/logo\/?$/i;
const PREVIEW_PATH_RE = /^\/api\/v1\/tenants\/[^/]+\/logo\/preview\/?$/i;

function isUpload(req: Pick<Request, "method" | "path">): boolean {
  if (req.method === "PUT") return SAVE_PATH_RE.test(req.path);
  return req.method === "POST" && PREVIEW_PATH_RE.test(req.path);
}

/** Express middleware: keep the global body parsers off the logo upload routes. */
export function logoUploadPassthrough(req: Request, _res: Response, next: NextFunction): void {
  if (isUpload(req)) req.headers["content-type"] = "application/octet-stream";
  next();
}

/** Resolves the body bytes; 413 `file_too_large` past 1 MiB, 400 when empty or aborted. */
export function readLogoBody(req: Parameters<typeof readRawBody>[0], maxBytes: number = MAX_UPLOAD_BYTES): Promise<Buffer> {
  return readRawBody(req, {
    maxBytes,
    tooLargeMessage: "The file is larger than 1 MiB.",
    unwiredMessage: "logo upload body was consumed by a body parser (logoUploadPassthrough not wired)",
  });
}
