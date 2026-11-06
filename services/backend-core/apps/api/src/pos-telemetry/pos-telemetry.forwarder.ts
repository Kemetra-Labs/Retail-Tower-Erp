/**
 * Forwards rebuilt POS envelopes to Sentry project `kemetra/pos` (RT-1252).
 *
 * The destination comes only from `POS_SENTRY_DSN`; terminals never hold a
 * DSN (RT-1251 decision D-B). Default-inert: the tunnel is enabled only when
 * both `POS_SENTRY_DSN` is a usable DSN and `POS_TELEMETRY_REF_KEY` is set,
 * so an event can never leave without its refs. Forwarding reuses the Console
 * tunnel's fire-and-forget forwarder (timeout, in-flight bound, no content,
 * DSN or upstream URL in logs).
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";

import { ROOT_LOGGER } from "../common/logging.interceptor";
import {
  SentryEnvelopeForwarder,
  resolveTargetFromDsn,
  type ForwardTarget,
  type TelemetryFetch,
} from "../console-telemetry/console-telemetry.forwarder";
import type { ForwardStamp } from "../console-telemetry/envelope";
import type { DeviceScope } from "../pos-cashier-admissions/device-scope";
import { REF_KEY_VAR, mintFleetRefs, resolveRefKey } from "./pos-telemetry.refs";

export const POS_TELEMETRY_FETCH = "POS_TELEMETRY_FETCH";
const POS_DSN_VAR = "POS_SENTRY_DSN";
/** The OBS-1 §1 `service` for every POS event. */
const POS_SERVICE = "pos";
/** The inbound tag carrying the terminal id the event was captured under (R1). Never forwarded. */
const CAPTURE_TERMINAL_TAG = "capture_terminal_id";

const LABEL = "pos telemetry";

type WarnLogger = Pick<Logger, "warn">;

export interface PosTelemetryTarget {
  readonly target: ForwardTarget;
  readonly refKey: string;
}

/** Both settings, or `null` (inert). Neither value is ever logged. */
export function resolvePosTelemetryTarget(env: NodeJS.ProcessEnv, logger?: WarnLogger): PosTelemetryTarget | null {
  const target = resolveTargetFromDsn(env[POS_DSN_VAR], env, logger, POS_DSN_VAR, LABEL);
  if (target === null) return null;
  const refKey = resolveRefKey(env);
  if (refKey === null) {
    logger?.warn(`${LABEL} disabled: ${REF_KEY_VAR} is unset or too short`);
    return null;
  }
  return { target, refKey };
}

@Injectable()
export class PosTelemetryForwarder extends SentryEnvelopeForwarder {
  private readonly refKey: string | null;

  /** Resolves `POS_SENTRY_DSN` and the ref key once, at boot; inert when either is missing. */
  constructor(
    @Inject(POS_TELEMETRY_FETCH) fetchFn: TelemetryFetch,
    @Optional() @Inject(ROOT_LOGGER) logger?: Logger,
  ) {
    const resolved = resolvePosTelemetryTarget(process.env, logger);
    super(resolved?.target ?? null, fetchFn, logger, LABEL);
    this.refKey = resolved?.refKey ?? null;
  }

  /**
   * How to stamp an envelope from this device: `service=pos`, the three refs
   * minted from the device row, and the R1 rule that the event was captured
   * under this same device. `null` when the tunnel is inert.
   */
  stampFor(scope: DeviceScope): ForwardStamp | null {
    if (this.refKey === null) return null;
    const refs = mintFleetRefs(this.refKey, scope);
    return {
      service: POS_SERVICE,
      extraTags: { ...refs },
      requiredTag: { key: CAPTURE_TERMINAL_TAG, value: scope.deviceId },
      // A raw id inside a message or a frame path becomes its ref (OBS-1 §1).
      replacements: {
        [scope.tenantId]: refs.tenant_ref,
        [scope.storeId]: refs.store_ref,
        [scope.deviceId]: refs.terminal_ref,
      },
    };
  }
}
