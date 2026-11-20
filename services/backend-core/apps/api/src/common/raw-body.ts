/**
 * The capped raw reader of a file-upload route (RT-473 S2 logo upload, spec 039
 * FR-04; RT-1505 product import upload, spec 049 §8.5).
 *
 * A route that takes raw file bytes under ANY `Content-Type` keeps Nest's JSON
 * and urlencoded parsers off its body (a route-specific passthrough middleware
 * registered before them) and reads the stream itself, AFTER the route's
 * guards, with the cap on `Content-Length` and while streaming, so an
 * oversized body is never buffered whole and a 401 / 403 / 404 never waits for
 * a body.
 */
import { BadRequestException, PayloadTooLargeException } from "@nestjs/common";
import type { Request } from "express";

type BodyStream = Pick<Request, "headers" | "on" | "off" | "resume" | "readableEnded" | "body">;

/** What differs between the routes that share the reader. */
export interface RawBodyRules {
  readonly maxBytes: number;
  /** The 413 `file_too_large` message (it names the route's limit). */
  readonly tooLargeMessage: string;
  /** The plain `Error` (a 500) when a body parser already consumed the body: names the passthrough that was not wired. */
  readonly unwiredMessage: string;
  /** When set, a body not complete within this many milliseconds is dropped with {@link RawBodyTimeoutError} (a slow sender must not hold a slot). */
  readonly timeoutMs?: number;
}

/** The body did not arrive in time: a 400 `validation_error` (the contract has no 408), and the caller should close the connection. */
export class RawBodyTimeoutError extends BadRequestException {
  constructor() {
    super({ code: "validation_error", message: "The request body was not received in time." });
  }
}

function tooLarge(rules: RawBodyRules): PayloadTooLargeException {
  return new PayloadTooLargeException({ code: "file_too_large", message: rules.tooLargeMessage });
}

function empty(): BadRequestException {
  return new BadRequestException({ code: "validation_error", message: "The request body is empty." });
}

/** Resolves the body bytes; 413 `file_too_large` past `maxBytes`, 400 when empty or aborted. */
export function readRawBody(req: BodyStream, rules: RawBodyRules): Promise<Buffer> {
  // A parsed body means the passthrough was not wired before the parsers: a
  // deployment bug, never a client error (500).
  if (req.body !== undefined && !Buffer.isBuffer(req.body)) return Promise.reject(new Error(rules.unwiredMessage));
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > rules.maxBytes) {
    req.resume();
    return Promise.reject(tooLarge(rules));
  }
  if (req.readableEnded) return Promise.reject(empty());

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer =
      rules.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            cleanup();
            reject(new RawBodyTimeoutError());
          }, rules.timeoutMs);
    timer?.unref();
    const cleanup = (): void => {
      if (timer !== null) clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total <= rules.maxBytes) {
        chunks.push(chunk);
        return;
      }
      cleanup();
      req.resume();
      reject(tooLarge(rules));
    };
    const onEnd = (): void => {
      cleanup();
      if (total === 0) reject(empty());
      else resolve(Buffer.concat(chunks, total));
    };
    const onError = (): void => {
      cleanup();
      reject(new BadRequestException({ code: "validation_error", message: "The request body could not be read." }));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
