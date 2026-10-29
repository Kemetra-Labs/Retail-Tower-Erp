#!/usr/bin/env node
/**
 * Identity-link cutover — RT-797 (provider-neutral identity 2/5).
 *
 * Moves ONE user's operator identity from one identity provider to another,
 * or back, in ONE transaction, by flipping `external_identity_links` rows
 * only. Sign-in, rosters and audit resolve the operator through the user's
 * ACTIVE link (RT-796), and `operator.id` is that link's subject, so the flip
 * is all a cutover needs. The `users` row is locked but never written.
 *
 *   apply    --user <uuid> --from <provider> --to <provider>
 *            --subject <id> --issuer <https url> [--dry-run]
 *     1. disable the user's ACTIVE `from` link (status 'disabled', disabled_at);
 *     2. activate the user's `to` link for `--subject`: re-activate the row the
 *        user already has for it (under any issuer), else insert one under
 *        `--issuer`.
 *     The disabled `from` row stays as the rollback source, and audit events
 *     queued under it are still accepted (RT-796 audit alias).
 *
 *   rollback --user <uuid> --from <provider> --to <provider> [--dry-run]
 *     Reverses exactly: disables the active `to` link and re-activates the
 *     user's most recently disabled `from` link (the one apply disabled).
 *
 * Order matters: `external_identity_links_one_active_per_user_uidx` allows one
 * ACTIVE link per user, so the old link is disabled before the new one is
 * activated. Both commands lock the `users` row and its links first (FOR UPDATE).
 * No link row is ever deleted.
 *
 * Idempotent: re-running a command already in its target state writes nothing
 * and reports zero counts. Any other unexpected state (no active `from` link,
 * another provider's active link, a target subject linked to another user under
 * any issuer) is REFUSED with a code and nothing is written. `--dry-run` runs
 * the same transaction and rolls it back. Arguments are parsed strictly: an
 * unknown, duplicate or valueless flag (e.g. a mistyped `--dryrun`) is
 * rejected, never treated as a live run.
 *
 * `--issuer` is the issuer the target provider's adapter records on links
 * (`IdentityProviderPort` `issuer`). The resolver joins on (provider_key,
 * subject), so the stored issuer never gates sign-in; it is recorded for the
 * (provider_key, issuer, subject) uniqueness key. Only `apply` takes it.
 *
 * Output is counts and codes only — never ids, subjects or emails. `users` and
 * `external_identity_links` are tenant-agnostic (no RLS), so no tenant GUC is set.
 *
 * Build first: `pnpm --filter @data-pulse-2/db build`, then
 *   DATABASE_URL=postgres://... node dist/cli/identity-link-cutover.js apply \
 *     --user <uuid> --from <provider> --to <provider> --subject <id> \
 *     --issuer <https url> --dry-run
 *
 * Exit codes: 0 success · 1 SQL/runtime error · 2 DATABASE_URL missing ·
 *             3 invalid arguments · 4 refused (nothing written).
 */
import { Client, type ClientBase } from "pg";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A provider key as the adapters stamp it (`IdentityProviderPort.providerKey`). */
const PROVIDER_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ISSUER_URL_RE = /^https:\/\/\S{1,500}$/;
const USAGE =
  "usage: identity-link-cutover apply --user <uuid> --from <provider> --to <provider> --subject <id> --issuer <https url> [--dry-run]" +
  " | rollback --user <uuid> --from <provider> --to <provider> [--dry-run]";

/** The two providers a cutover moves between. */
interface ProviderPair {
  readonly from: string;
  readonly to: string;
}

export type IdentityLinkCutoverCommand =
  | (ProviderPair & {
      readonly kind: "apply";
      readonly userId: string;
      /** The user's subject at the `to` provider. */
      readonly subject: string;
      /** Issuer recorded on a `to` link apply has to insert. */
      readonly issuer: string;
      readonly dryRun: boolean;
    })
  | (ProviderPair & { readonly kind: "rollback"; readonly userId: string; readonly dryRun: boolean });

type ApplyCommand = Extract<IdentityLinkCutoverCommand, { kind: "apply" }>;
type RollbackCommand = Extract<IdentityLinkCutoverCommand, { kind: "rollback" }>;

