/**
 * RT-592 (RT-387 follow-up) — the `policy_revision_stale_at_receipt` finding of `OpenPolicyFlagger`
 * (pos-shifts 1.6.0-draft `PolicyFlag`; owner decision RT-592 comment 18021: N = 24 h).
 *
 * An open is flagged when BOTH hold: `received_at − openedAt` is strictly more than 24 h, AND the
 * frozen policy is not the policy in effect for the store AT `received_at`. Never a refusal. The
 * receipt instant is the open's transaction clock (`PolicyRepository.now`, the value the INSERT
 * stores as `received_at`), so the fake repository below pins it.
 *
 * No DB: the repository is a fake over in-memory revisions, so the 24 h boundary is exact to the
 * millisecond (the HTTP suite proves the same finding end to end against Postgres).
 */
import type { PoolClient } from "pg";

import { OpenPolicyFlagger, STALE_AT_RECEIPT_AFTER_MS } from "../../src/cash-variance-policy/policy-open-flags";
import type { PolicyValue } from "../../src/cash-variance-policy/policy-value";
import { PolicyRepository, type PolicyScopeRef, type StoredRevision } from "../../src/cash-variance-policy/policy.repository";
import { POLICY_FLAG_ORDER, type FrozenPolicyFact, type PolicyFlag } from "../../src/pos-shifts/shift-frozen-policy";

const HOUR = 3_600_000;
const STALE: PolicyFlag = "policy_revision_stale_at_receipt";
const TENANT = "0a000000-0000-7000-8000-000000000592";
const STORE = "0a000000-0000-7000-8000-000000000593";
/** The receipt instant: the open transaction's `now()`. */
const RECEIVED_AT = new Date("2026-11-21T12:00:00.000Z");
const CLIENT = {} as PoolClient;

const limit = (limitAmount: string, currencyCode = "EGP"): PolicyValue => ({ mode: "limit", limitAmount, currencyCode });
const NONE: PolicyValue = { mode: "none" };

interface RevisionSeed {
  readonly id: string;
  readonly hoursBeforeReceipt: number;
  readonly value: PolicyValue;
  readonly storeId?: string;
}

function revision(seed: RevisionSeed): StoredRevision {
  const createdAt = new Date(RECEIVED_AT.getTime() - seed.hoursBeforeReceipt * HOUR);
  return {
    id: seed.id,
    scope: seed.storeId === undefined ? "tenant" : "store",
    storeId: seed.storeId ?? null,
    kind: "set",
    value: seed.value,
    reason: "seed",
    createdAt,
    createdAtKey: createdAt.toISOString(),
    effectiveUntil: null,
    permanent: false,
    approvedByUserId: null,
    supersedesRevisionId: null,
    createdByUserId: "0a000000-0000-7000-8000-0000000005a1",
  };
}

/** A repository over `revisions` whose transaction clock reads RECEIVED_AT. */
function fakeRepo(revisions: ReadonlyArray<StoredRevision>): PolicyRepository {
  const inScope = (r: StoredRevision, scope: PolicyScopeRef): boolean =>
    scope.storeId === null ? r.scope === "tenant" : r.scope === "store" && r.storeId === scope.storeId;
  const fake: Pick<PolicyRepository, "now" | "find" | "history"> = {
    now: () => Promise.resolve(RECEIVED_AT),
    find: (_client, tenantId, id) => Promise.resolve(tenantId === TENANT ? (revisions.find((r) => r.id === id) ?? null) : null),
    history: (_client, scope, until) =>
      Promise.resolve(
        revisions
          .filter((r) => inScope(r, scope) && r.createdAt.getTime() <= until.getTime())
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1)),
      ),
  };
  return fake as PolicyRepository;
}

interface OpenCase {
  readonly revisions: ReadonlyArray<StoredRevision>;
  readonly frozen: FrozenPolicyFact;
  /** The open's age at receipt, in ms (`received_at − openedAt`). */
  readonly ageMs: number;
}

