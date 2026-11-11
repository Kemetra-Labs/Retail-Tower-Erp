/**
 * RT-1107 (0091): the voucher issuance runtime (RT-1108) creates vouchers by
 * INSERT, reads them, and cancels one by a conditional UPDATE of its status;
 * `voucher_eligible_stores` is written once at issue (SELECT + INSERT only).
 * No DELETE policy on either table; never DELETE or TRUNCATE. The auth lookup
 * role has BYPASSRLS, so any grant would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["vouchers-domain-grants.sql"],
  domainRequired: [
    ["vouchers", "SELECT"],
    ["vouchers", "INSERT"],
    ["vouchers", "UPDATE"],
    ["voucher_eligible_stores", "SELECT"],
    ["voucher_eligible_stores", "INSERT"],
  ],
  lookupForbidden: [
    ["vouchers", ALL_TABLE_PRIVILEGES],
    ["voucher_eligible_stores", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