export interface CutoverResult {
  readonly command: "apply" | "rollback";
  readonly dryRun: boolean;
  readonly alreadyInTargetState: boolean;
  readonly linksDisabled: number;
  readonly linksActivated: number;
}

type CutoverCounts = Omit<CutoverResult, "command" | "dryRun">;

/** A refused cutover: nothing was written. `code` is safe to print. */
export class CutoverRefusedError extends Error {
  constructor(readonly code: string) {
    super(`refused: ${code}`);
  }
}

// --- argument parsing (strict: unknown / duplicate / valueless flags refused) --

interface FlagSpec {
  readonly valued: readonly string[];
  readonly switches: readonly string[];
}

const PAIR_FLAGS = ["user", "from", "to"] as const;

const FLAG_SPECS: Readonly<Record<IdentityLinkCutoverCommand["kind"], FlagSpec>> = {
  apply: { valued: [...PAIR_FLAGS, "subject", "issuer"], switches: ["dry-run"] },
  rollback: { valued: [...PAIR_FLAGS], switches: ["dry-run"] },
};

interface ParsedFlags {
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

function flagName(arg: string): string {
  // Never echo the argument itself: it may be an id typed in the wrong slot.
  if (!arg.startsWith("--")) throw new Error(`unexpected positional argument; ${USAGE}`);
  return arg.slice(2);
}

function addOnce<T>(seen: Set<T>, name: T): void {
  if (seen.has(name)) throw new Error(`--${String(name)} given more than once`);
  seen.add(name);
}

/** Read `--flag value` / `--switch` pairs against the command's spec. */
function readFlags(args: readonly string[], spec: FlagSpec): ParsedFlags {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const name = flagName(args[i]!);
    addOnce(seen, name);
    if (spec.switches.includes(name)) {
      switches.add(name);
    } else if (spec.valued.includes(name)) {
      values.set(name, requireValue(name, args[i + 1]));
      i += 1;
    } else {
      throw new Error(`unknown flag; ${USAGE}`);
    }
  }
  return { values, switches };
}

function requireValue(name: string, value: string | undefined): string {
  const v = (value ?? "").trim();
  if (v === "" || v.startsWith("--")) throw new Error(`--${name} requires a value`);
  return v;
}

function requireUuid(flags: ParsedFlags): string {
  const userId = flags.values.get("user");
  if (userId === undefined || !UUID_RE.test(userId)) throw new Error("--user <uuid> is required");
  return userId.toLowerCase();
}

function requireProvider(flags: ParsedFlags, name: "from" | "to"): string {
  const key = flags.values.get(name);
  if (key === undefined || !PROVIDER_KEY_RE.test(key)) {
    throw new Error(`--${name} <provider> is required (lower-case letters, digits, '_' or '-')`);
  }
  return key;
}

function requireProviderPair(flags: ParsedFlags): ProviderPair {
  const pair = { from: requireProvider(flags, "from"), to: requireProvider(flags, "to") };
  if (pair.from === pair.to) throw new Error("--from and --to must name different providers");
  return pair;
}

function requireIssuer(flags: ParsedFlags): string {
  const issuer = flags.values.get("issuer");
  if (issuer === undefined || !ISSUER_URL_RE.test(issuer)) {
    throw new Error("--issuer <https url> is required for apply");
  }
  return issuer;
}

function isCommandKind(value: string | undefined): value is IdentityLinkCutoverCommand["kind"] {
  return value === "apply" || value === "rollback";
}

/** Parse the command line; throws an Error naming the problem (never echoing values). */
export function parseIdentityLinkCutoverArgs(argv: readonly string[]): IdentityLinkCutoverCommand {
  const [command, ...rest] = argv;
  if (!isCommandKind(command)) throw new Error(USAGE);
  const flags = readFlags(rest, FLAG_SPECS[command]);
  const userId = requireUuid(flags);
  const pair = requireProviderPair(flags);
  const dryRun = flags.switches.has("dry-run");
  if (command === "rollback") return { kind: "rollback", userId, ...pair, dryRun };
  const subject = flags.values.get("subject");
  if (subject === undefined) throw new Error("--subject <id> is required");
  return { kind: "apply", userId, ...pair, subject, issuer: requireIssuer(flags), dryRun };
}

