#!/usr/bin/env node
/**
 * pricing-legacy-import — Jira RT-1485 (spec 044 PR-16a-2a). Operator CLI: the initial legacy price
 * import of ONE tenant into Pricing (its Book, default Zone and `legacy_import` revision 1). It adds
 * no HTTP route and no scheduled job.
 *
 *   node dist/cli/pricing-legacy-import.js run --tenant <uuid> --actor <user uuid> --currency EGP \
 *     --tax-basis inclusive [--reference-zone Africa/Cairo] [--dry-run] [--json]
 *
 * Environment: DATABASE_URL (the domain role). The import runs in one transaction under the tenant
 * pin and `app.system_privilege = 'pricing_legacy_import'` (its only call site), so RLS limits it to
 * that tenant. Not on a real tenant before the PR-03E census is attached to RT-1485.
 * Exit codes: 0 imported / no change / dry run · 1 failed · 2 usage · 3 refused.
 */
import { runWithSystemPrivilege } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import { Pool } from "pg";

import { runLegacyImport } from "../pricing";
import { runImportCli, type ImportCliIo } from "./pricing-legacy-import/cli";

export const runFromEnv =
  (env: NodeJS.ProcessEnv, clock: () => Date = () => new Date()): ImportCliIo["run"] =>
  async (args) => {
    const url = (env["DATABASE_URL"] ?? "").trim();
    if (url === "") throw new Error("DATABASE_URL is required");
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      return await runWithSystemPrivilege(pool, { tenantId: args.tenantId, privilege: "pricing_legacy_import" }, (client) =>
        runLegacyImport(client, {
          tenantId: args.tenantId,
          inputs: args.inputs,
          actorUserId: args.actorUserId,
          correlationId: newId(),
          at: clock(),
          dryRun: args.dryRun,
        }),
      );
    } finally {
      await pool.end();
    }
  };

/* istanbul ignore next -- process wiring only; runImportCli and runFromEnv carry the logic */
if (require.main === module) {
  runImportCli(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    run: runFromEnv(process.env),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // Messages here are ours or the driver's; no credential is ever placed in one.
      process.stderr.write(`pricing-legacy-import failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