function flagsOf({ revisions, frozen, ageMs }: OpenCase): Promise<PolicyFlag[]> {
  return new OpenPolicyFlagger(fakeRepo(revisions)).flags(CLIENT, {
    tenantId: TENANT,
    storeId: STORE,
    openedAt: new Date(RECEIVED_AT.getTime() - ageMs).toISOString(),
    shiftCurrencyCode: "EGP",
    frozen,
  });
}

const tenantFrozen = (id: string, value: PolicyValue): FrozenPolicyFact => ({
  policySource: "tenant",
  policyRevisionId: id,
  policyValue: value,
});

describe("RT-592 stale-at-receipt: the named constant and the flag order", () => {
  it("is the owner's N = 24 hours", () => {
    expect(STALE_AT_RECEIPT_AFTER_MS).toBe(24 * HOUR);
  });

  it("is listed last in the contract's flag order (the flagger keeps its own copy of the order: no import cycle)", () => {
    expect(POLICY_FLAG_ORDER).toEqual([
      "policy_revision_unknown",
      "policy_revision_superseded",
      "policy_value_mismatch",
      STALE,
    ]);
  });
});

describe("RT-592 stale-at-receipt: the four-cell matrix (late = more than 24 h)", () => {
  // OLD was replaced by CURRENT 40 h before receipt: a 30 h and a 60 h old open straddle it.
  const aged = [
    revision({ id: "old", hoursBeforeReceipt: 72, value: limit("100.00") }),
    revision({ id: "current", hoursBeforeReceipt: 40, value: limit("50.00") }),
  ];
  // CURRENT replaced OLD only 23 h before receipt, so an on-time open (under 24 h) can still carry OLD
  // while OLD was in effect at openedAt (23.5 h before receipt).
  const fresh = [
    revision({ id: "old", hoursBeforeReceipt: 72, value: limit("100.00") }),
    revision({ id: "current", hoursBeforeReceipt: 23, value: limit("50.00") }),
  ];

  it("on time, current revision: no flag", async () => {
    expect(await flagsOf({ revisions: fresh, frozen: tenantFrozen("current", limit("50.00")), ageMs: HOUR })).toEqual([]);
  });

  it("late, current revision: no flag", async () => {
    expect(await flagsOf({ revisions: aged, frozen: tenantFrozen("current", limit("50.00")), ageMs: 30 * HOUR })).toEqual([]);
  });

  it("late, stale revision: flagged (and only that: the old revision was effective at openedAt)", async () => {
    expect(await flagsOf({ revisions: aged, frozen: tenantFrozen("old", limit("100.00")), ageMs: 60 * HOUR })).toEqual([STALE]);
  });

  it("on time, stale revision: no flag (an offline open on an older cache is normal, DR-8)", async () => {
    // OLD was effective at openedAt (23.5 h before receipt), so no superseded finding either.
    expect(
      await flagsOf({ revisions: fresh, frozen: tenantFrozen("old", limit("100.00")), ageMs: 23.5 * HOUR }),
    ).toEqual([]);
  });

  it("on time, stale revision and superseded at openedAt: only the existing superseded finding", async () => {
    expect(await flagsOf({ revisions: aged, frozen: tenantFrozen("old", limit("100.00")), ageMs: HOUR })).toEqual([
      "policy_revision_superseded",
    ]);
  });
});

describe("RT-592 stale-at-receipt: the 24 h boundary is strictly greater", () => {
  const revisions = [
    revision({ id: "old", hoursBeforeReceipt: 72, value: limit("100.00") }),
    revision({ id: "current", hoursBeforeReceipt: 40, value: limit("50.00") }),
  ];
  const stale = tenantFrozen("old", limit("100.00"));

  it.each([
    ["exactly 24 h after openedAt", STALE_AT_RECEIPT_AFTER_MS, false],
    ["24 h and 1 ms after openedAt", STALE_AT_RECEIPT_AFTER_MS + 1, true],
    ["24 h less 1 ms after openedAt", STALE_AT_RECEIPT_AFTER_MS - 1, false],
  ])("%s", async (_label, ageMs, flagged) => {
    const flags = await flagsOf({ revisions, frozen: stale, ageMs });
    expect(flags.includes(STALE)).toBe(flagged);
  });

  it("does not flag an open stamped after its receipt (a fast POS clock)", async () => {
    expect(await flagsOf({ revisions, frozen: stale, ageMs: -48 * HOUR })).not.toContain(STALE);
  });
});

