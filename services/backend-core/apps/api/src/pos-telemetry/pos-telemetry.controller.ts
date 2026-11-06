/**
 * POS device telemetry tunnel and its runtime config (RT-1252), contract
 * `pos-telemetry.openapi.yaml`. Design: RT-1251 (Confluence 69500929),
 * OBS-1 §1 "POS fleet refs".
 *
 * Auth: the `device` scheme only (`@DeviceBearer()` + `PosDeviceAuthGuard`),
 * so an unknown, revoked or expired token, or a suspended tenant, is the
 * generic 401 before anything else runs, and tenant, store and device come
 * from the device row, never from the request.
 *
 * `GET config` tells the terminal whether to report: `{ enabled, tunnel,
 * environment }`, or `204` when inert. It never returns the DSN.
 *
 * `POST envelope` rebuilds the envelope with the Console tunnel's allowlist
 * rebuild, stamps `service=pos` and the device's refs, and forwards it to the
 * project named by `POS_SENTRY_DSN`. An event whose `capture_terminal_id`
 * tag is missing or names another device is dropped (R1: an event captured
 * before a move or re-pair is never stamped with the new store). Order:
 * guard (401), inert (204), per-device then global budget (429), media type
 * (415), size (413), envelope (400). Every accepted outcome is the same 204.
 */
import { Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";

import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { RateLimiter } from "../auth/rate-limit";
import { DeviceBearer } from "../auth/route-auth";
import { readForwardEnvelope, withinTelemetryBudget } from "../console-telemetry/tunnel-request";
import type { TenantContextRequest } from "../context/types";
import { deviceScopeOf } from "../pos-cashier-admissions/device-scope";
import { PosTelemetryForwarder } from "./pos-telemetry.forwarder";
import { POS_TELEMETRY_BUCKETS } from "./pos-telemetry.limits";

const ROUTE_PREFIX = "api/pos/v1/telemetry";
const POS_TUNNEL_PATH = `/${ROUTE_PREFIX}/envelope`;

/** Contract `PosTelemetryConfig`. */
export interface PosTelemetryConfig {
  enabled: true;
  tunnel: string;
  environment: string;
}

@Controller(ROUTE_PREFIX)
@DeviceBearer()
@UseGuards(PosDeviceAuthGuard)
export class PosTelemetryController {
  /** The POS forwarder (DSN, refs and stamp) and the shared Redis-backed rate limiter. */
  constructor(
    private readonly forwarder: PosTelemetryForwarder,
    private readonly rateLimiter: RateLimiter,
  ) {}

  @Get("config")
  config(
    @Req() req: TenantContextRequest,
    @Res({ passthrough: true }) res: Response,
  ): PosTelemetryConfig | undefined {
    deviceScopeOf(req);
    res.setHeader("Cache-Control", "no-store");
    const environment = this.forwarder.environment;
    if (environment === null) {
      res.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return { enabled: true, tunnel: POS_TUNNEL_PATH, environment };
  }

  @Post("envelope")
  @HttpCode(HttpStatus.NO_CONTENT)
  async forwardEnvelope(
    @Req() req: TenantContextRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const scope = deviceScopeOf(req);
    const environment = this.forwarder.environment;
    const stamp = this.forwarder.stampFor(scope);
    if (environment === null || stamp === null) return;

    const withinBudget = await withinTelemetryBudget(this.rateLimiter, res, [
      ["pos_telemetry_device", scope.deviceId, POS_TELEMETRY_BUCKETS.perDevice],
      ["pos_telemetry_global", "global", POS_TELEMETRY_BUCKETS.global],
    ]);
    if (!withinBudget) return;

    const envelope = await readForwardEnvelope(req as Request, environment, stamp);
    if (envelope !== null) this.forwarder.forward(envelope);
  }
}
