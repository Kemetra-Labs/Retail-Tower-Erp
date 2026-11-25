/**
 * RT-1461: Docker-free unit tests for `runWithSystemPrivilege`.
 *
 * Proves (a) the privilege is set and read back in ONE statement (a recording client sees exactly one
 * query naming `app.system_privilege`), and (b) the read-back still fails closed: any mismatch of the
 * platform-admin flag, the privilege or the provisioner flag throws, rolls back and runs no work.
 * The real-Postgres behaviour is pinned by 0111-system-privilege-policies.spec.ts and
 * 0120-membership-bootstrap-policies.spec.ts (Testcontainers).
 */
import type { Pool, PoolClient } from "pg";

import { runWithSystemPrivilege } from "../../src/middleware/system-privilege";

const TENANT = "0a000000-0000-7000-8000-00000000a001";

type Row = { admin: string | null; priv: string | null; prov: string | null };

function recording(row: Row | undefined) {
  const sqls: string[] = [];
  const query = jest.fn(async (sql: string) => {
    sqls.push(sql);
    return { rows: sql.includes("app.system_privilege") && sql.includes("current_setting") ? (row ? [row] : []) : [] };
  });
  const release = jest.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, sqls, query, release };
}

describe("runWithSystemPrivilege (RT-1461)", () => {
  it("sets and verifies the privilege in a single statement", async () => {
    const { pool, sqls, query } = recording({ admin: "false", priv: "signup", prov: "" });
    const work = jest.fn().mockResolvedValue("ok");

    await expect(runWithSystemPrivilege(pool, { tenantId: TENANT, privilege: "signup" }, work)).resolves.toBe("ok");

    const privQueries = sqls.filter((s) => s.includes("app.system_privilege"));
    expect(privQueries).toHaveLength(1);
    // The one statement both sets and reads back.
    expect(privQueries[0]).toContain("set_config('app.system_privilege', $1, true)");
    expect(privQueries[0]).toContain("current_setting('app.system_privilege', true)");
    expect(query).toHaveBeenCalledWith(privQueries[0], ["signup"]);
    // BEGIN, tenant pin, platform-admin off, the one privilege statement, COMMIT: nothing else.
    expect(sqls).toHaveLength(5);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[4]).toBe("COMMIT");
    expect(work).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Row | undefined]>([
    ["platform admin flag on", { admin: "true", priv: "signup", prov: "" }],
    ["platform admin flag unset", { admin: null, priv: "signup", prov: "" }],
    ["privilege not applied", { admin: "false", priv: "", prov: "" }],
    ["a different privilege", { admin: "false", priv: "provisioning_sweep", prov: "" }],
    ["provisioner flag on", { admin: "false", priv: "signup", prov: "true" }],
    ["no row returned", undefined],
  ])("fails closed when the read-back mismatches: %s", async (_name, row) => {
    const { pool, sqls, release } = recording(row);
    const work = jest.fn();

    await expect(runWithSystemPrivilege(pool, { tenantId: TENANT, privilege: "signup" }, work)).rejects.toThrow(
      "system privilege context: the settings did not hold",
    );

    expect(work).not.toHaveBeenCalled();
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
