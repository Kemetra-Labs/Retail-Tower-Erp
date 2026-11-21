/**
 * The accept-and-flag findings on a frozen policy at open (AD-CASH-001 D-6;
 * pos-shifts 1.2.0-draft `PolicyFlag`). Never a refusal: the open is
 * recorded whatever this returns.
 *
 *   - `policy_revision_unknown`: a tenant / store source whose id is not a
 *     revision of this tenant, is a store revision of another store, is of the
 *     other scope than the source names, or is a `clear` (never a resolved id).
 *   - `policy_revision_superseded`: the frozen policy (its revision, or the
 *     System default for `system`) was not the store's effective policy at
 *     any instant of the closed window [openedAt − OPEN_SKEW_MS, openedAt +
 *     OPEN_SKEW_MS] (the RT-224 clock skew, 120 s). The bounds are inclusive
 *     on both sides: a revision superseded exactly 120 s before openedAt, or
 *     published exactly 120 s after it, is within tolerance; 1 ms more is
 *     flagged. An offline open on an older cached revision is normal (DR-8);
 *     an online open on the then-current revision is not flagged.
 *   - `policy_value_mismatch`: the value differs from the revision's stored
 *     value (for `system`, from the System default `none`), or a `limit`'s
 *     currency differs from the shift's.
 *   - `policy_revision_stale_at_receipt` (RT-592, pos-shifts 1.6.0-draft): the
 *     open arrived MORE than `STALE_AT_RECEIPT_AFTER_MS` (24 h, strictly) after
 *     its `openedAt` AND the frozen policy (its revision, or the System default
 *     for `system`) is not the store's effective policy at `received_at`. A
 *     backdated `openedAt` can otherwise freeze an older, looser revision that
 *     passes the superseded check; a plain offline open (DR-8) arrives within
 *     the window and is never flagged by this. `received_at` is the open
 *     transaction's `now()`, the value the INSERT stores. An unknown revision
 *     and a `fallback` never carry it (they are not a server revision to be
 *     stale).
 *
 * `fallback` is the POS's own never-fetched value (DR-6), never a server
 * revision, so it is never `unknown` or `superseded`; but both contracts
 * define it as the fail-closed `limit 0`, so any other `fallback` value — `none`
 * or a non-zero limit — is `policy_value_mismatch` (with the currency rule, a
 * `limit 0` in another currency than the shift's is one too). Otherwise a POS
 * could claim `fallback` + `none` and defeat `approvalMissing` reporting.
 */
import type { PoolClient } from "pg";

import type { FrozenPolicyFact, PolicyFlag } from "../pos-shifts/shift-frozen-policy";
import { effectiveAt, type PolicyHistory, type ResolvedPolicy } from "./policy-resolution";
import { scaled } from "../common/money/shift-cash-arithmetic";
import { samePolicyValue, SYSTEM_DEFAULT, type PolicyValue } from "./policy-value";
import { PolicyRepository, type StoredRevision } from "./policy.repository";

/**
 * The RT-224 clock-skew tolerance (120 s) of the superseded check, applied on
 * both sides of the open's POS-clock `openedAt`, bounds inclusive. The one
 * place this window is defined (coordinator condition on RT-387).
 */
export const OPEN_SKEW_MS = 120_000;

/**
 * RT-592 (owner decision, Jira RT-592 comment 18021): N = 24 hours. An open whose
 * `received_at − openedAt` is strictly more than this is "late"; exactly this is not.
 */
export const STALE_AT_RECEIPT_AFTER_MS = 24 * 60 * 60 * 1000;

/** Revision times are compared at millisecond precision (JS `Date`). */
const TICK_MS = 1;

export interface OpenPolicyInput {
  readonly tenantId: string;
  readonly storeId: string;
  /** The open's POS-clock instant (RFC 3339). */
  readonly openedAt: string;
  readonly shiftCurrencyCode: string;
  readonly frozen: FrozenPolicyFact;
}

/**
 * The instants to test in [from, to]: `from`, and each change of the store's
 * effective policy inside the window together with the instant just before
 * it, so a policy in force up to a change exactly at `from` (its closed end)
 * counts as inside the window.
 */
function probePoints(history: PolicyHistory, from: number, to: number): number[] {
  const changes = [...history.tenant, ...history.store].flatMap((r) => changeTimes(r));
  const inside = changes.filter((change) => change >= from && change <= to);
  return [from, ...inside.flatMap((change) => [change, change - TICK_MS])];
}

/** When a revision can change the effective policy: its publish, and its expiry if any. */
function changeTimes(revision: PolicyHistory["tenant"][number]): number[] {
  const until = revision.effectiveUntil;
  return until === null ? [revision.createdAt.getTime()] : [revision.createdAt.getTime(), until.getTime()];
}

