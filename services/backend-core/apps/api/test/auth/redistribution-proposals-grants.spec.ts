/**
 * RT-1600 — the redistribution proposals' grants. The runtime writes only its own two tables (the W3 draft Transfers an
 * accept creates use the shipment Transfer grants), so its fragment names nothing else and never grants DELETE or
 * TRUNCATE. (The generic fragment-vs-script and lookup-role checks are in grant-fragments.spec.ts.)
 */
import { ALL_TABLE_PRIVILEGES } from "../../src/auth/grant-fragment";
import { GRANTS } from "../../src/auth/grants/redistribution-proposals.grants";

const OWN_TABLES = ["redistribution_proposal_lines", "redistribution_proposals"];

describe("RT-1600 redistribution proposal grants", () => {
  it("requires only SELECT, INSERT and UPDATE on its two tables", () => {
    // The exact (table, privilege) pairs, so a missing or duplicated pair on either table fails (review, PR #901).
    expect(GRANTS.domainRequired.map(([table, privilege]) => `${table}:${privilege}`).sort()).toEqual(
      OWN_TABLES.flatMap((table) => ["INSERT", "SELECT", "UPDATE"].map((privilege) => `${table}:${privilege}`)).sort(),
    );
    expect(GRANTS.domainRequiredColumns ?? []).toEqual([]);
  });

  it("forbids every privilege on both tables for the BYPASSRLS lookup role", () => {
    expect([...GRANTS.lookupForbidden].sort(([a], [b]) => a.localeCompare(b))).toEqual(
      OWN_TABLES.map((table) => [table, ALL_TABLE_PRIVILEGES]),
    );
    expect(GRANTS.lookupAllowed).toEqual([]);
  });
});