// --- state ----------------------------------------------------------------

interface UserRow {
  readonly id: string;
  readonly email: string | null;
}

interface LinkRow {
  readonly id: string;
  readonly provider_key: string;
  readonly subject: string;
  readonly status: string;
}

interface UserState {
  readonly user: UserRow;
  /** Ordered most recently disabled first (active links last). */
  readonly links: readonly LinkRow[];
}

/** A subject the cutover is about to give to a user. */
interface SubjectClaim {
  readonly userId: string;
  readonly provider: string;
  readonly subject: string;
}

async function lockUserState(client: ClientBase, userId: string): Promise<UserState> {
  const u = await client.query<UserRow>("SELECT id, email FROM users WHERE id = $1 FOR UPDATE", [userId]);
  const user = u.rows[0];
  if (!user) throw new CutoverRefusedError("user_not_found");
  const l = await client.query<LinkRow>(
    `SELECT id, provider_key, subject, status
       FROM external_identity_links WHERE user_id = $1
      ORDER BY disabled_at DESC NULLS LAST, id
      FOR UPDATE`,
    [userId],
  );
  return { user, links: l.rows };
}

function linksOf(state: UserState, provider: string, status: "active" | "disabled"): LinkRow[] {
  return state.links.filter((l) => l.provider_key === provider && l.status === status);
}

/** The user's single active link (the schema allows at most one), else null. */
function activeLink(state: UserState): LinkRow | null {
  return state.links.find((l) => l.status === "active") ?? null;
}

// --- writes -----------------------------------------------------------------

/**
 * The resolver joins on (provider_key, subject) WITHOUT issuer, so a subject
 * linked to another user under ANY issuer would make sign-in ambiguous.
 *
 * The FOR UPDATE lock covers only this user's rows, so two sessions claiming
 * the same (provider, subject) for different users (under different issuers,
 * which the unique key allows) would both pass a plain check. A transaction
 * advisory lock on the pair serializes them; the pilot bootstrap takes the same
 * lock. Taken before the check, so the check's snapshot sees the other commit.
 */
async function assertSubjectUnlinked(client: ClientBase, claim: SubjectClaim, refusal: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('identity-link:' || $1 || ':' || $2))", [
    claim.provider,
    claim.subject,
  ]);
  const r = await client.query(
    `SELECT 1 FROM external_identity_links
      WHERE provider_key = $1 AND subject = $2 AND user_id <> $3`,
    [claim.provider, claim.subject, claim.userId],
  );
  if (r.rows.length > 0) throw new CutoverRefusedError(refusal);
}

async function disableLink(client: ClientBase, link: LinkRow): Promise<void> {
  await client.query(
    "UPDATE external_identity_links SET status = 'disabled', disabled_at = now() WHERE id = $1",
    [link.id],
  );
}

async function activateLink(client: ClientBase, link: LinkRow): Promise<void> {
  await client.query(
    "UPDATE external_identity_links SET status = 'active', disabled_at = NULL WHERE id = $1",
    [link.id],
  );
}

const NO_CHANGE: CutoverCounts = { alreadyInTargetState: true, linksDisabled: 0, linksActivated: 0 };
const FLIPPED: CutoverCounts = { alreadyInTargetState: false, linksDisabled: 1, linksActivated: 1 };

/**
 * Re-activate this user's existing `to` link for the subject (any issuer form —
 * a re-apply after rollback must not add a second row), else insert one under
 * the command's issuer.
 */
async function activateTargetLink(client: ClientBase, cmd: ApplyCommand, state: UserState): Promise<void> {
  const existing = state.links.find((l) => l.provider_key === cmd.to && l.subject === cmd.subject);
  if (existing) {
    await activateLink(client, existing);
    return;
  }
  const r = await client.query(
    `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, email, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     ON CONFLICT (provider_key, issuer, subject) DO UPDATE
       SET status = 'active', disabled_at = NULL
       WHERE external_identity_links.user_id = EXCLUDED.user_id
     RETURNING id`,
    [cmd.to, cmd.issuer, cmd.subject, cmd.userId, state.user.email],
  );
  if (r.rows.length !== 1) throw new CutoverRefusedError("target_subject_linked_to_other_user");
}

