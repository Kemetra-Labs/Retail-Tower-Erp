/**
 * RT-1577 (RT-1511 S2) — the opaque page cursor of `posGetStoreAvailability`.
 *
 * base64url JSON `{ t, s, a }`: the device's tenant and store and the last product SCANNED; the next page starts after it
 * (products are walked in `tenant_products.id` order). A token that is malformed, or was issued to another (tenant,
 * store), is a non-disclosing 404 at the controller, as the catalogue read-down's page token and the safety feed's.
 */
import { anyJsonObject, decodeOpaque, encodeOpaque } from '../../common/cursor/opaque-cursor';
import { UUID_RE_I } from '../../common/ids';

/** A malformed or foreign cursor. */
export class AvailabilityCursorError extends Error {}

export function encodeAvailabilityCursor(input: {
  readonly tenantId: string;
  readonly storeId: string;
  readonly afterProductId: string;
}): string {
  return encodeOpaque({ t: input.tenantId, s: input.storeId, a: input.afterProductId });
}

/** The product after which the page starts, once the cursor is checked against the caller's (tenant, store). */
export function decodeAvailabilityCursor(token: string, tenantId: string, storeId: string): string {
  const payload = decodeOpaque(token, anyJsonObject, () => new AvailabilityCursorError('malformed cursor'));
  if (payload.t !== tenantId || payload.s !== storeId) throw new AvailabilityCursorError('cursor scope mismatch');
  if (typeof payload.a !== 'string' || !UUID_RE_I.test(payload.a)) throw new AvailabilityCursorError('malformed cursor');
  return payload.a;
}
