#!/usr/bin/env node
/**
 * transfer-drift — Jira RT-1517. Read-only operator report of the legacy instant-transfer legs still `not_posted` (the
 * ERPNext drift they left), for one tenant, grouped by store. It adds no HTTP route and changes no state.
 *
 *   node dist/cli/transfer-drift.js report --tenant <uuid> [--json]
 *
 * Environment: DATABASE_URL (the domain role). The read runs inside the tenant's context, so RLS limits it to that
 * tenant; there is no cross-tenant mode. Exit codes: 0 ok · 1 failed · 2 usage.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import { Pool } from "pg";

import { listLegacyTransferDrift } from "../inventory";
import { runTransferDriftCli, type DriftCliIo } from "./transfer-drift/cli";

export const connectFromEnv =
  (env: NodeJS.ProcessEnv): DriftCliIo["connect"] =>
  async (tenantId) => {
    const url = (env["DATABASE_URL"] ?? "").trim();
    if (url === "") throw new Error("DATABASE_URL is required");
    const pool = new Pool({ connectionString: url, max: 1 });
    return {
      list: () =>
        runWithTenantContext(pool, { tenantId, isPlatformAdmin: false }, (client) => listLegacyTransferDrift(client, tenantId)),
      close: async () => {
        await pool.end();
      },
    };
  };

/* istanbul ignore next -- process wiring only; runTransferDriftCli and connectFromEnv carry the logic */
if (require.main === module) {
  runTransferDriftCli(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    connect: connectFromEnv(process.env),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // Messages here are ours or the driver's; no credential is ever placed in one.
      process.stderr.write(`transfer-drift failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
