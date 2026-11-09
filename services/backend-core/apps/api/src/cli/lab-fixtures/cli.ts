/**
 * Argument parsing and orchestration for `lab-fixtures` — RT-1309.
 *
 * `runCli` takes its environment, its factories and its output sink as
 * arguments so every path, including each guard refusal, is unit-tested
 * without a database or the identity provider. Output is JSON lines with fixture indexes,
 * synthetic loginIds and outcomes only: never a key, token, password or email.
 */
import { GuardRefusedError, assertStaticGuards } from "./guards";
import { fixtureIdentities } from "./identity";
import { dryRunReports, Provisioner, type FixtureReport, type Mode, type ProvisionerDeps } from "./provisioner";

export const EXIT = { ok: 0, usage: 2, guard: 3, refused: 4, stopped: 5 } as const;

export interface ParsedArgs {
  readonly mode: Mode;
  readonly tenantId: string;
  readonly storeId: string;
  readonly count: number;
  readonly dryRun: boolean;
}

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  /** The identity-provider project the target is configured for (checked against the allowlist). */
  readonly providerProjectId: string;
  /** Builds the real dependencies; called only after the static guards pass and never for `--dry-run`. */
  readonly connect: (args: ParsedArgs) => Promise<{ deps: ProvisionerDeps; close: () => Promise<void> }>;
}

const USAGE =
  "usage: lab-fixtures <status|provision> --tenant <uuid> --store <uuid> --count <1-100> [--dry-run]";

export function parseArgs(argv: readonly string[]): ParsedArgs | null {
  const [command, ...rest] = argv;
  if (command !== "status" && command !== "provision") return null;
  const flags = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = rest[i + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined || flags.has(flag)) return null;
    flags.set(flag, value);
    i++;
  }
  const tenantId = flags.get("--tenant");
  const storeId = flags.get("--store");
  const count = Number(flags.get("--count"));
  if (flags.size !== 3 || tenantId === undefined || storeId === undefined) return null;
  if (dryRun && command !== "provision") return null;
  return { mode: command, tenantId, storeId, count, dryRun };
}

function exitFor(reports: readonly FixtureReport[]): number {
  if (reports.some((r) => r.outcome === "stopped")) return EXIT.stopped;
  if (reports.some((r) => r.outcome === "refused")) return EXIT.refused;
  return EXIT.ok;
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    io.out(JSON.stringify({ event: "usage", message: USAGE }));
    return EXIT.usage;
  }
  try {
    assertStaticGuards({
      env: io.env,
      providerProjectId: io.providerProjectId,
      tenantId: args.tenantId,
      storeId: args.storeId,
      count: args.count,
    });
    const identities = fixtureIdentities(args.count);
    if (args.dryRun) return report(io, args, dryRunReports(identities));
    const { deps, close } = await io.connect(args);
    try {
      return report(io, args, await new Provisioner(deps).run(args.mode, identities));
    } finally {
      await close();
    }
  } catch (err: unknown) {
    if (err instanceof GuardRefusedError) {
      io.out(JSON.stringify({ event: "guard_refused", family: err.family, reason: err.reason }));
      return EXIT.guard;
    }
    throw err;
  }
}

function report(io: CliIo, args: ParsedArgs, reports: readonly FixtureReport[]): number {
  for (const r of reports) io.out(JSON.stringify({ event: "fixture", mode: args.mode, ...r }));
  const exit = exitFor(reports);
  io.out(JSON.stringify({ event: "summary", mode: args.mode, dryRun: args.dryRun, fixtures: reports.length, exit }));
  return exit;
}
