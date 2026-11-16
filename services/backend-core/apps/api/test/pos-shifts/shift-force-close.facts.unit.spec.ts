/**
 * RT-1445: the preview fingerprint and the stuck blockers (DB-less).
 *
 * The fingerprint covers exactly the facts the preview states (contract,
 * "Preview, then confirm, then re-check") and never `evaluatedAt` or the age;
 * the blockers list every failed predicate in the contract's order.
 */
import { previewFingerprint, type ForceCloseFacts } from "../../src/pos-shifts/shift-force-close.facts";
import { stuckBlockers, type StoreShiftRow, type StuckVerdict } from "../../src/pos-shifts/shift-force-close.repository";

const shift: StoreShiftRow = {
  shiftId: "0192f5a2-3b4c-7d8e-9f01-23456789ab01",
  tenantId: "0e170000-0000-4000-8000-0000000a0001",
  storeId: "0e170000-0000-4000-8000-0000000a5001",
  openingDeviceId: "0e170000-0000-4000-8000-0000000e0001",
  openingUserId: "0e170000-0000-4000-8000-0000000c0001",
  openedAt: new Date("2026-11-16T08:00:00.123Z"),
  lifecycleState: "open",
  source: "cash_up",
  currencyCode: "EGP",
  openingFloat: "500.0000",
  receivedAt: new Date("2026-11-16T08:00:02Z"),
  openedOnTerminalLabel: "till-A",
  notCounted: false,
};
const verdict: StuckVerdict = { stale: true, liveOperatorSession: false, liveCashierAdmission: false };
const facts: ForceCloseFacts = {
  cashierDisplayName: "Cashier Cat",
  terminalLabel: "till-A",
  terminalLastSeenAt: new Date("2026-11-16T08:20:00Z"),
  terminalTrustState: "active",
  cashMovementCount: 3,
  lastCashMovementReceivedAt: new Date("2026-11-16T09:12:00Z"),
  saleCount: 41,
  refundExecutionCount: 1,
  evaluatedAt: new Date("2026-11-16T22:40:00Z"),
  digestInputs: { openedAtUtc: "2026-11-16T08:00:00.123456Z", lastCashMovementReceivedAtUtc: "2026-11-16T09:12:00.000001Z" },
};
const base = previewFingerprint(shift, verdict, facts);

describe("previewFingerprint", () => {
  it("is a SHA-256 hex digest, stable for the same facts", () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(previewFingerprint({ ...shift }, { ...verdict }, { ...facts })).toBe(base);
  });

  it("ignores what the contract excludes: evaluatedAt, the age, labels and the cashier's name", () => {
    const later: ForceCloseFacts = {
      ...facts,
      evaluatedAt: new Date("2026-11-17T22:40:00Z"),
      terminalLabel: "renamed",
      cashierDisplayName: null,
      terminalLastSeenAt: null,
    };
    expect(previewFingerprint(shift, verdict, later)).toBe(base);
  });

  it.each<[string, () => string]>([
    ["the lifecycle state", () => previewFingerprint({ ...shift, lifecycleState: "closed_forced" }, verdict, facts)],
    ["the open time (microseconds)", () => previewFingerprint(shift, verdict, { ...facts, digestInputs: { ...facts.digestInputs, openedAtUtc: "2026-11-16T08:00:00.123457Z" } })],
    ["the stale predicate", () => previewFingerprint(shift, { ...verdict, stale: false }, facts)],
    ["a live operator session", () => previewFingerprint(shift, { ...verdict, liveOperatorSession: true }, facts)],
    ["a live cashier admission", () => previewFingerprint(shift, { ...verdict, liveCashierAdmission: true }, facts)],
    ["the cash movement count", () => previewFingerprint(shift, verdict, { ...facts, cashMovementCount: 4 })],
    ["the last movement time (microseconds)", () => previewFingerprint(shift, verdict, { ...facts, digestInputs: { ...facts.digestInputs, lastCashMovementReceivedAtUtc: "2026-11-16T09:12:00.000002Z" } })],
    ["the sale count", () => previewFingerprint(shift, verdict, { ...facts, saleCount: 42 })],
    ["the refund count", () => previewFingerprint(shift, verdict, { ...facts, refundExecutionCount: 2 })],
    ["the opening float", () => previewFingerprint({ ...shift, openingFloat: "501.0000" }, verdict, facts)],
    ["the currency", () => previewFingerprint({ ...shift, currencyCode: "USD" }, verdict, facts)],
    ["the terminal's trust state", () => previewFingerprint(shift, verdict, { ...facts, terminalTrustState: "revoked" })],
    ["the opening terminal", () => previewFingerprint({ ...shift, openingDeviceId: "0e170000-0000-4000-8000-0000000e0002" }, verdict, facts)],
    ["the shift", () => previewFingerprint({ ...shift, shiftId: "0192f5a2-3b4c-7d8e-9f01-23456789ab02" }, verdict, facts)],
    ["the tenant", () => previewFingerprint({ ...shift, tenantId: "0e170000-0000-4000-8000-0000000a0002" }, verdict, facts)],
  ])("changes with %s", (_label, changed) => {
    expect(changed()).not.toBe(base);
  });

  it("tells a legacy shift's unknown cash facts (null) from zero", () => {
    const zero = previewFingerprint(shift, verdict, { ...facts, cashMovementCount: 0 });
    const unknown = previewFingerprint(shift, verdict, { ...facts, cashMovementCount: null });
    expect(zero).not.toBe(unknown);
  });
});

describe("stuckBlockers", () => {
  it.each<[StuckVerdict, string[]]>([
    [{ stale: true, liveOperatorSession: false, liveCashierAdmission: false }, []],
    [{ stale: false, liveOperatorSession: false, liveCashierAdmission: false }, ["not_stale"]],
    [{ stale: true, liveOperatorSession: true, liveCashierAdmission: false }, ["live_operator_session"]],
    [{ stale: true, liveOperatorSession: false, liveCashierAdmission: true }, ["live_cashier_admission"]],
    [{ stale: false, liveOperatorSession: true, liveCashierAdmission: true }, ["not_stale", "live_operator_session", "live_cashier_admission"]],
  ])("%j → %j", (v, blockers) => {
    expect(stuckBlockers(v)).toEqual(blockers);
  });
});
