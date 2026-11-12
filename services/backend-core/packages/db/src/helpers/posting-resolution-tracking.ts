/**
 * The tracking a posting resolution freezes for each sale line (Jira RT-451
 * S6; migration 0095; contract `erpnext-connector/posting-feed.yaml`
 * 1.10.0-draft `SaleLine.erpnextBatchRef` / `trackingMode`; RT-50 G7-9 rows 1
 * to 3, G7-11).
 *
 * Both writers of a NEW resolution version read the same facts, so the SQL
 * lives here once: the worker's freeze at intent creation (`resolved_by =
 * 'system'`) and the operator re-resolution (`'operator'`). A reversal never
 * calls it: it copies its sale's `sale_post` lineage, tracking included
 * ({@link RESOLUTION_TRACKING_COLUMNS}).
 *
 * Per line, at the moment the version is written:
 *   - `tracking_mode`: the product's Catalog Tracking Profile mode
 *     (`tenant_products.tracking_mode`), `none` | `batch` | `serial`.
 *   - `tracking_identity_id`: only for a `batch` line, the identity it was
 *     sold from. That is the captured identity of a line classified `valid`
 *     or `flagged` (G7-9 rows 1 to 3), or the identity a Tracking Resolution
 *     bound to a row-4 line (`tracking_resolution_lines`, S5). It is joined as
 *     an identity of the line's own product and tenant, the way the S4 effect
 *     writer joins it (`lineFactsSql`), so the effect and the posting name one
 *     identity. NULL for an untracked line, a serial line, and a batch line
 *     captured while tracked selling was off (comment 16269: provenance only).
 *   - `erpnext_batch_ref`: the ERPNext Batch of that identity from the edge
 *     map (`erpnext_tracking_map`, kind `batch`), read now and never
 *     recomputed when the work item is offered. NULL without an edge-map row.
 *   - `erp_hold_cause` (G7-9 row 3, "the ERP posting intent is held, never
 *     sent"): `expired` when capture recorded the line `erp_intent_held` /
 *     `expired`. Expiry was judged at the sale's business date in the store's
 *     time zone, so it is read from that finding and never re-judged later.
 *     Otherwise `edge_map_missing` when the identity has no edge-map row now.
 *     NULL for a line that is not held. `expired` wins when both apply: an
 *     edge map is repaired and re-posted, but an expired lot goes to the owner
 *     (RT-50 B1), so a repair alone must not release it.
 *
 * A LEFT JOIN LATERAL ... ON true, so a line is never dropped: the writers'
 * INSERTs stay all-or-nothing over the sale lines.
 */

/** The four frozen tracking columns, in INSERT order. */
export const RESOLUTION_TRACKING_COLUMNS =
  "tracking_mode, tracking_identity_id, erpnext_batch_ref, erp_hold_cause";

/**
 * A `LEFT JOIN LATERAL` producing alias `trk` with the four columns for the
 * sale line aliased `line` (a `sale_lines` row). Select them with
 * {@link resolutionTrackingSelect}.
 */
export function resolutionTrackingJoin(line: string): string {
  return `LEFT JOIN LATERAL (
      SELECT x.tracking_mode,
             x.identity_id AS tracking_identity_id,
             em.erpnext_ref AS erpnext_batch_ref,
             CASE WHEN x.identity_id IS NULL THEN NULL
                  WHEN EXISTS (
                    SELECT 1 FROM sale_line_findings f
                     WHERE f.sale_line_id = ${line}.id AND f.tenant_id = ${line}.tenant_id
                       AND f.kind = 'erp_intent_held' AND f.cause = 'expired') THEN 'expired'
                  WHEN em.erpnext_ref IS NULL THEN 'edge_map_missing'
             END AS erp_hold_cause
        FROM (SELECT tp.tracking_mode,
                     CASE WHEN tp.tracking_mode <> 'batch' THEN NULL
                          WHEN ${line}.tracking_class IN ('valid', 'flagged') THEN (
                            SELECT ti.id FROM tracking_identities ti
                             WHERE ti.id = ${line}.tracking_identity_id
                               AND ti.tenant_product_ref = ${line}.tenant_product_ref
                               AND ti.tenant_id = ${line}.tenant_id)
                          WHEN ${line}.tracking_class = 'unresolved' THEN (
                            SELECT bi.id FROM tracking_resolution_lines rl
                              JOIN tracking_identities bi
                                ON bi.id = rl.tracking_identity_id
                               AND bi.tenant_product_ref = ${line}.tenant_product_ref
                               AND bi.tenant_id = rl.tenant_id
                             WHERE rl.sale_line_id = ${line}.id AND rl.tenant_id = ${line}.tenant_id)
                     END AS identity_id
                FROM tenant_products tp
               WHERE tp.id = ${line}.tenant_product_ref) x
        LEFT JOIN erpnext_tracking_map em
          ON em.tracking_identity_id = x.identity_id AND em.kind = 'batch'
    ) trk ON true`;
}

/** The select list for {@link resolutionTrackingJoin}'s `trk`, in INSERT order. */
export const resolutionTrackingSelect =
  "trk.tracking_mode, trk.tracking_identity_id, trk.erpnext_batch_ref, trk.erp_hold_cause";
