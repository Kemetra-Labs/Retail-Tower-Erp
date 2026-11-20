/**
 * RT-1484 — the tenant Pricing Revision a read evaluates at, shared by the structure (PR-09a) and
 * inquiry (PR-08b) surfaces: an explicit `as_of_revision` must not be above the tenant's head
 * (422 `pricing_revision_unknown`); without one, the head (null before the first publish).
 */
import type { PoolClient } from "pg";

/** 422 `pricing_revision_unknown`: an explicit `as_of_revision` above the tenant's head (or none published). */
export class PricingRevisionUnknownError extends Error {
  constructor() {
    super("pricing revision unknown");
    this.name = "PricingRevisionUnknownError";
  }
}

/** The revision to read at: the explicit one (422 above the head), else the head (null: none yet). */
export async function pricingRevisionAt(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  requested: number | undefined,
): Promise<number | null> {
  const r = await client.query<{ head: string | null }>(
    `SELECT max(revision_no)::text AS head FROM pricing_revisions WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  const head = r.rows[0]?.head ?? null;
  if (requested === undefined) return head === null ? null : Number(head);
  if (head === null || BigInt(requested) > BigInt(head)) throw new PricingRevisionUnknownError();
  return requested;
}
