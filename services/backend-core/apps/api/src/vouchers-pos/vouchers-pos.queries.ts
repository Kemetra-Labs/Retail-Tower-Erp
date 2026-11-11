/**
 * vouchers-pos.queries.ts — RT-1112: the SQL of the V-A runtime.
 *
 * Every statement runs under the device's tenant (RLS, `runWithTenantContext`)
 * and also names `tenant_id`. Rules (RT-1112 c16559, RT-922 section 5.4):
 *
 *   - Every timestamp comes from the database clock. An intent expires at
 *     `now() + INTENT_TTL` (below the 0092 five-minute CHECK); `consumed_at`,
 *     `redeemed_at` and `reversed_at` are `now()`.
 *   - Voucher expiry is `expires_at IS NOT NULL AND expires_at <= clock_timestamp()`:
 *     the wall clock at the statement, not the transaction start, so a redeem
 *     that waited on the voucher row lock past expiry sees it expired. The
 *     final conditional UPDATE carries the same predicate and is the guard; the
 *     read before it only chooses the refusal.
 *   - Eligibility (RT-810 D3/D4): an "all stores" voucher accepts any active,
 *     undeleted store of the tenant, including one created after issue; a subset
 *     voucher only its listed stores, which must also be active and undeleted.
 *   - The SET lists name only the columns the domain role may UPDATE
 *     (`vouchers.grants.ts`, `voucher-redemptions.grants.ts`).
 */

/** The intent lifetime: below the 0092 `voucher_redemption_intents_ttl` CHECK (5 minutes). */
export const INTENT_TTL_SECONDS = 240;

/** `$1` tenant, `$2` the voucher alias `v`, `$3` the device's store: true when `v` is valid there. */
const ELIGIBLE_SQL = `
  EXISTS (
    SELECT 1 FROM stores s
     WHERE s.tenant_id = $1 AND s.id = $3 AND s.is_active AND s.deleted_at IS NULL
       AND (v.applies_to_all_stores OR EXISTS (
         SELECT 1 FROM voucher_eligible_stores e
          WHERE e.tenant_id = $1 AND e.voucher_id = v.id AND e.store_id = $3)))`;

/** `$1` tenant, `$2` code hash, `$3` store: the voucher a typed code names, classified. */
export const VALIDATE_LOOKUP_SQL = `
  SELECT v.id, v.amount_minor::text AS amount_minor, v.status,
         (v.expires_at IS NOT NULL AND v.expires_at <= clock_timestamp()) AS expired,
         ${ELIGIBLE_SQL} AS eligible
    FROM vouchers v
   WHERE v.tenant_id = $1 AND v.code_hash = $2`;

/**
 * `$1` tenant, `$2` store, `$3` voucher, `$4` payment attempt, `$5` applied, `$6`
 * forfeited, `$7` token hash, `$8` cashier, `$9` device. The TTL is a literal.
 */
export const INSERT_INTENT_SQL = `
  INSERT INTO voucher_redemption_intents
    (tenant_id, store_id, voucher_id, payment_attempt_id, applied_amount_minor, forfeited_amount_minor,
     token_hash, operator_user_id, device_id, expires_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '${INTENT_TTL_SECONDS} seconds')
  RETURNING id, expires_at`;

/** `$1` tenant, `$2` token hash: the intent a token names. */
export const INTENT_BY_TOKEN_SQL = `
  SELECT id, store_id, voucher_id, payment_attempt_id,
         applied_amount_minor::text AS applied_amount_minor,
         forfeited_amount_minor::text AS forfeited_amount_minor,
         consumed_at, (expires_at >= now()) AS live
    FROM voucher_redemption_intents
   WHERE tenant_id = $1 AND token_hash = $2`;

/** `$1` tenant, `$2` voucher: take the voucher row lock (one redeem, cancel or reverse at a time). */
export const LOCK_VOUCHER_SQL = `SELECT id FROM vouchers WHERE tenant_id = $1 AND id = $2 FOR UPDATE`;

/**
 * `$1` tenant, `$2` intent: whether it was consumed, read again under the voucher
 * lock (a concurrent redeem of the same token may have consumed it meanwhile).
 */
export const INTENT_CONSUMED_SQL = `
  SELECT consumed_at IS NOT NULL AS consumed FROM voucher_redemption_intents WHERE tenant_id = $1 AND id = $2`;

/**
 * `$1` tenant, `$2` voucher, `$3` store: the voucher's state, read after the
 * lock is held (a separate statement, so `clock_timestamp()` is read after any
 * lock wait).
 */
export const VOUCHER_STATE_SQL = `
  SELECT v.status,
         (v.expires_at IS NOT NULL AND v.expires_at <= clock_timestamp()) AS expired,
         ${ELIGIBLE_SQL} AS eligible
    FROM vouchers v
   WHERE v.tenant_id = $1 AND v.id = $2`;

/** `$1` tenant, `$2` intent: consume it once, only while it is live (c16559). */
export const CONSUME_INTENT_SQL = `
  UPDATE voucher_redemption_intents
     SET consumed_at = now()
   WHERE tenant_id = $1 AND id = $2 AND consumed_at IS NULL AND expires_at >= now()
  RETURNING id`;

/** `$1` tenant, `$2` voucher: the redeem itself, guarded by status and the wall-clock expiry. */
export const REDEEM_VOUCHER_SQL = `
  UPDATE vouchers
     SET status = 'redeemed'
   WHERE tenant_id = $1 AND id = $2 AND status = 'active'
     AND (expires_at IS NULL OR expires_at > clock_timestamp())
  RETURNING id`;

/**
 * `$1` tenant, `$2` store, `$3` voucher, `$4` intent, `$5` payment attempt, `$6`
 * applied, `$7` forfeited, `$8` cashier, `$9` device. The binding columns are the
 * intent's own (the 0092 composite FK refuses anything else).
 */
export const INSERT_REDEMPTION_SQL = `
  INSERT INTO voucher_redemptions
    (tenant_id, store_id, voucher_id, intent_id, payment_attempt_id, applied_amount_minor,
     forfeited_amount_minor, operator_user_id, device_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  RETURNING id, redeemed_at`;

/** `$1` tenant, `$2` redemption: the redemption a reverse names. */
export const REDEMPTION_SQL = `
  SELECT id, store_id, voucher_id, payment_attempt_id, operator_user_id,
         applied_amount_minor::text AS applied_amount_minor, reversed_at
    FROM voucher_redemptions
   WHERE tenant_id = $1 AND id = $2`;

/** `$1` tenant, `$2` redemption, `$3` reversing device: reverse once. */
export const REVERSE_REDEMPTION_SQL = `
  UPDATE voucher_redemptions
     SET reversed_at = now(), reversed_by_device_id = $3
   WHERE tenant_id = $1 AND id = $2 AND reversed_at IS NULL
  RETURNING reversed_at`;

/**
 * `$1` tenant, `$2` voucher: back to `active` with its full value. An expired
 * voucher is restored too (owner decision, RT-1112 c16636): expiry is derived
 * from `expires_at`, so it still answers `voucher_expired` afterwards.
 */
export const RESTORE_VOUCHER_SQL = `
  UPDATE vouchers
     SET status = 'active'
   WHERE tenant_id = $1 AND id = $2 AND status = 'redeemed'
  RETURNING id`;
