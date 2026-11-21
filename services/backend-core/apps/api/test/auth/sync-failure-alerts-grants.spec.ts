/**
 * RT-1034 S13 — the sync-failure alert's grants. The alert sweep READS posting and sale state and
 * writes only its own two tables, so its fragment must name nothing else and never grant DELETE or
 * TRUNCATE. (The generic fragment-vs-script and lookup-role checks are in grant-fragments.spec.ts.)
 */
import { GRANTS } from "../../src/auth/grants/sync-failure-alerts.grants";

const OWN_TABLES = ["sync_failure_alert_deliveries", "sync_failure_alert_windows"];

describe("RT-1034 S13 sync-failure alert grants", () => {
  it("requires only SELECT, INSERT and UPDATE on its two tables", () => {
    const tables = [...new Set(GRANTS.domainRequired.map(([table]) => table))].sort();
    expect(tables).toEqual(OWN_TABLES);
    expect(GRANTS.domainRequired.map(([, privilege]) => privilege).sort()).toEqual(
      ["INSERT", "INSERT", "SELECT", "SELECT", "UPDATE", "UPDATE"],
    );
    expect(GRANTS.domainRequiredColumns ?? []).toEqual([]);
  });

  it("gives no write grant on a posting, reconciliation or sale table", () => {
    const written = GRANTS.domainRequired.map(([table]) => table);
    for (const foreign of ["erpnext_posting_status", "erpnext_reconciliation_run", "sales", "sale_sync_deadletters"]) {
      expect(written).not.toContain(foreign);
    }
  });

  it("forbids every privilege on both tables for the BYPASSRLS lookup role", () => {
    expect(GRANTS.lookupForbidden.map(([table]) => table).sort()).toEqual(OWN_TABLES);
    expect(GRANTS.lookupAllowed).toEqual([]);
  });
});
