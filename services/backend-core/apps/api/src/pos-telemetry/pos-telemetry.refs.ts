/**
 * POS fleet refs (RT-1252; OBS-1 §1 "POS fleet refs", amended by RT-1251).
 *
 * Sentry project `kemetra/pos` may carry `tenant_ref`, `store_ref` and
 * `terminal_ref`: each a truncated HMAC-SHA256 of the device row's id under
 * a Backend-Core secret key, so nothing in Sentry identifies a customer
 * without Backend-Core. The raw ids never leave. Each ref is domain-separated
 * by its kind, so a tenant and a store with the same id get different refs.
 *
 * The key (`POS_TELEMETRY_REF_KEY`) is rotated only on compromise: a new key
 * gives every terminal new refs, which breaks continuity in Sentry.
 */
import { createHmac } from "node:crypto";

import type { DeviceScope } from "../pos-cashier-admissions/device-scope";

export const REF_KEY_VAR = "POS_TELEMETRY_REF_KEY";
/** A key shorter than this is refused (the tunnel stays inert). */
export const MIN_REF_KEY_LENGTH = 32;
/** Hex characters kept from the HMAC (64 bits). */
export const REF_LENGTH = 16;

export interface PosFleetRefs {
  readonly tenant_ref: string;
  readonly store_ref: string;
  readonly terminal_ref: string;
}

/** The key, or `null` when unset, blank or shorter than {@link MIN_REF_KEY_LENGTH}. Never logged. */
export function resolveRefKey(env: NodeJS.ProcessEnv): string | null {
  const raw = env[REF_KEY_VAR]?.trim();
  return raw !== undefined && raw.length >= MIN_REF_KEY_LENGTH ? raw : null;
}

function ref(key: string, kind: string, id: string): string {
  return createHmac("sha256", key).update(`${kind}:${id}`, "utf8").digest("hex").slice(0, REF_LENGTH);
}

/** The three refs of the authenticated device (scope from the device row, never the request). */
export function mintFleetRefs(key: string, scope: DeviceScope): PosFleetRefs {
  return {
    tenant_ref: ref(key, "tenant", scope.tenantId),
    store_ref: ref(key, "store", scope.storeId),
    terminal_ref: ref(key, "terminal", scope.deviceId),
  };
}
