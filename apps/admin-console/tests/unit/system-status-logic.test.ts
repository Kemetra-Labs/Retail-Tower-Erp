import type { ConsoleSystemStatus } from "@/lib/system-status-queries";
import {
  STALE_AFTER_MS,
  ageMinutes,
  isStale,
  linkRoute,
  statusView,
  unknownView,
  worstOf,
} from "@/shell/systemStatusLogic";
import { describe, expect, test } from "vitest";

const AT = "2026-11-02T10:00:00.000Z";

function body(over: {
  server?: object;
  saleSync?: object;
  erpConnector?: object;
  shipmentTransfers?: object;
  overall?: string;
}): ConsoleSystemStatus {
  return {
    asOf: AT,
    overall: over.overall ?? "ok",
    components: {
      server: { state: "ok", reason: "answered", observedAt: AT, link: "none", ...over.server },
      saleSync: {
        state: "ok",
        reason: "keeping_up",
        observedAt: AT,
        link: "sale_sync_ops",
        facts: null,
        ...over.saleSync,
      },
      erpConnector: {
        state: "ok",
        reason: "heartbeat_fresh",
        observedAt: AT,
        link: "erp_connection",
        facts: null,
        ...over.erpConnector,
      },
      // RT-1552: optional, absent from an older server.
      ...(over.shipmentTransfers
        ? {
            shipmentTransfers: {
              state: "ok",
              reason: "keeping_up",
              observedAt: AT,
              link: "none",
              facts: null,
              ...over.shipmentTransfers,
            },
          }
        : {}),
    },
  } as ConsoleSystemStatus;
}

describe("RT-1071 reason → state mapping (D-1)", () => {
  const cases: [string, string, string][] = [
    ["saleSync", "keeping_up", "ok"],
    ["saleSync", "queue_behind", "degraded"],
    ["saleSync", "needs_repair", "degraded"],
    ["saleSync", "queue_stalled", "down"],
    ["saleSync", "check_timed_out", "unknown"],
    ["erpConnector", "heartbeat_fresh", "ok"],
    ["erpConnector", "erp_unreachable_reported", "degraded"],
    ["erpConnector", "some_instances_stale", "degraded"],
    ["erpConnector", "heartbeat_stale", "down"],
    ["erpConnector", "not_configured", "unknown"],
    ["erpConnector", "all_disabled", "unknown"],
    ["erpConnector", "never_seen", "unknown"],
    ["erpConnector", "check_timed_out", "unknown"],
  ];
  test.each(cases)("%s %s → %s", (id, reason, state) => {
    const view = statusView(
      body({ [id]: { state, reason }, overall: state === "ok" ? "ok" : state }),
    );
    const c = view.components.find((x) => x.id === id);
    expect(c?.state).toBe(state);
    expect(c?.reasonKey).toBe(`shell.status.reason.${reason}`);
  });

  test("the server is ok / answered with no link", () => {
    const c = statusView(body({})).components[0];
    expect(c).toMatchObject({ id: "server", state: "ok", route: null });
  });

  test("a reason that disagrees with its state is unknown, never ok", () => {
    const view = statusView(
      body({ saleSync: { state: "ok", reason: "queue_stalled" }, overall: "ok" }),
    );
    expect(view.components[1]).toMatchObject({ state: "unknown", reasonKey: null });
    expect(view.overall).toBe("unknown");
  });

  test("a reason that belongs to another component is unknown, never ok", () => {
    const sale = statusView(
      body({ saleSync: { state: "ok", reason: "heartbeat_fresh" }, overall: "ok" }),
    );
    expect(sale.components[1]).toMatchObject({ state: "unknown", reasonKey: null });
    const erp = statusView(body({ erpConnector: { state: "ok", reason: "keeping_up" } }));
    expect(erp.components[2].state).toBe("unknown");
    const server = statusView(body({ server: { state: "ok", reason: "keeping_up" } }));
    expect(server.components[0].state).toBe("unknown");
    expect(server.overall).toBe("unknown");
  });

  test("an unrecognised state is unknown", () => {
    const view = statusView(
      body({ erpConnector: { state: "healthy", reason: "heartbeat_fresh" } }),
    );
    expect(view.components[2].state).toBe("unknown");
    expect(view.overall).toBe("unknown");
  });

  test("a missing component is unknown", () => {
    const b = body({});
    (b.components as unknown as Record<string, unknown>).saleSync = undefined;
    expect(statusView(b).components[1].state).toBe("unknown");
  });
});

