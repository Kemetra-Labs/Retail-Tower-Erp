/**
 * RT-1151 (0122, RT-282 PR-07): sale capture inserts the pricing provenance a
 * till sent with a line, and sale reads and Pricing Health read it. The table
 * is append-only for every role (a trigger): no UPDATE, never DELETE or
 * TRUNCATE. The auth lookup role has BYPASSRLS, so any grant would expose
 * every tenant's sale facts.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["sale-line-pricing-provenance-domain-grants.sql"],
  domainRequired: [
    ["sale_line_pricing_provenance", "SELECT"],
    ["sale_line_pricing_provenance", "INSERT"],
  ],
  lookupForbidden: [["sale_line_pricing_provenance", ALL_TABLE_PRIVILEGES]],
  lookupAllowed: [],
};
