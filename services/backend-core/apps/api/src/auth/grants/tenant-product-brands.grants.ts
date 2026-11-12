/**
 * RT-1334 (0097, RT-286 spec 048 S1): the console catalog brand runtime lists
 * and creates brands (SELECT + INSERT) and renames one (column-level UPDATE on
 * `name` only, RT-1249 mechanism), so the domain role can never move a brand
 * to another tenant or rewrite `created_by`. No DELETE policy; never DELETE or
 * TRUNCATE. `tenant_products.brand_id` rides the baseline `tenant_products`
 * grants. The auth lookup role has BYPASSRLS, so any grant would expose every
 * tenant's brands.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["tenant-product-brands-domain-grants.sql"],
  domainRequired: [
    ["tenant_product_brands", "SELECT"],
    ["tenant_product_brands", "INSERT"],
  ],
  domainRequiredColumns: [["tenant_product_brands", "name", "UPDATE"]],
  lookupForbidden: [["tenant_product_brands", ALL_TABLE_PRIVILEGES]],
  lookupAllowed: [],
};
