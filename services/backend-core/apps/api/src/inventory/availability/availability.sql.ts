/**
 * RT-1577 (RT-1511 S2) — the SQL predicates of the Available-to-Sell rules (A-1, A-2), written once.
 * `availability.query.ts` (one product, `OnHand.availability`) and `availability.snapshot.query.ts` (a page of products,
 * `posGetStoreAvailability`) both build their statements from them, so the Console number and the till number cannot
 * drift apart. The db spec also asserts that every snapshot item equals the one-product read.
 *
 * Aliases: `m` stock_movements, `loc` the store's primary stock location, `ti` tracking_identities, `biz` the store's
 * business date, `r` inventory_reservations.
 */

/**
 * A-1: a movement counts when it is `sellable` at the primary location. A movement recorded before 0044 has no location
 * or status and is read as (the primary location, `sellable`) (G4-5).
 */
export const MOVEMENT_SELLABLE_AT_PRIMARY_SQL = `COALESCE(m.inventory_status, 'sellable') = 'sellable'
            AND COALESCE(m.stock_location_id, loc.id) = loc.id`;

/** A-1, 859: a lot is sellable THROUGH its expiry date (G7-5), so only an expiry before the business date is expired. */
export const LOT_EXPIRED_SQL = `ti.expiry_date IS NOT NULL AND ti.expiry_date < biz.d`;

/** A-2: a reservation reduces ATS while it is `active` AND not lapsed, even before any sweep marks it `expired`. */
export const RESERVATION_ACTIVE_SQL = `r.state = 'active' AND r.expires_at > now()`;
