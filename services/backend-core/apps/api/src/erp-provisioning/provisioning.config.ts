/**
 * RT-1358 — provisioning constants and the few environment settings.
 *
 * The lease is at least 15 minutes (a site create takes up to about 110 s and a
 * provisioner checks the remaining lease before a long step). The template is
 * the code-owned `egypt-retail` v1 frozen into every request (RT-1352 OD-2).
 */
import { MIN_LEASE_TTL_MS } from "./provisioning-state";

export const TEMPLATE_ID = "egypt-retail";
export const TEMPLATE_VERSION = 1;
export const LOCALE_V1 = { country: "EG", currency: "EGP", timezone: "Africa/Cairo" } as const;
export const DEFAULT_LANGUAGE = "ar";

/** The system actor seeded by migration 0109. It owns managed registrations and the provisioner token. */
export const SYSTEM_ACTOR_USER_ID = "00000000-0000-7000-8000-000000001357";

/** The managed credential expiry until automated rotation (PB-E): the 365-day maximum (OD-5). */
export const MANAGED_CREDENTIAL_EXPIRY_DAYS = 365;
/** The provisioner credential is short-lived: at most 30 days (contract). */
export const PROVISIONER_CREDENTIAL_EXPIRY_DAYS = 30;

/** The server-side lease: the contract floor, fixed (no environment setting, so no deploy change). */
export const LEASE_TTL_MS = MIN_LEASE_TTL_MS;

/** `t` + the first 20 hex digits of the tenant id + `-` + the deployment environment (never slug or business name). */
export function deriveSiteName(tenantId: string, environment: string): string {
  return `t${tenantId.replace(/-/g, "").toLowerCase().slice(0, 20)}-${environment}`;
}
