/**
 * pricing-legacy-import — Jira RT-1485 (spec 044 PR-16a-2a). The provider-free part of the operator
 * CLI that runs the initial legacy price import for ONE tenant: argument parsing and the report.
 * `../pricing-legacy-import.ts` wires the database.
 *
 * The MC-10 inputs are required and never defaulted: the Book currency and tax-price basis, and a
 * reference zone for a tenant with no Store. `--dry-run` checks and plans without writing.
 * The report lists ids, classes and counts only (no price, no name; §XIV).
 */
import { minorUnitExponent } from "../../common/money/iso4217-minor-units";
import { assertTimeZone, type ImportInputs, type LegacyImportResult } from "../../pricing";

export const EXIT = { ok: 0, usage: 2, refused: 3 } as const;

export interface ParsedArgs {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly inputs: ImportInputs;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export interface ImportCliIo {
  readonly out: (line: string) => void;
  /** Runs the import for the parsed arguments; called only after they are valid. */
  readonly run: (args: ParsedArgs) => Promise<LegacyImportResult>;
}

export const USAGE =
  "usage: pricing-legacy-import run --tenant <uuid> --actor <user uuid> --currency <ISO 4217> " +
  "--tax-basis inclusive|exclusive [--reference-zone <IANA zone>] [--dry-run] [--json]";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALUE_FLAGS = new Set(["--tenant", "--actor", "--currency", "--tax-basis", "--reference-zone"]);
const BOOLEAN_FLAGS = new Set(["--dry-run", "--json"]);

function knownZone(zone: string): boolean {
  try {
    assertTimeZone(zone);
    return true;
  } catch {
    return false;
  }
}

/** Flag → value (boolean flags map to ""), or null on any unknown, repeated or valueless flag. */
function readFlags(rest: readonly string[]): Map<string, string> | null {
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flags.has(flag)) return null;
    if (BOOLEAN_FLAGS.has(flag)) flags.set(flag, "");
    else if (VALUE_FLAGS.has(flag) && rest[i + 1] !== undefined) flags.set(flag, rest[++i]!);
    else return null;
  }
  return flags;
}

export function parseArgs(argv: readonly string[]): ParsedArgs | null {
  const [command, ...rest] = argv;
  const flags = command === "run" ? readFlags(rest) : null;
  if (flags === null) return null;
  const tenantId = flags.get("--tenant") ?? "";
  const actorUserId = flags.get("--actor") ?? "";
  const currencyCode = flags.get("--currency") ?? "";
  const basis = flags.get("--tax-basis");
  const referenceZone = flags.get("--reference-zone") ?? null;
  if (!UUID.test(tenantId) || !UUID.test(actorUserId)) return null;
  if (!/^[A-Z]{3}$/.test(currencyCode) || minorUnitExponent(currencyCode) === null) return null;
  if (basis !== "inclusive" && basis !== "exclusive") return null;
  if (referenceZone !== null && !knownZone(referenceZone)) return null;
  return {
    tenantId: tenantId.toLowerCase(),
    actorUserId: actorUserId.toLowerCase(),
    inputs: { currencyCode, taxPriceBasis: basis, referenceZone },
    dryRun: flags.has("--dry-run"),
    json: flags.has("--json"),
  };
}

function printText(out: ImportCliIo["out"], tenantId: string, result: LegacyImportResult): void {
  if (result.outcome === "refused") {
    out(`tenant ${tenantId}: import refused (${result.reason}) ${JSON.stringify(result.detail)}`);
    return;
  }
  const c = result.counts;
  out(
    `tenant ${tenantId}: ${result.outcome}; revision ${result.revisionNo ?? "-"}; price book ${result.priceBookId ?? "-"}` +
      `${result.bookCreated ? " (created)" : ""}; change-log watermark ${result.changeLogSequence}`,
  );
  out(`  events: ${c.bookEvents} book, ${c.storeEvents} store; exceptions: ${c.zeroPrice} zero_price, ${c.notRepresentable} not_representable`);
  for (const x of result.exceptions) out(`  exception ${x.cls} ${x.scope} product ${x.productId}${x.storeId === null ? "" : ` store ${x.storeId}`}`);
  if (result.exceptions.length > 0) {
    out("Each exception blocks this tenant's cutover (spec 044 §4.4): fix it on the legacy side, then re-run.");
  }
}

export async function runImportCli(argv: readonly string[], io: ImportCliIo): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    io.out(USAGE);
    return EXIT.usage;
  }
  const result = await io.run(args);
  if (args.json) io.out(JSON.stringify({ tenantId: args.tenantId, ...result }));
  else printText(io.out, args.tenantId, result);
  return result.outcome === "refused" ? EXIT.refused : EXIT.ok;
}
