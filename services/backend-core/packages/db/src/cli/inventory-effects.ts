#!/usr/bin/env node
/**
 * Sale-effects activation and anchor comparison — operator CLI (Jira RT-427;
 * owner decisions 3, 4 and 6 of 2026-10-21).
 *
 *   activate --tenant <uuid> --actor <uuid> [--dry-run]
 *     Takes the Inventory Anchor of every store from its latest complete Bin
 *     snapshot and turns the tenant's sale / void / return effects ON, in one
 *     transaction (`activateSaleEffects`). Refuses (exit 4, nothing written)
 *     while a precondition fails; the JSON names the code and the stores.
 *     `--dry-run` runs the same transaction and rolls it back.
 *
 *   compare --tenant <uuid>
 *     Read-only: per store and product, anchor + effects since activation vs
 *     the latest complete Bin snapshot (`compareAnchorsToBin`). Not
 *     pending-aware; the full reconciliation is RT-428.
 *
 *   anchor-identities --tenant <uuid> --actor <uuid> [--dry-run]
 *     RT-453 (G7-12, DC-8): takes the per-identity Inventory Anchor of every
 *     store from its latest complete Bin snapshot's batch-wise evidence, in one
 *     transaction (`anchorTrackedIdentities`). Refuses (exit 4, nothing
 *     written) while sale effects are off, a store's snapshot fails the RT-427
 *     preconditions, a tracked product's entry lacks tracking evidence or
 *     disagrees with its profile, or a reported Batch has no identity yet. It
 *     switches nothing on: tracked selling stays a separate owner act (Q13).
 *
 *   attest-batch-posting --tenant <uuid> --actor <uuid> --evidence <ref> [--dry-run]
 *     RT-452 (G7-11; owner decision 2026-11-12): records the owner's attestation
 *     that the ERP Connector posts batch-tracked lines with their batch
 *     reference, in one transaction (`attestBatchPosting`). `--evidence` is a
 *     reference to the evidence (a Jira comment, a bench run id), 1 to 200
 *     characters, no PII. Upserts the tenant's settings row if missing. Refuses
 *     (exit 4, nothing written) when the tenant already holds an attestation.
 *     It switches nothing on: it only makes the Q13 precondition
 *     `erp_batch_posting_verified` met. There is no un-attest command.
 *
 *   equivalence --tenant <uuid>
 *     Read-only dual-read report for the cutover (RT-428; 977, 980): per
 *     store and product, the legacy raw SUM and the pending-aware expected
 *     ERP book side by side against the latest complete Bin snapshot
 *     (`buildCutoverEquivalenceReport`).
 *
 * There is no deactivate command: turning the flag off is a separate owner
 * decision (981).
 *
 * Reads `DATABASE_URL` (the domain role, as the API and worker use). Every
 * statement runs inside ONE transaction with `app.current_tenant` set to the
 * tenant and `app.is_platform_admin` = 'false', so RLS scopes every read and
 * write to that tenant. Prints JSON (identifiers, codes and quantities; no
 * PII, no credential).
 *
 * Build first: `pnpm --filter @data-pulse-2/db build`, then
 *   DATABASE_URL=postgres://... node dist/cli/inventory-effects.js activate --tenant <t> --actor <u> --dry-run
 *
 * Exit codes: 0 success · 1 SQL/runtime error · 2 DATABASE_URL missing ·
 *             3 invalid arguments · 4 activation, identity anchor or attestation refused.
 */
import { Client } from "pg";

