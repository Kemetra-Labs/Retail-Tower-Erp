/**
 * The console 429 shape for this surface — RT-1439 (`console-force-actions.openapi.yaml`
 * `ForceActionTooManyRequests`): the canonical envelope with a non-disclosing message,
 * `Retry-After` (1 to 3600 seconds), `Cache-Control: no-store` and `X-Request-Id` (equal to the
 * body's `request_id`). Same shape the console rate-limit guard writes.
 */
import { HttpException, HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";

import { assignRequestId } from "../../common/request-id.interceptor";

const MIN_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 3600;

/** Thrown by a service; the controller turns it into the 429 with its headers. */
export class ConsoleActionRateLimited extends Error {
  constructor(
    readonly code: "force_action_rate_limited" | "reauth_rate_limited",
    readonly retryAfterSeconds: number,
  ) {
    super(code);
    this.name = "ConsoleActionRateLimited";
  }
}

/** Set the 429 headers on the response and return the exception to throw. */
export function consoleRateLimited(
  err: ConsoleActionRateLimited,
  request: Pick<Request, "headers"> & { requestId?: string },
  response: Pick<Response, "setHeader">,
): HttpException {
  assignRequestId(request, response);
  const seconds = Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil(err.retryAfterSeconds)));
  response.setHeader("Retry-After", String(seconds));
  response.setHeader("Cache-Control", "no-store");
  return new HttpException({ code: err.code, message: "Too many requests." }, HttpStatus.TOO_MANY_REQUESTS);
}
