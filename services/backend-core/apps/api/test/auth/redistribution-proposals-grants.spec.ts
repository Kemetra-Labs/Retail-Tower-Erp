/**
 * RT-1600 — the redistribution proposals' grants. The runtime writes only its own two tables (the W3 draft Transfers an
 * accept creates use the shipment Transfer grants), so its fragment names nothing else and never grants DELETE or
 * TRUNCATE. (The generic fragment-vs-script and lookup-role checks are in grant-fragments.spec.ts.)
 */
import { GRANTS } from "../../src/auth/grants/redistribution-proposals.grants";

const OWN_TABLES = ["redistribution_proposal_lines", "redistribution_proposals"];

describe("RT-1600 redistribution proposal grants", () => {
  it("requires only SELECT, INSERT and UPDATE on its two tables", () => {
    expect([...new Set(GRANTS.domainRequired.map(([table]) => table))].sort()).toEqual(OWN_TABLES);
    expect(GRANTS.domainRequired.map(([, privilege]) => privilege).sort()).toEqual(
      ["INSERT", "INSERT", "SELECT", "SELECT", "UPDATE", "UPDATE"],
    );
    expect(GRANTS.domainRequiredColumns ?? []).toEqual([]);
  });

  it("forbids every privilege on both tables for the BYPASSRLS lookup role", () => {
    expect(GRANTS.lookupForbidden.map(([table]) => table).sort()).toEqual(OWN_TABLES);
    expect(GRANTS.lookupAllowed).toEqual([]);
  });
});
