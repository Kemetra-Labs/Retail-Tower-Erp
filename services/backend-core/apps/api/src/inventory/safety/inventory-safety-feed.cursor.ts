/**
 * The opaque snapshot page token of the POS inventory safety feed — Jira
 * RT-449 PR 2 (`inventory/inventory-safety-feed.yaml`).
 *
 * base64url JSON `{ t, s, r, a }`: the device's tenant and store, the
 * snapshot's Safety Revision (every page answers the first page's) and the
 * last hold id served. A token that is malformed, or was issued to another
 * (tenant, store), is a non-disclosing 404 at the controller, as the
 * catalogue read-down's (`catalog/read-down/read-down.cursor.ts`).
 */
import { isJsonObject } from '../../catalog/read-down/read-down.cursor';

/** A malformed or foreign page token. */
export class SafetyFeedCursorError extends Error {}

export interface SafetyFeedPageToken {
  readonly tenantId: string;
  readonly storeId: string;
  /** The snapshot's revision. */
  readonly revision: number;
  /** The last hold id served; the next page starts after it. */
  readonly afterHoldId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodePageToken(token: SafetyFeedPageToken): string {
  return Buffer.from(
    JSON.stringify({ t: token.tenantId, s: token.storeId, r: token.revision, a: token.afterHoldId }),
    'utf8',
  ).toString('base64url');
}

/** Decode a page token and check it belongs to the caller's (tenant, store). */
export function decodePageToken(token: string, tenantId: string, storeId: string): SafetyFeedPageToken {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new SafetyFeedCursorError('malformed page token');
  }
  if (!isJsonObject(payload)) throw new SafetyFeedCursorError('malformed page token');
  const { t, s, r, a } = payload;
  if (t !== tenantId || s !== storeId) throw new SafetyFeedCursorError('page token scope mismatch');
  if (typeof r !== 'number' || !Number.isSafeInteger(r) || r < 0) {
    throw new SafetyFeedCursorError('malformed page token');
  }
  if (typeof a !== 'string' || !UUID.test(a)) throw new SafetyFeedCursorError('malformed page token');
  return { tenantId, storeId, revision: r, afterHoldId: a };
}