// --- commands -----------------------------------------------------------------

/**
 * The active `from` link apply retires; null when apply is already done.
 * Matched on subject only, like the resolver: a `to` link stored under an older
 * issuer form (the rt9 lab has one) is still this user's applied state.
 */
function sourceToRetire(state: UserState, cmd: ApplyCommand): LinkRow | null {
  const active = activeLink(state);
  if (!active) throw new CutoverRefusedError("no_active_source_link");
  if (active.provider_key === cmd.to) {
    if (active.subject === cmd.subject) return null;
    throw new CutoverRefusedError("inconsistent_target_state");
  }
  if (active.provider_key !== cmd.from) throw new CutoverRefusedError("unexpected_active_link");
  return active;
}

async function applyCutover(client: ClientBase, cmd: ApplyCommand): Promise<CutoverCounts> {
  const state = await lockUserState(client, cmd.userId);
  const source = sourceToRetire(state, cmd);
  if (!source) return NO_CHANGE;
  const claim: SubjectClaim = { userId: cmd.userId, provider: cmd.to, subject: cmd.subject };
  await assertSubjectUnlinked(client, claim, "target_subject_linked_to_other_user");
  await disableLink(client, source);
  await activateTargetLink(client, cmd, state);
  return FLIPPED;
}

/** The active `to` link rollback reverses; null when already rolled back. */
function targetToReverse(state: UserState, cmd: RollbackCommand): LinkRow | null {
  const active = activeLink(state);
  if (active?.provider_key === cmd.to) return active;
  if (active?.provider_key === cmd.from) return null;
  if (active) throw new CutoverRefusedError("unexpected_active_link");
  throw new CutoverRefusedError("no_active_target_link");
}

async function rollbackCutover(client: ClientBase, cmd: RollbackCommand): Promise<CutoverCounts> {
  const state = await lockUserState(client, cmd.userId);
  const target = targetToReverse(state, cmd);
  if (!target) return NO_CHANGE;
  // The most recently disabled `from` link is the one apply replaced; older
  // disabled ones are earlier history.
  const source = linksOf(state, cmd.from, "disabled")[0];
  if (!source) throw new CutoverRefusedError("no_disabled_source_link");
  // Re-check at rollback time: another user may have been linked to this
  // subject since apply, and two active (provider, subject) rows are ambiguous.
  const claim: SubjectClaim = { userId: cmd.userId, provider: cmd.from, subject: source.subject };
  await assertSubjectUnlinked(client, claim, "source_subject_linked_to_other_user");
  await disableLink(client, target);
  await activateLink(client, source);
  return FLIPPED;
}

/**
 * Run one command in ONE transaction (rolled back on --dry-run or any error).
 * Throws `CutoverRefusedError` for a refused state.
 */
export async function runIdentityLinkCutover(
  client: ClientBase,
  cmd: IdentityLinkCutoverCommand,
): Promise<CutoverResult> {
  await client.query("BEGIN");
  try {
    const counts = cmd.kind === "apply" ? await applyCutover(client, cmd) : await rollbackCutover(client, cmd);
    await client.query(cmd.dryRun ? "ROLLBACK" : "COMMIT");
    return { command: cmd.kind, dryRun: cmd.dryRun, ...counts };
  } catch (err) {
    // A failing ROLLBACK (e.g. dropped connection) must not mask the original error.
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

async function main(): Promise<void> {
  let cmd: IdentityLinkCutoverCommand;
  try {
    cmd = parseIdentityLinkCutoverArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`identity-link-cutover: ${(err as Error).message}`);
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
    console.log(JSON.stringify(await runIdentityLinkCutover(client, cmd), null, 2));
  } catch (err) {
    if (!(err instanceof CutoverRefusedError)) throw err;
    console.error(JSON.stringify({ command: cmd.kind, refused: err.code }));
    process.exitCode = 4;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    // Message only: pg's `detail` (which can quote key values) is never printed,
    // and DATABASE_URL is never included.
    console.error(`identity-link-cutover: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