describe("RT-592 stale-at-receipt: which policy counts as the one in effect at receipt", () => {
  const LATE = 30 * HOUR;

  it("flags a system policy frozen while a tenant default is in force at receipt", async () => {
    const revisions = [revision({ id: "tenant-default", hoursBeforeReceipt: 10, value: limit("50.00") })];
    const frozen: FrozenPolicyFact = { policySource: "system", policyRevisionId: null, policyValue: NONE };
    expect(await flagsOf({ revisions, frozen, ageMs: LATE })).toEqual([STALE]);
  });

  it("does not flag a system policy while no tenant default exists at receipt", async () => {
    const frozen: FrozenPolicyFact = { policySource: "system", policyRevisionId: null, policyValue: NONE };
    expect(await flagsOf({ revisions: [], frozen, ageMs: LATE })).toEqual([]);
  });

  it("flags a tenant revision when a stricter store override governs the store at receipt", async () => {
    // The override was published 20 h before receipt, after this 30 h old open: the tenant revision was
    // the effective one at openedAt (no superseded finding), and is not the effective one at receipt.
    const revisions = [
      revision({ id: "tenant", hoursBeforeReceipt: 72, value: limit("50.00") }),
      revision({ id: "override", hoursBeforeReceipt: 20, value: limit("20.00"), storeId: STORE }),
    ];
    expect(await flagsOf({ revisions, frozen: tenantFrozen("tenant", limit("50.00")), ageMs: LATE })).toEqual([STALE]);
  });

  it("does not flag the store override that is in effect at receipt", async () => {
    const revisions = [
      revision({ id: "tenant", hoursBeforeReceipt: 72, value: limit("50.00") }),
      revision({ id: "override", hoursBeforeReceipt: 40, value: limit("20.00"), storeId: STORE }),
    ];
    const frozen: FrozenPolicyFact = { policySource: "store", policyRevisionId: "override", policyValue: limit("20.00") };
    expect(await flagsOf({ revisions, frozen, ageMs: LATE })).toEqual([]);
  });

  it("never adds it to a fallback (the POS's own value, never a server revision)", async () => {
    const revisions = [revision({ id: "current", hoursBeforeReceipt: 40, value: limit("50.00") })];
    const frozen: FrozenPolicyFact = { policySource: "fallback", policyRevisionId: null, policyValue: limit("0.00") };
    expect(await flagsOf({ revisions, frozen, ageMs: LATE })).toEqual([]);
  });

  it("never adds it to an unknown revision (that finding already stands alone)", async () => {
    const revisions = [revision({ id: "current", hoursBeforeReceipt: 40, value: limit("50.00") })];
    expect(await flagsOf({ revisions, frozen: tenantFrozen("no-such-revision", limit("50.00")), ageMs: LATE })).toEqual([
      "policy_revision_unknown",
    ]);
  });

  it("is independent of a value mismatch and listed after it, in the contract's order", async () => {
    const revisions = [
      revision({ id: "old", hoursBeforeReceipt: 72, value: limit("100.00") }),
      revision({ id: "current", hoursBeforeReceipt: 40, value: limit("50.00") }),
    ];
    expect(await flagsOf({ revisions, frozen: tenantFrozen("old", limit("99.00")), ageMs: 60 * HOUR })).toEqual([
      "policy_value_mismatch",
      STALE,
    ]);
  });

  it("is listed after superseded when the open is late, stale and superseded at openedAt", async () => {
    const revisions = [
      revision({ id: "old", hoursBeforeReceipt: 72, value: limit("100.00") }),
      revision({ id: "current", hoursBeforeReceipt: 40, value: limit("50.00") }),
    ];
    // openedAt 80 h before receipt: before OLD existed, so OLD was not effective then (superseded) and
    // not now (stale).
    expect(await flagsOf({ revisions, frozen: tenantFrozen("old", limit("100.00")), ageMs: 80 * HOUR })).toEqual([
      "policy_revision_superseded",
      STALE,
    ]);
  });
});
