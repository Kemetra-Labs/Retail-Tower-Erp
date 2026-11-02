/**
 * RT-1066 (0078): the console stock-levels surface reads a product's levels,
 * creates a level (INSERT) and replaces or retires it (UPDATE; a retire sets
 * `retired_at`). No DELETE policy; never DELETE or TRUNCATE.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["product-stock-levels-domain-grants.sql"],
  domainRequired: [
    ["product_stock_levels", "SELECT"],
    ["product_stock_levels", "INSERT"],
    ["product_stock_levels", "UPDATE"],
  ],
  lookupForbidden: [["product_stock_levels", ALL_TABLE_PRIVILEGES]],
  lookupAllowed: [],
};
