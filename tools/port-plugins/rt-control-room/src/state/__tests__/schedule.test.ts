import { describe, expect, it } from "vitest";
import { nextPoll } from "../schedule";

describe("nextPoll", () => {
  it("makes the first load immediate and full", () => {
    expect(nextPoll({ polls: 0, lastAt: null }, 1_000)).toEqual({ at: 1_000, full: true });
  });

  it("schedules the next poll 60 s after the previous one started", () => {
    expect(nextPoll({ polls: 1, lastAt: 5_000 }, 9_000).at).toBe(65_000);
  });

  it("makes polls 1, 5, 10 and 15 full and the others deltas", () => {
    const full = Array.from({ length: 15 }, (_, i) => nextPoll({ polls: i, lastAt: 0 }, 0).full);
    const fullNumbers = full.flatMap((f, i) => (f ? [i + 1] : []));
    expect(fullNumbers).toEqual([1, 5, 10, 15]);
  });
});