/** True when `matches` holds for the effective policy at some instant of the skew window. */
function effectiveInWindow(history: PolicyHistory, openedAt: Date, matches: (p: ResolvedPolicy) => boolean): boolean {
  const from = openedAt.getTime() - OPEN_SKEW_MS;
  const to = openedAt.getTime() + OPEN_SKEW_MS;
  return probePoints(history, from, to).some((t) => matches(effectiveAt(history, new Date(t))));
}

function isUnknownFor(frozen: FrozenPolicyFact, storeId: string, revision: StoredRevision | null): boolean {
  return (
    revision === null ||
    revision.kind === "clear" ||
    revision.scope !== frozen.policySource ||
    (revision.scope === "store" && revision.storeId !== storeId)
  );
}

/** The DR-6 fail-closed fallback: a `limit` of exactly 0 (its currency is checked by the currency rule). */
function isFailClosed(value: PolicyValue): boolean {
  return value.mode === "limit" && scaled(value.limitAmount) === 0n;
}

export class OpenPolicyFlagger {
  constructor(private readonly repo: PolicyRepository = new PolicyRepository()) {}

  /** The flags of `input.frozen`, in the contract's order. Runs on the open's tenant-scoped client. */
  async flags(client: PoolClient, input: OpenPolicyInput): Promise<PolicyFlag[]> {
    const { frozen } = input;
    const found = new Set<PolicyFlag>();
    if (frozen.policySource === "tenant" || frozen.policySource === "store") await this.revisionFlags(client, input, found);
    if (frozen.policySource === "system") await this.systemFlags(client, input, found);
    if (frozen.policySource === "fallback" && !isFailClosed(frozen.policyValue)) found.add("policy_value_mismatch");
    const value = frozen.policyValue;
    if (value.mode === "limit" && value.currencyCode !== input.shiftCurrencyCode) found.add("policy_value_mismatch");
    // The contract's order (`POLICY_FLAG_ORDER` in pos-shifts, which this module must not import: a cycle).
    return (
      [
        "policy_revision_unknown",
        "policy_revision_superseded",
        "policy_value_mismatch",
        "policy_revision_stale_at_receipt",
      ] as const
    ).filter((f) => found.has(f));
  }

  private async systemFlags(client: PoolClient, input: OpenPolicyInput, found: Set<PolicyFlag>): Promise<void> {
    if (!(await this.wasEffective(client, input, (p) => p.policySource === "system"))) found.add("policy_revision_superseded");
    if (await this.staleAtReceipt(client, input, (p) => p.policySource === "system")) found.add("policy_revision_stale_at_receipt");
    if (!samePolicyValue(input.frozen.policyValue, SYSTEM_DEFAULT)) found.add("policy_value_mismatch");
  }

  private async revisionFlags(client: PoolClient, input: OpenPolicyInput, found: Set<PolicyFlag>): Promise<void> {
    const id = input.frozen.policyRevisionId as string;
    const revision = await this.repo.find(client, input.tenantId, id);
    if (isUnknownFor(input.frozen, input.storeId, revision)) {
      found.add("policy_revision_unknown");
      return;
    }
    if (!(await this.wasEffective(client, input, (p) => p.policyRevisionId === id))) found.add("policy_revision_superseded");
    if (await this.staleAtReceipt(client, input, (p) => p.policyRevisionId === id)) found.add("policy_revision_stale_at_receipt");
    if (!revision?.value || !samePolicyValue(input.frozen.policyValue, revision.value)) {
      found.add("policy_value_mismatch");
    }
  }

  private async wasEffective(
    client: PoolClient,
    input: OpenPolicyInput,
    matches: (p: ResolvedPolicy) => boolean,
  ): Promise<boolean> {
    const openedAt = new Date(input.openedAt);
    const history = await this.historyUntil(client, input, new Date(openedAt.getTime() + OPEN_SKEW_MS));
    return effectiveInWindow(history, openedAt, matches);
  }

  /**
   * RT-592: true when the open is late (see `STALE_AT_RECEIPT_AFTER_MS`) and the frozen policy is not
   * the one in effect for the store at `received_at`. Reads the transaction clock first and returns
   * before any history query when the open is on time, so an ordinary open pays one `SELECT now()`.
   */
  private async staleAtReceipt(
    client: PoolClient,
    input: OpenPolicyInput,
    matches: (p: ResolvedPolicy) => boolean,
  ): Promise<boolean> {
    const receivedAt = await this.repo.now(client);
    if (receivedAt.getTime() - new Date(input.openedAt).getTime() <= STALE_AT_RECEIPT_AFTER_MS) return false;
    const history = await this.historyUntil(client, input, receivedAt);
    return !matches(effectiveAt(history, receivedAt));
  }

  /** The tenant's and the store's revisions created at or before `until`, from one statement (one snapshot). */
  private historyUntil(client: PoolClient, input: OpenPolicyInput, until: Date): Promise<PolicyHistory> {
    return this.repo.historyBothScopes(client, { tenantId: input.tenantId, storeId: input.storeId }, until);
  }
}
