/**
 * RT-1565 (RT-285 F-1, owner decisions OQ-1 and OQ-2): seller attribution per sale line and payment
 * receiver per tender.
 *
 *   - {@link splitSaleAttribution}: the capture body without `lines[].sellerUserId` and
 *     `tenders[].receivedByUserId`, and those values on their own. The attribution is a stored fact but not
 *     a hashed one (owner choice, RT-1565 comment 18562, following `operatorUserId`): an old till's body
 *     and a new till's body for the same sale hash the same, and a retry that names another seller replays
 *     the first capture instead of a 409.
 *   - {@link resolveSaleAttribution}: on a FIRST capture, checks every named seller and receiver once and
 *     freezes each seller's snapshot (user, the sale's store, the role held). Any miss is one 422
 *     `sale_seller_refused` with nothing recorded, never naming which or why.
 *
 * Who counts (checked at the sale's `occurredAt`, so a sale rung offline still syncs after the member
 * later leaves): a membership of this tenant that was not revoked or soft-deleted at `occurredAt`, a user
 * not deleted at `occurredAt`, and access to the sale's store (`store_access_kind = 'all'` or a
 * `store_access` row) as it stands now. The membership's start is not checked: `created_at` is the
 * server's clock and the sale's `occurredAt` is the till's, so a member added minutes before a sale on a
 * slow till clock is not refused. Any role may sell or receive; the role is frozen, not filtered.
 *
 * The Transaction Operator is unchanged (`sales.created_by`): seller and receiver are separate facts.
 */
import type { PoolClient } from "pg";

import { usersLiveAt } from "../../auth";
import { attributableMembersAt } from "../../memberships";
import type { CaptureSaleRequestDto } from "./dto/capture-sale-request.dto";
import { SaleSellerRefusedError } from "./sale-errors";

/** The attribution named in a capture body, in body order; null where none was named. */
export interface SaleAttribution {
  readonly lineSellers: ReadonlyArray<string | null>;
  readonly tenderReceivers: ReadonlyArray<string | null>;
}

/** A seller frozen on a line at capture (Policy §8: employee, store and role at sale time). */
export interface SellerSnapshot {
  readonly userId: string;
  readonly storeId: string;
  readonly roleId: string;
}

/** The checked attribution, in body order. */
export interface ResolvedSaleAttribution {
  readonly lineSellers: ReadonlyArray<SellerSnapshot | null>;
  readonly tenderReceivers: ReadonlyArray<string | null>;
}

export const NO_ATTRIBUTION: SaleAttribution = { lineSellers: [], tenderReceivers: [] };

/**
 * Split the attribution out of the body. Returns new objects; `body` is not changed. A body that names no
 * seller and no receiver comes back with the same keys it had, so its payload hash is the one it had
 * before RT-1565.
 */
export function splitSaleAttribution<B extends Pick<CaptureSaleRequestDto, "lines" | "tenders">>(
  body: B,
): { readonly body: B; readonly attribution: SaleAttribution } {
  // The capture pipe guarantees arrays; a caller that skipped it (a unit test driving the controller with
  // marker values) gets a non-array back unchanged, as `saleFactsOf` does for a quarantined body.
  const lineSellers: Array<string | null> = [];
  const lines = Array.isArray(body.lines)
    ? body.lines.map(({ sellerUserId, ...line }) => {
        lineSellers.push(sellerUserId ?? null);
        return line;
      })
    : body.lines;
  const tenderReceivers: Array<string | null> = [];
  const tenders = Array.isArray(body.tenders)
    ? body.tenders.map(({ receivedByUserId, ...tender }) => {
        tenderReceivers.push(receivedByUserId ?? null);
        return tender;
      })
    : body.tenders;
  const stripped = { ...body, lines, ...(tenders === undefined ? {} : { tenders }) } as B;
  return { body: stripped, attribution: { lineSellers, tenderReceivers } };
}

/** True when the body named at least one seller or receiver. */
export function hasSaleAttribution(attribution: SaleAttribution): boolean {
  return [...attribution.lineSellers, ...attribution.tenderReceivers].some((id) => id !== null);
}

/**
 * Check and freeze the attribution of a first capture, on the capture's tenant-context client (RLS). With
 * nothing named it reads nothing and returns all-null. The membership side is the `memberships` port and the
 * user side the `auth` port (RT-1453 boundaries), each read once for every distinct id.
 */
export async function resolveSaleAttribution(
  client: PoolClient,
  sale: { readonly tenantId: string; readonly storeId: string; readonly occurredAt: string },
  attribution: SaleAttribution,
): Promise<ResolvedSaleAttribution> {
  const named = [...attribution.lineSellers, ...attribution.tenderReceivers].flatMap((id) =>
    id === null ? [] : [id.toLowerCase()],
  );
  let roles: ReadonlyMap<string, string> = new Map();
  if (named.length > 0) {
    const userIds = [...new Set(named)];
    const at = sale.occurredAt;
    roles = await attributableMembersAt(client, { tenantId: sale.tenantId, storeId: sale.storeId, userIds, at });
    const live = await usersLiveAt(client, { userIds, at });
    if (userIds.some((id) => !roles.has(id) || !live.has(id))) throw new SaleSellerRefusedError();
  }
  const lineSellers = attribution.lineSellers.map((id): SellerSnapshot | null => {
    if (id === null) return null;
    const userId = id.toLowerCase();
    return { userId, storeId: sale.storeId, roleId: roles.get(userId)! };
  });
  const tenderReceivers = attribution.tenderReceivers.map((id) => (id === null ? null : id.toLowerCase()));
  return { lineSellers, tenderReceivers };
}
