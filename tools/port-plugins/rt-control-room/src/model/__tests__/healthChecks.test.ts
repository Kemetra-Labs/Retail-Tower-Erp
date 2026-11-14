import { describe, expect, it } from "vitest";
import { buildBoard } from "../board";
import { fixture, NOW } from "../../state/__tests__/testkit";

const groups = (board: ReturnType<typeof buildBoard>) => Object.fromEntries(board.healthChecks.map((g) => [g.key, g]));

describe("board.healthChecks", () => {
  it("groups the 18 fixture monitors by what they watch", () => {
    const board = buildBoard(fixture(), { now: NOW, demo: false });
    expect(board.healthChecks.map((g) => g.key)).toEqual(["core", "servers", "databases", "admin", "conn", "pos"]);
    const g = groups(board);
    expect(g.core).toMatchObject({ ok: 7, total: 7, alert: false, na: false });
    expect(g.servers).toMatchObject({ ok: 8, total: 8, alert: false });
    expect(g.databases).toMatchObject({ ok: 3, total: 3, alert: false });
    // No check at all is unknown (total 0), POS needs none by design.
    expect(g.admin).toMatchObject({ total: 0, na: false });
    expect(g.conn).toMatchObject({ total: 0, na: false });
    expect(g.pos).toMatchObject({ total: 0, na: true });
    expect(board.healthChecks.reduce((n, x) => n + x.total, 0)).toBe(18);
  });

  it("counts a monitor in alarm and lists one that cannot be placed as 'other'", () => {
    const snap = fixture();
    const redis = snap.monitors.find((m) => m.identifier === "datadog-monitor-900203");
    if (!redis) throw new Error("fixture changed");
    redis.title = "Redis instance down";
    redis.properties.overallState = "Alert";
    const board = buildBoard(snap, { now: NOW, demo: false });
    const g = groups(board);
    expect(g.databases).toMatchObject({ ok: 2, total: 2 });
    expect(g.other).toMatchObject({ ok: 0, total: 1, alert: true });
  });

  it("lowers the Backend-Core group for the example alarm, like its lamp", () => {
    const board = buildBoard(fixture(), { now: NOW, demo: true });
    expect(groups(board).core).toMatchObject({ ok: 6, total: 7, alert: true });
  });
});