describe("RT-1071 overall (worst-of)", () => {
  test("order down > degraded > unknown > ok", () => {
    expect(worstOf(["ok", "unknown", "degraded", "down"])).toBe("down");
    expect(worstOf(["ok", "unknown", "degraded"])).toBe("degraded");
    expect(worstOf(["ok", "unknown"])).toBe("unknown");
    expect(worstOf(["ok", "ok"])).toBe("ok");
  });

  test("ok only when every component and the server's overall are ok", () => {
    expect(statusView(body({})).overall).toBe("ok");
    expect(statusView(body({ overall: "down" })).overall).toBe("down");
    const degraded = body({
      saleSync: { state: "degraded", reason: "queue_behind" },
      overall: "ok",
    });
    expect(statusView(degraded).overall).toBe("degraded");
  });
});

describe("RT-1071 destinations (D-5, UX-09)", () => {
  test("closed links map to existing routes; none and unknown map to nothing", () => {
    expect(linkRoute("sale_sync_ops")).toBe("/sales-needing-repair");
    expect(linkRoute("erp_connection")).toBe("/erp-connection");
    expect(linkRoute("none")).toBeNull();
    expect(linkRoute("https://elsewhere.example")).toBeNull();
    expect(linkRoute(undefined)).toBeNull();
  });
});

