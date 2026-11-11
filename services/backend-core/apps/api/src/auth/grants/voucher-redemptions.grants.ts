/**
 * RT-1111 (0092): the voucher redemption runtime (R-3) writes one intent per
 * validate (INSERT), reads it at redeem and consumes it by a conditional UPDATE
 * of `consumed_at` only; it inserts one redemption per redeem and reverses it
 * by a conditional UPDATE of `reversed_at` and `reversed_by_device_id` only
 * (column-level UPDATE, the RT-1249 mechanism, so the domain role can never
 * rewrite an amount, token hash or voucher id). No DELETE policy on either
 * table; never DELETE or TRUNCATE. The auth lookup role has BYPASSRLS, so any
 * grant would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["voucher-redemptions-domain-grants.sql"],
  domainRequired: [
    ["voucher_redemption_intents", "SELECT"],
    ["voucher_redemption_intents", "INSERT"],
    ["voucher_redemptions", "SELECT"],
    ["voucher_redemptions", "INSERT"],
  ],
  domainRequiredColumns: [
    ["voucher_redemption_intents", "consumed_at", "UPDATE"],
    ["voucher_redemptions", "reversed_at", "UPDATE"],
    ["voucher_redemptions", "reversed_by_device_id", "UPDATE"],
  ],
  lookupForbidden: [
    ["voucher_redemption_intents", ALL_TABLE_PRIVILEGES],
    ["voucher_redemptions", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