import { activateSaleEffects, compareAnchorsToBin } from "../helpers/inventory-effects/activation";
import { attestBatchPosting, normalizeEvidenceRef } from "../helpers/inventory-effects/batch-posting-attestation";
import { anchorTrackedIdentities } from "../helpers/inventory-effects/identity-anchor";
import { buildCutoverEquivalenceReport } from "../helpers/inventory-effects/pending-aware";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InventoryEffectsCommand =
  | {
      readonly kind: "activate" | "anchor-identities";
      readonly tenantId: string;
      readonly actorId: string;
      readonly dryRun: boolean;
    }
  | {
      readonly kind: "attest-batch-posting";
      readonly tenantId: string;
      readonly actorId: string;
      readonly evidenceRef: string;
      readonly dryRun: boolean;
    }
  | { readonly kind: "compare" | "equivalence"; readonly tenantId: string };

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function uuidFlag(argv: readonly string[], name: string): string {
  const value = flag(argv, name);
  if (value === undefined || !UUID_RE.test(value)) throw new Error(`--${name} <uuid> is required`);
  return value.toLowerCase();
}

function evidenceFlag(argv: readonly string[]): string {
  const value = flag(argv, "evidence");
  try {
    return normalizeEvidenceRef(value ?? "");
  } catch {
    throw new Error("--evidence <ref> is required (1 to 200 characters)");
  }
}

/** Parse the command line; throws an Error naming the problem. */
export function parseInventoryEffectsArgs(argv: readonly string[]): InventoryEffectsCommand {
  const [command] = argv;
  if (command === "activate" || command === "anchor-identities") {
    return {
      kind: command,
      tenantId: uuidFlag(argv, "tenant"),
      actorId: uuidFlag(argv, "actor"),
      dryRun: argv.includes("--dry-run"),
    };
  }
  if (command === "attest-batch-posting") {
    return {
      kind: command,
      tenantId: uuidFlag(argv, "tenant"),
      actorId: uuidFlag(argv, "actor"),
      evidenceRef: evidenceFlag(argv),
      dryRun: argv.includes("--dry-run"),
    };
  }
  if (command === "compare" || command === "equivalence") return { kind: command, tenantId: uuidFlag(argv, "tenant") };
  throw new Error(
    "usage: inventory-effects activate --tenant <uuid> --actor <uuid> [--dry-run] | anchor-identities --tenant <uuid> --actor <uuid> [--dry-run] | attest-batch-posting --tenant <uuid> --actor <uuid> --evidence <ref> [--dry-run] | compare --tenant <uuid> | equivalence --tenant <uuid>",
  );
}

/** A read-only report (`compare` or `equivalence`): read, roll back, print. */
async function runReadOnly(
  client: Client,
  cmd: { readonly kind: "compare" | "equivalence"; readonly tenantId: string },
): Promise<number> {
  const rows = cmd.kind === "compare" ? await compareAnchorsToBin(client) : await buildCutoverEquivalenceReport(client);
  await client.query("ROLLBACK");
  console.log(JSON.stringify({ tenantId: cmd.tenantId, rows }, null, 2));
  return 0;
}

/** Run one command in one tenant-scoped transaction; returns the exit code. */
async function run(client: Client, cmd: InventoryEffectsCommand): Promise<number> {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [cmd.tenantId]);
    await client.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    if (!("actorId" in cmd)) return await runReadOnly(client, cmd);
    const input = { tenantId: cmd.tenantId, actorId: cmd.actorId };
    const outcome =
      cmd.kind === "activate"
        ? await activateSaleEffects(client, input)
        : cmd.kind === "anchor-identities"
          ? await anchorTrackedIdentities(client, input)
          : await attestBatchPosting(client, { ...input, evidenceRef: cmd.evidenceRef });
    const ok = outcome.kind !== "refused";
    await client.query(ok && !cmd.dryRun ? "COMMIT" : "ROLLBACK");
    console.log(JSON.stringify({ tenantId: cmd.tenantId, dryRun: cmd.dryRun, outcome }, null, 2));
    return ok ? 0 : 4;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

async function main(): Promise<void> {
  let cmd: InventoryEffectsCommand;
  try {
    cmd = parseInventoryEffectsArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`inventory-effects: ${(err as Error).message}`);
    process.exit(3);
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    process.exitCode = await run(client, cmd);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    // Never includes DATABASE_URL.
    console.error(`inventory-effects: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