describe("RT-1071 failed read and freshness", () => {
  test("a failed read is every component unknown with no destination", () => {
    const v = unknownView();
    expect(v.overall).toBe("unknown");
    expect(v.components.map((c) => c.state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(v.components.every((c) => c.route === null && c.reasonKey === null)).toBe(true);
  });

  test("stale 10 minutes after receipt, by the local clock", () => {
    expect(isStale(0, STALE_AFTER_MS - 1)).toBe(false);
    expect(isStale(0, STALE_AFTER_MS)).toBe(true);
    expect(ageMinutes(0, 30_000)).toBe(1);
    expect(ageMinutes(0, 11 * 60_000 + 5_000)).toBe(11);
  });
});

/** RT-1552: the optional `shipmentTransfers` component (RT-1516, contract 1.1.0-draft). */
describe("RT-1552 shipmentTransfers component", () => {
  const FACTS = {
    openTransferCount: 4,
    delayedTransferCount: 0,
    oldestOpenTransferAgeSeconds: 400_000,
    delayedThresholdDays: 3,
    stuckPostingCount: 0,
    postingsNeedingAttentionCount: 0,
    unreleasedReceiptCount: 0,
  };
  const transfers = (view: ReturnType<typeof statusView>) =>
    view.components.find((c) => c.id === "shipmentTransfers");

  const cases: [string, string][] = [
    ["keeping_up", "ok"],
    ["transfers_delayed", "degraded"],
    ["postings_stuck", "degraded"],
    ["postings_need_attention", "degraded"],
    ["check_timed_out", "unknown"],
  ];
  test.each(cases)("%s → %s, with its own reason message", (reason, state) => {
    const view = statusView(
      body({ shipmentTransfers: { state, reason }, overall: state === "ok" ? "ok" : state }),
    );
    expect(transfers(view)).toMatchObject({
      id: "shipmentTransfers",
      state,
      reasonKey: `shell.status.reason.${reason}`,
      route: null,
    });
  });

  test("absent (an older server): three components, nothing about transfers, overall unchanged", () => {
    const view = statusView(body({}));
    expect(view.components.map((c) => c.id)).toEqual(["server", "saleSync", "erpConnector"]);
    expect(transfers(view)).toBeUndefined();
    expect(view.overall).toBe("ok");
    const degraded = statusView(
      body({ saleSync: { state: "degraded", reason: "queue_behind" }, overall: "degraded" }),
    );
    expect(degraded.components).toHaveLength(3);
    expect(degraded.overall).toBe("degraded");
  });

  test("present: shown after the other three, so their order is unchanged", () => {
    const view = statusView(body({ shipmentTransfers: {} }));
    expect(view.components.map((c) => c.id)).toEqual([
      "server",
      "saleSync",
      "erpConnector",
      "shipmentTransfers",
    ]);
  });

  test("a degraded transfers component makes the overall degraded, matching the server's", () => {
    const view = statusView(
      body({
        shipmentTransfers: { state: "degraded", reason: "transfers_delayed", facts: FACTS },
        overall: "degraded",
      }),
    );
    expect(view.overall).toBe("degraded");
  });

  test("the overall is never better than the transfers component, even if the server says ok", () => {
    const view = statusView(
      body({ shipmentTransfers: { state: "degraded", reason: "postings_stuck" }, overall: "ok" }),
    );
    expect(view.overall).toBe("degraded");
  });

  test("unknown is never ok: a timed-out check keeps the overall unknown", () => {
    const view = statusView(
      body({
        shipmentTransfers: { state: "unknown", reason: "check_timed_out" },
        overall: "unknown",
      }),
    );
    expect(transfers(view)?.state).toBe("unknown");
    expect(view.overall).toBe("unknown");
    // Even when the server claims ok, the component keeps it from being ok.
    const claimed = statusView(
      body({ shipmentTransfers: { state: "unknown", reason: "check_timed_out" }, overall: "ok" }),
    );
    expect(claimed.overall).toBe("unknown");
  });

  test("a reason that disagrees with its state, or belongs to another component, is unknown", () => {
    const wrongState = statusView(
      body({ shipmentTransfers: { state: "ok", reason: "transfers_delayed" } }),
    );
    expect(transfers(wrongState)).toMatchObject({ state: "unknown", reasonKey: null, fact: null });
    expect(wrongState.overall).toBe("unknown");
    const foreign = statusView(
      body({ shipmentTransfers: { state: "degraded", reason: "queue_behind" } }),
    );
    expect(transfers(foreign)?.state).toBe("unknown");
    // And no other component accepts a transfers reason.
    const other = statusView(
      body({ saleSync: { state: "degraded", reason: "transfers_delayed" } }),
    );
    expect(other.components[1].state).toBe("unknown");
  });

  test("a present but null component is an unknown row, not an older server's absence", () => {
    const b = body({});
    (b.components as unknown as Record<string, unknown>).shipmentTransfers = null;
    const view = statusView(b);
    expect(transfers(view)).toMatchObject({ state: "unknown", reasonKey: null, fact: null });
    expect(view.components).toHaveLength(4);
    expect(view.overall).toBe("unknown");
  });

  test("an unrecognised state is unknown, never ok", () => {
    const view = statusView(
      body({ shipmentTransfers: { state: "healthy", reason: "keeping_up" } }),
    );
    expect(transfers(view)?.state).toBe("unknown");
    expect(view.overall).toBe("unknown");
  });

  test("the link stays none: no route is invented, whatever the server sends", () => {
    for (const link of ["none", "sale_sync_ops", "https://elsewhere.example"]) {
      const view = statusView(
        body({ shipmentTransfers: { state: "degraded", reason: "postings_stuck", link } }),
      );
      expect(transfers(view)?.route).toBeNull();
    }
  });

  test("a failed read still shows exactly the three components, no transfers row invented", () => {
    expect(unknownView().components.map((c) => c.id)).toEqual([
      "server",
      "saleSync",
      "erpConnector",
    ]);
  });

  describe("the count line (only when degraded, only a count the server sent)", () => {
    const degraded = (reason: string, facts: unknown) =>
      transfers(
        statusView(
          body({ shipmentTransfers: { state: "degraded", reason, facts }, overall: "degraded" }),
        ),
      );

    test("transfers_delayed names the delayed count and the tenant's threshold in days", () => {
      expect(degraded("transfers_delayed", { ...FACTS, delayedTransferCount: 2 })?.fact).toEqual({
        key: "shell.status.fact.transfers_delayed",
        count: 2,
        days: 3,
      });
      expect(
        degraded("transfers_delayed", {
          ...FACTS,
          delayedTransferCount: 1,
          delayedThresholdDays: 7,
        })?.fact,
      ).toMatchObject({ count: 1, days: 7 });
    });

    test("postings_stuck names the stuck count", () => {
      expect(degraded("postings_stuck", { ...FACTS, stuckPostingCount: 5 })?.fact).toEqual({
        key: "shell.status.fact.postings_stuck",
        count: 5,
        days: null,
      });
    });

    test("postings_need_attention adds the postings and the unreleased receipts it covers", () => {
      expect(
        degraded("postings_need_attention", {
          ...FACTS,
          postingsNeedingAttentionCount: 1,
          unreleasedReceiptCount: 2,
        })?.fact,
      ).toEqual({ key: "shell.status.fact.postings_need_attention", count: 3, days: null });
      expect(
        degraded("postings_need_attention", { ...FACTS, unreleasedReceiptCount: 2 })?.fact,
      ).toMatchObject({ count: 2 });
    });

    test("postings_need_attention shows no line when either half is malformed, never a partial total", () => {
      const attention = (facts: object) =>
        degraded("postings_need_attention", { ...FACTS, ...facts })?.fact;
      expect(
        attention({ postingsNeedingAttentionCount: "x", unreleasedReceiptCount: 2 }),
      ).toBeNull();
      expect(
        attention({ postingsNeedingAttentionCount: 1, unreleasedReceiptCount: undefined }),
      ).toBeNull();
      expect(
        attention({
          postingsNeedingAttentionCount: Number.MAX_SAFE_INTEGER,
          unreleasedReceiptCount: Number.MAX_SAFE_INTEGER,
        }),
      ).toBeNull();
      expect(
        degraded("postings_stuck", { ...FACTS, stuckPostingCount: 2 ** 53 + 2 })?.fact,
      ).toBeNull();
    });

    test("no line for a zero count, null facts, or malformed facts: nothing is invented", () => {
      expect(degraded("transfers_delayed", FACTS)?.fact).toBeNull();
      expect(degraded("transfers_delayed", null)?.fact).toBeNull();
      expect(degraded("postings_stuck", { ...FACTS, stuckPostingCount: "5" })?.fact).toBeNull();
      expect(degraded("postings_stuck", { ...FACTS, stuckPostingCount: -1 })?.fact).toBeNull();
      expect(degraded("postings_stuck", { stuckPostingCount: Number.NaN })?.fact).toBeNull();
      expect(
        degraded("transfers_delayed", {
          ...FACTS,
          delayedTransferCount: 2,
          delayedThresholdDays: 0,
        })?.fact,
      ).toBeNull();
      expect(degraded("transfers_delayed", "facts")?.fact).toBeNull();
    });

    test("no line for ok or unknown, even if the server sends counts", () => {
      const ok = transfers(
        statusView(
          body({
            shipmentTransfers: {
              state: "ok",
              reason: "keeping_up",
              facts: { ...FACTS, delayedTransferCount: 2 },
            },
          }),
        ),
      );
      expect(ok?.fact).toBeNull();
      const unknown = transfers(
        statusView(
          body({
            shipmentTransfers: {
              state: "unknown",
              reason: "check_timed_out",
              facts: { ...FACTS, stuckPostingCount: 4 },
            },
            overall: "unknown",
          }),
        ),
      );
      expect(unknown?.fact).toBeNull();
    });

    test("the other components never carry a count line", () => {
      const view = statusView(body({ shipmentTransfers: {} }));
      expect(view.components.slice(0, 3).every((c) => c.fact === null)).toBe(true);
    });
  });
});
