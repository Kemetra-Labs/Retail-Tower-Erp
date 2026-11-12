/**
 * RT-1336 (0101, RT-286 spec 048 S3): the Offer Engine V1 runtime (RT-1337)
 * reads and inserts on all ten tables. UPDATE is column-level only (RT-1249
 * mechanism): the offer draft, end and archive; a pause's resume; a store's
 * applied Pack revision; and closing a materialised eligible-set row. The 0101
 * guard triggers bound each of those further. Versions, their scope and rules,
 * Pack revisions, sale promotion facts and clawbacks are append-only (no
 * UPDATE). No DELETE policy anywhere; never DELETE or TRUNCATE. The auth lookup
 * role has BYPASSRLS, so any grant would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["offer-engine-domain-grants.sql"],
  domainRequired: [
    ["offers", "SELECT"],
    ["offers", "INSERT"],
    ["offer_versions", "SELECT"],
    ["offer_versions", "INSERT"],
    ["offer_version_stores", "SELECT"],
    ["offer_version_stores", "INSERT"],
    ["offer_version_rules", "SELECT"],
    ["offer_version_rules", "INSERT"],
    ["offer_pauses", "SELECT"],
    ["offer_pauses", "INSERT"],
    ["offer_pack_revisions", "SELECT"],
    ["offer_pack_revisions", "INSERT"],
    ["offer_pack_store_revisions", "SELECT"],
    ["offer_pack_store_revisions", "INSERT"],
    ["offer_pack_eligible_products", "SELECT"],
    ["offer_pack_eligible_products", "INSERT"],
    ["sale_line_promotions", "SELECT"],
    ["sale_line_promotions", "INSERT"],
    ["sale_return_promotion_clawbacks", "SELECT"],
    ["sale_return_promotion_clawbacks", "INSERT"],
  ],
  domainRequiredColumns: [
    ["offers", "draft_revision", "UPDATE"],
    ["offers", "draft_definition", "UPDATE"],
    ["offers", "draft_updated_at", "UPDATE"],
    ["offers", "draft_updated_by_user_id", "UPDATE"],
    ["offers", "ended_at", "UPDATE"],
    ["offers", "ended_by_user_id", "UPDATE"],
    ["offers", "archived_at", "UPDATE"],
    ["offers", "archived_by_user_id", "UPDATE"],
    ["offer_pauses", "resumed_at", "UPDATE"],
    ["offer_pauses", "resumed_by_user_id", "UPDATE"],
    ["offer_pack_store_revisions", "applied_revision", "UPDATE"],
    ["offer_pack_eligible_products", "to_revision", "UPDATE"],
  ],
  lookupForbidden: [
    ["offers", ALL_TABLE_PRIVILEGES],
    ["offer_versions", ALL_TABLE_PRIVILEGES],
    ["offer_version_stores", ALL_TABLE_PRIVILEGES],
    ["offer_version_rules", ALL_TABLE_PRIVILEGES],
    ["offer_pauses", ALL_TABLE_PRIVILEGES],
    ["offer_pack_revisions", ALL_TABLE_PRIVILEGES],
    ["offer_pack_store_revisions", ALL_TABLE_PRIVILEGES],
    ["offer_pack_eligible_products", ALL_TABLE_PRIVILEGES],
    ["sale_line_promotions", ALL_TABLE_PRIVILEGES],
    ["sale_return_promotion_clawbacks", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
