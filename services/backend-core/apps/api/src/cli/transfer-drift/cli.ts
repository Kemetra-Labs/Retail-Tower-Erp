/**
 * transfer-drift — Jira RT-1517 (RT-291 Gate 5). The operator report of the legacy instant-transfer legs that never
 * reached ERPNext (every `transfer_out` / `transfer_in` of `createStockTransfer` whose effect is still `not_posted`),
 * for one tenant, grouped by store.
 *
 * Read only: it posts nothing and changes no state. A leg in this report is never posted after the fact (that would be a
 * backdated ERP mutation, 920); the tenant's first Count Session, or ERP reconciliation at switch-over, corrects the
 * ERPNext balance (RT-292). This module is the provider-free part; `../transfer-drift.ts` wires the database.
 */
import type { LegacyTransferDriftRow } from "../../inventory";

export const EXIT = { ok: 0, usage: 2 } as const;

export interface ParsedArgs {
  readonly tenantId: string;
  readonly json: boolean;
}

export interface DriftCliIo {
  readonly out: (line: string) => void;
  /** Opens a read session for the tenant; called only after the arguments are valid. */
  readonly connect: (tenantId: string) => Promise<{
    list: () => Promise<readonly LegacyTransferDriftRow[]>;
    close: () => Promise<void>;
  }>;
}

const USAGE = "usage: transfer-drift report --tenant <uuid> [--json]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: readonly string[]): ParsedArgs | null {
  const [command, ...rest] = argv;
  if (command !== "report") return null;
  let tenantId: string | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--json") {
      if (json) return null;
      json = true;
      continue;
    }
    if (flag !== "--tenant" || tenantId !== undefined) return null;
    const value = rest[i + 1];
    if (value === undefined || !UUID.test(value)) return null;
    tenantId = value;
    i++;
  }
  return tenantId === undefined ? null : { tenantId, json };
}

interface StoreGroup {
  readonly storeId: string;
  readonly legs: LegacyTransferDriftRow[];
}

/** Groups the rows by store, keeping the order they arrive in (the query orders by store, then time). */
function byStore(rows: readonly LegacyTransferDriftRow[]): StoreGroup[] {
  const groups: StoreGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last?.storeId === row.storeId) last.legs.push(row);
    else groups.push({ storeId: row.storeId, legs: [row] });
  }
  return groups;
}

function printText(out: DriftCliIo["out"], tenantId: string, groups: readonly StoreGroup[], total: number): void {
  out(`tenant ${tenantId}: ${total} legacy transfer leg(s) not posted to ERPNext, in ${groups.length} store(s)`);
  for (const group of groups) {
    out(`store ${group.storeId}: ${group.legs.length} leg(s)`);
    for (const leg of group.legs) {
      out(
        `  ${leg.occurredAt}  ${leg.movementType}  ${leg.tenantProductRef}  ${leg.quantity} ${leg.stockingUnit}  group ${leg.transferGroupId ?? "-"}`,
      );
    }
  }
  out(
    "None of these legs is posted to ERPNext by this report; the first Count Session or ERP reconciliation corrects ERPNext. " +
      "The list is Retail Tower history: a leg stays listed after ERPNext has been corrected.",
  );
}

export async function runTransferDriftCli(argv: readonly string[], io: DriftCliIo): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    io.out(USAGE);
    return EXIT.usage;
  }
  const session = await io.connect(args.tenantId);
  try {
    const rows = await session.list();
    const groups = byStore(rows);
    if (args.json) io.out(JSON.stringify({ tenantId: args.tenantId, legCount: rows.length, stores: groups }));
    else printText(io.out, args.tenantId, groups, rows.length);
    return EXIT.ok;
  } finally {
    await session.close();
  }
}
