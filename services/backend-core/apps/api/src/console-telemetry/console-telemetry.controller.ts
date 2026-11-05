/**
 * Console Sentry tunnel and its runtime config (RT-632, OBS-3), contract
 * `console-telemetry.openapi.yaml`.
 *
 * `GET config` tells the immutable Console bundle whether to start its SDK:
 * `{ tunnel, environment }`, or `204` when inert. It never returns the DSN;
 * the Console uses a placeholder DSN, which the tunnel ignores.
 *
 * The Admin-Console runs under `connect-src 'self'`, so its Sentry SDK posts
 * envelopes here (`tunnel` option) and this route forwards the scrubbed error
 * event to the Console Sentry project named by `CONSOLE_SENTRY_DSN`.
 *
 * `@Public()` (decision recorded on RT-632): Console errors can happen before
 * sign-in, so no credential is required and the session cookie is never read.
 * Abuse is bounded instead by, in order: a trusted `Origin` (RT-430 rule,
 * missing refused), a per-IP and a global rate limit, the media type and a
 * 64 KiB cap enforced while reading. The order keeps the cheap checks first
 * and reads no body from a caller that is refused.
 *
 * Every accepted outcome is the same `204` (forwarded, dropped by the
 * scrubber, rate-limit store unavailable, or inert), so the response says
 * nothing about the configuration. Nothing here logs the body.
 */
import { Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";

import { assertTrustedOrigin } from "../auth/origin-check";
import { RateLimiter } from "../auth/rate-limit";
import { Public } from "../auth/route-auth";
import { ConsoleTelemetryForwarder } from "./console-telemetry.forwarder";
import { CONSOLE_TELEMETRY_BUCKETS } from "./console-telemetry.limits";
import { readForwardEnvelope, withinTelemetryBudget } from "./tunnel-request";

const ROUTE_PREFIX = "api/v1/console/telemetry";
const TUNNEL_PATH = `/${ROUTE_PREFIX}/envelope`;

/** Contract `ConsoleTelemetryConfig`. */
export interface ConsoleTelemetryConfig {
  tunnel: string;
  environment: string;
}

@Public()
@Controller(ROUTE_PREFIX)
export class ConsoleTelemetryController {
  constructor(
    private readonly forwarder: ConsoleTelemetryForwarder,
    private readonly rateLimiter: RateLimiter,
  ) {}

  @Get("config")
  config(@Res({ passthrough: true }) res: Response): ConsoleTelemetryConfig | undefined {
    res.setHeader("Cache-Control", "no-store");
    const environment = this.forwarder.environment;
    if (environment === null) {
      res.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return { tunnel: TUNNEL_PATH, environment };
  }

  @Post("envelope")
  @HttpCode(HttpStatus.NO_CONTENT)
  async forwardEnvelope(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const environment = this.forwarder.environment;
    if (environment === null) return;
    assertTrustedOrigin(req);
    const ip = String(req.ip ?? req.socket?.remoteAddress ?? "unknown");
    const withinBudget = await withinTelemetryBudget(this.rateLimiter, res, [
      ["console_telemetry_ip", ip, CONSOLE_TELEMETRY_BUCKETS.perIp],
      ["console_telemetry_global", "global", CONSOLE_TELEMETRY_BUCKETS.global],
    ]);
    if (!withinBudget) return;

    const envelope = await readForwardEnvelope(req, environment);
    if (envelope !== null) this.forwarder.forward(envelope);
  }
}
