/**
 * RT-1600 (0135): the W9 redistribution proposals. A proposal and its lines change state (supersede, review, accept,
 * reject), so both hold SELECT, INSERT and UPDATE. Never DELETE or TRUNCATE (history is kept; TRUNCATE ignores row
 * security). The W3 draft Transfers an accept creates use the shipment Transfer grants, not new ones.
 * The auth lookup role has BYPASSRLS, so any grant would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["redistribution-proposals-domain-grants.sql"],
  domainRequired: [
    ["redistribution_proposals", "SELECT"],
    ["redistribution_proposals", "INSERT"],
    ["redistribution_proposals", "UPDATE"],
    ["redistribution_proposal_lines", "SELECT"],
    ["redistribution_proposal_lines", "INSERT"],
    ["redistribution_proposal_lines", "UPDATE"],
  ],
  lookupForbidden: [
    ["redistribution_proposals", ALL_TABLE_PRIVILEGES],
    ["redistribution_proposal_lines", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
