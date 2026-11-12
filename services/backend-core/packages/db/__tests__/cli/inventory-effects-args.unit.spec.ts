/**
 * RT-427 — the activation CLI's argument parsing (no database).
 */
import { parseInventoryEffectsArgs } from "../../src/cli/inventory-effects";

const T = "0A000000-0000-7000-8000-000000000001";
const U = "0a000000-0000-7000-8000-000000000002";

describe("parseInventoryEffectsArgs", () => {
  it("parses activate (lower-casing ids) with and without --dry-run", () => {
    expect(parseInventoryEffectsArgs(["activate", "--tenant", T, "--actor", U])).toEqual({
      kind: "activate",
      tenantId: T.toLowerCase(),
      actorId: U,
      dryRun: false,
    });
    expect(parseInventoryEffectsArgs(["activate", "--dry-run", "--tenant", T, "--actor", U])).toMatchObject({ dryRun: true });
  });

  it("parses anchor-identities (RT-453) with and without --dry-run", () => {
    expect(parseInventoryEffectsArgs(["anchor-identities", "--tenant", T, "--actor", U])).toEqual({
      kind: "anchor-identities",
      tenantId: T.toLowerCase(),
      actorId: U,
      dryRun: false,
    });
    expect(parseInventoryEffectsArgs(["anchor-identities", "--tenant", T, "--actor", U, "--dry-run"])).toMatchObject({
      dryRun: true,
    });
    expect(() => parseInventoryEffectsArgs(["anchor-identities", "--tenant", T])).toThrow(/--actor/);
  });

  it("parses compare", () => {
    expect(parseInventoryEffectsArgs(["compare", "--tenant", T])).toEqual({ kind: "compare", tenantId: T.toLowerCase() });
  });

  it("parses equivalence (RT-428)", () => {
    expect(parseInventoryEffectsArgs(["equivalence", "--tenant", T])).toEqual({
      kind: "equivalence",
      tenantId: T.toLowerCase(),
    });
  });

  it.each<[string, string[], RegExp]>([
    ["an unknown command", ["deactivate", "--tenant", T], /usage/],
    ["no command", [], /usage/],
    ["a missing tenant", ["activate", "--actor", U], /--tenant/],
    ["a malformed actor", ["activate", "--tenant", T, "--actor", "me"], /--actor/],
    ["a flag without a value", ["compare", "--tenant"], /--tenant/],
  ])("refuses %s", (_label, argv, message) => {
    expect(() => parseInventoryEffectsArgs(argv)).toThrow(message);
  });
});
