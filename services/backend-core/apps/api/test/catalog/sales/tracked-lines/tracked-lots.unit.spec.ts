/**
 * Jira RT-451 slice S1 — unit cases for the lot lookup's credential composite,
 * its deployment gate and the pure ranking (no database).
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";

import { TrackedLotsAuthGuard } from "../../../../src/catalog/sales/tracked-lines/tracked-lots-auth.guard";
import {
  effectiveFefoPolicy,
  MAX_TRACKED_LOTS,
  toTrackedLotRows,
  type OrderedLotRow,
} from "../../../../src/catalog/sales/tracked-lines/tracked-lots.ranking";
import {
  isTrackedSellingEnabled,
  TRACKED_SELLING_GATE,
} from "../../../../src/catalog/sales/tracked-lines/tracked-selling-gate";

const CTX = {} as ExecutionContext;

function gate(outcome: "allow" | "deny-false" | Error): CanActivate & { calls: number } {
  const g = {
    calls: 0,
    async canActivate(): Promise<boolean> {
      g.calls += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome === "allow";
    },
  };
  return g;
}

describe("TrackedLotsAuthGuard (envelope, or the device token alone)", () => {
  it("accepts the envelope and never probes the device", async () => {
    const envelope = gate("allow");
    const device = gate("allow");
    await expect(new TrackedLotsAuthGuard(envelope, device).canActivate(CTX)).resolves.toBe(true);
    expect(device.calls).toBe(0);
  });

  it("falls back to the device token only after the envelope's generic 401", async () => {
    const device = gate("allow");
    const guard = new TrackedLotsAuthGuard(gate(new UnauthorizedException("Unauthorized")), device);
    await expect(guard.canActivate(CTX)).resolves.toBe(true);
    expect(device.calls).toBe(1);
  });

  it("answers the envelope's generic 401 when neither credential is accepted", async () => {
    const refusal = new UnauthorizedException("Unauthorized");
    const guard = new TrackedLotsAuthGuard(gate(refusal), gate(new UnauthorizedException("other")));
    await expect(guard.canActivate(CTX)).rejects.toBe(refusal);
  });

  it("treats a false from either guard as a refusal, never as a pass", async () => {
    await expect(new TrackedLotsAuthGuard(gate("deny-false"), gate("deny-false")).canActivate(CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("propagates a non-401 envelope error without probing the device", async () => {
    const device = gate("allow");
    const guard = new TrackedLotsAuthGuard(gate(new InternalServerErrorException()), device);
    await expect(guard.canActivate(CTX)).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(device.calls).toBe(0);
  });

  it("propagates a non-401 device error", async () => {
    const guard = new TrackedLotsAuthGuard(gate(new UnauthorizedException()), gate(new ForbiddenException()));
    await expect(guard.canActivate(CTX)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("the tracked-selling deployment gate", () => {
  const saved = process.env[TRACKED_SELLING_GATE];
  afterEach(() => {
    if (saved === undefined) delete process.env[TRACKED_SELLING_GATE];
    else process.env[TRACKED_SELLING_GATE] = saved;
  });

  it("is off when unset, empty or anything but 1 / true / yes", () => {
    delete process.env[TRACKED_SELLING_GATE];
    expect(isTrackedSellingEnabled()).toBe(false);
    for (const v of ["", "0", "false", "no", "on", "enabled"]) {
      process.env[TRACKED_SELLING_GATE] = v;
      expect({ v, on: isTrackedSellingEnabled() }).toEqual({ v, on: false });
    }
  });

  it("is on for 1, true or yes, trimmed and case-insensitive", () => {
    for (const v of ["1", "true", "TRUE", " yes "]) {
      process.env[TRACKED_SELLING_GATE] = v;
      expect({ v, on: isTrackedSellingEnabled() }).toEqual({ v, on: true });
    }
  });
});

describe("the lot ranking (G7-13)", () => {
  const row = (n: number, position: string | null = null, expiry: string | null = "2027-01-01"): OrderedLotRow => ({
    identity_id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    code: `LOT-${n}`,
    expiry_date: expiry,
    sellable_position: position,
  });

  it("defaults the FEFO policy from expiry_required (no tenant setting exists)", () => {
    expect(effectiveFefoPolicy({ expiryRequired: true })).toBe("suggest");
    expect(effectiveFefoPolicy({ expiryRequired: false })).toBe("off");
  });

  it("ranks 1-based in the given order under suggest", () => {
    const lots = toTrackedLotRows([row(1), row(2), row(3)], "suggest");
    expect(lots.map((l) => l.fefoRank)).toEqual([1, 2, 3]);
    expect(lots.map((l) => l.code)).toEqual(["LOT-1", "LOT-2", "LOT-3"]);
  });

  it("gives no rank under off and keeps the order", () => {
    const lots = toTrackedLotRows([row(2), row(1)], "off");
    expect(lots.map((l) => [l.code, l.fefoRank])).toEqual([
      ["LOT-2", null],
      ["LOT-1", null],
    ]);
  });

  it("formats the advisory position as an exact decimal and keeps null and negative values", () => {
    const lots = toTrackedLotRows([row(1, "12.5000"), row(2, "-3"), row(3, null), row(4, "0")], "suggest");
    expect(lots.map((l) => l.sellablePosition)).toEqual(["12.5000", "-3.0000", null, "0.0000"]);
    for (const l of lots) {
      if (l.sellablePosition !== null) expect(l.sellablePosition).toMatch(/^-?[0-9]{1,15}(\.[0-9]{1,6})?$/);
    }
  });

  it("keeps a lot without expiry as null and never returns more than the contract bound", () => {
    const many = Array.from({ length: MAX_TRACKED_LOTS + 3 }, (_, i) => row(i + 1, null, null));
    const lots = toTrackedLotRows(many, "suggest");
    expect(lots).toHaveLength(500);
    expect(lots[0]!.expiryDate).toBeNull();
    expect(lots[499]!.fefoRank).toBe(500);
  });
});
