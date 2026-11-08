/**
 * JSON request-body limits (RT-1284).
 *
 * Every route keeps body-parser's default JSON limit (100 kB). One route gets a
 * larger, route-scoped limit: the stock-view snapshot report
 * `binViewReportSnapshot`
 * (`POST /api/connector/v1/erpnext/bin-view-requests/{requestRef}/snapshot`,
 * `erpnext-connector/stock-view.yaml` 1.4.0-draft). A legal report window is far
 * above 100 kB, and the default would refuse it with 413 before validation.
 *
 * Largest legal window under the contract, as the Connector sends it
 * (`requests.post(json=...)`: `json.dumps` with `ensure_ascii=True` and
 * `", "` / `": "` separators), every string at its maximum length:
 *   500 entries; Item name and `stockUom` 140 characters each; quantity
 *   23 characters; `tracking` with 200 Batches per entry, each Batch name
 *   140 characters.
 *   - ASCII names:                    27,640,156 bytes (about 26.4 MiB)
 *   - Arabic names (`\uXXXX` escapes): 98,340,156 bytes (about 93.8 MiB)
 *   - the same window without `tracking`: 241,156 bytes (ASCII) to 941,156
 *     bytes (Arabic), already above 100 kB.
 *
 * Limit: 32 MiB (captain decision under owner delegation, RT-1284 comment
 * 16231). It covers every legal window with ASCII names, with a 21% margin over
 * 27,640,156 bytes. Accepted pilot limit: a window close to the contract maximum
 * with long non-ASCII names can exceed it and fails closed with 413 before
 * validation (nothing is recorded). The follow-up, if a tenant hits it, is a
 * per-window byte or Batch budget in the contract, a separate gated issue.
 * 128 MiB was refused: the parser runs before authentication, so any caller of
 * the path could make the API buffer and parse that much.
 */
import { PayloadTooLargeException } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import type { IncomingMessage } from "node:http";

/** 32 MiB, in bytes. */
export const BIN_VIEW_SNAPSHOT_JSON_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * `binViewReportSnapshot`, case-insensitive with an optional trailing slash, as
 * Express routing is. Any request it does not match falls to the 100 kB default
 * (fails closed).
 */
const BIN_VIEW_SNAPSHOT_PATH_RE =
  /^\/api\/connector\/v1\/erpnext\/bin-view-requests\/[^/]+\/snapshot\/?$/i;

type RoutedRequest = IncomingMessage & { path?: string };

/** The media type of `Content-Type`, lower-cased, without parameters. */
function mediaType(req: IncomingMessage): string {
  const header = req.headers["content-type"] ?? "";
  return header.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * True for a JSON body on `POST binViewReportSnapshot`. Used as the
 * body-parser `type` test, so the 32 MiB parser parses that route only, and
 * only the media type the default parser would take (`application/json`).
 */
export function isBinViewSnapshotJson(req: RoutedRequest): boolean {
  return (
    req.method === "POST" &&
    typeof req.path === "string" &&
    BIN_VIEW_SNAPSHOT_PATH_RE.test(req.path) &&
    mediaType(req) === "application/json"
  );
}

/** body-parser's error for a body above `limit` (an http-errors 413). */
function isBodyTooLarge(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: unknown }).type === "entity.too.large" &&
    (err as { status?: unknown }).status === 413
  );
}

/**
 * Express error middleware placed right after the JSON parsers: turns
 * body-parser's 413 into a Nest `PayloadTooLargeException`. Without it the
 * global exception filter does not recognise the error and answers 500
 * `internal_error` (and counts a server error); with it the caller gets 413
 * `payload_too_large` in the shared envelope. Every other error passes through.
 */
function jsonBodyTooLargeAs413(err: unknown, _req: Request, _res: Response, next: NextFunction): void {
  if (!isBodyTooLarge(err)) {
    next(err);
    return;
  }
  next(
    new PayloadTooLargeException({
      code: "payload_too_large",
      message: "The request body is larger than this route accepts.",
    }),
  );
}

/**
 * Registers the JSON parsers. Call before `app.init()` / `app.listen()`.
 *
 * 1. The route-scoped 32 MiB parser for `binViewReportSnapshot`.
 * 2. The default parser (100 kB) for every other route. It must be registered
 *    here: Nest skips its own default JSON parser at init once any
 *    `jsonParser` is registered, and body-parser skips a body that an earlier
 *    parser already read, so the order above holds.
 * 3. `jsonBodyTooLargeAs413`, so a body above either limit gets 413, not 500.
 *
 * Nest still registers its default urlencoded parser at init, unchanged.
 */
export function registerJsonBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser("json", {
    limit: BIN_VIEW_SNAPSHOT_JSON_LIMIT_BYTES,
    type: isBinViewSnapshotJson,
  });
  app.useBodyParser("json");
  app.use(jsonBodyTooLargeAs413);
}
