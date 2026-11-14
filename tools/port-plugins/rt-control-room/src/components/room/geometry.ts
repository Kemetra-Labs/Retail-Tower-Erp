import { ARCH, CABLE_IDS, HOST_IDS, STATION_IDS, type Tier } from "../../model/architecture";
import type { CableId, HostId, SourceId, StationId } from "../../model/types";
import { toD, type Curve, type Pt } from "./path";

/** The diagram's drawing box (the mockup's viewBox). It reads left to right in both languages. */
export const VIEW = { w: 1240, h: 820 } as const;
export const BUS_Y = 150;
const SOURCE_BOTTOM = 114;

// One column per tier. A fifth service joins an existing tier (or a new tier
// entry here) and is placed by data, not by code edits.
const TIERS: Record<Tier, { x: number; w: number; h: number }> = {
  front: { x: 30, w: 260, h: 214 },
  core: { x: 400, w: 270, h: 222 },
  integration: { x: 760, w: 250, h: 214 },
  books: { x: 1118, w: 107, h: 80 },
};
export const TIER_ORDER: Tier[] = ["front", "core", "integration", "books"];
const CENTER_Y = 458;
const STACK_GAP = 32;

export type Rect = { x: number; y: number; w: number; h: number };
export type Placed<Id extends string = StationId> = Rect & { id: Id; tier: Tier; index: number; ledger: boolean };
export type StationBox = Placed<StationId>;
export type CableGeom = {
  id: CableId;
  from: StationId;
  to: StationId;
  curve: Curve;
  d: string;
  mid: Pt;
  /** Centre of the "what it carries" tag. */
  label: Pt;
  /** Top of the alarm-pin row sitting on the cable. */
  pinY: number;
  /** The gate line of the "refused" gesture, at the route owner's end (Backend-Core's end on c3). */
  gate: { x: number; y1: number; y2: number };
};
export type RiserGeom = { station: StationId; curve: Curve; d: string };
export type RuleGeom = { from: StationId; d: string };
export type HostBox = Rect & { id: HostId; station: StationId; linkD: string };
export type SourceBox = { id: SourceId; x: number; w: number; cx: number };
export type RoomLayout = {
  stations: Record<StationId, StationBox>;
  cables: CableGeom[];
  risers: RiserGeom[];
  rules: RuleGeom[];
  ruleLabel: Pt;
  hosts: HostBox[];
  sources: SourceBox[];
  zones: { tier: Tier; x: number }[];
};

export const SOURCE_IDS: SourceId[] = ["sentry", "datadog", "github", "jira"];

/** Stack the stations of each tier in its column, centred on one horizontal axis. */
export function layoutStations<Id extends string>(list: { id: Id; tier: Tier }[]): Record<Id, Placed<Id>> {
  const out = {} as Record<Id, Placed<Id>>;
  for (const tier of TIER_ORDER) {
    const members = list.filter((s) => s.tier === tier);
    const col = TIERS[tier];
    const total = members.length * col.h + Math.max(0, members.length - 1) * STACK_GAP;
    members.forEach((s, index) => {
      out[s.id] = {
        id: s.id,
        tier,
        index,
        ledger: tier === "books",
        x: col.x,
        w: col.w,
        h: col.h,
        y: CENTER_Y - total / 2 + index * (col.h + STACK_GAP),
      };
    });
  }
  return out;
}

export const cx = (r: Rect): number => r.x + r.w / 2;
export const cy = (r: Rect): number => r.y + r.h / 2;

function riserFor(box: StationBox): Curve {
  // The first station of a tier rises straight up; a station stacked below goes round the left edge.
  const pts: Pt[] =
    box.index === 0
      ? [
          { x: cx(box), y: box.y },
          { x: cx(box), y: BUS_Y },
        ]
      : [
          { x: box.x, y: cy(box) },
          { x: box.x - 14, y: cy(box) },
          { x: box.x - 14, y: BUS_Y },
        ];
  return { kind: "poly", pts };
}

/** The route from a station up its riser, along the bus and into a source box. */
export function busRoute(layout: RoomLayout, station: StationId, source: SourceId): Curve | null {
  const riser = layout.risers.find((r) => r.station === station);
  const src = layout.sources.find((s) => s.id === source);
  // The ledger has no riser: nothing of its own reaches the bus.
  if (!riser || riser.curve.kind !== "poly" || !src) return null;
  return {
    kind: "poly",
    pts: [...riser.curve.pts, { x: src.cx, y: BUS_Y }, { x: src.cx, y: SOURCE_BOTTOM }],
  };
}

function hostsFor(stations: Record<StationId, StationBox>): HostBox[] {
  const W = 220;
  const GAP = 30;
  const Y = 740;
  const out: HostBox[] = [];
  for (const sid of STATION_IDS) {
    const mine = HOST_IDS.filter((h) => ARCH.hosts[h] === sid);
    if (mine.length === 0) continue;
    const s = stations[sid];
    const total = mine.length * W + (mine.length - 1) * GAP;
    const x0 = Math.max(20, Math.min(cx(s) - total / 2, 1225 - total));
    mine.forEach((id, i) => {
      const x = x0 + i * (W + GAP);
      const hx = x + W / 2;
      const bottom = s.y + s.h;
      out.push({
        id,
        station: sid,
        x,
        y: Y,
        w: W,
        h: 56,
        linkD: `M${hx} ${Y} C ${hx} 680, ${cx(s)} ${bottom + 60}, ${cx(s)} ${bottom}`,
      });
    });
  }
  return out;
}

/** The whole diagram's geometry, computed from the architecture map's tiers. */
export function layoutRoom(): RoomLayout {
  const stations = layoutStations(STATION_IDS.map((id) => ({ id, tier: ARCH.stations[id].tier })));

  const cables: CableGeom[] = CABLE_IDS.map((id) => {
    const { from, to } = ARCH.cables[id];
    const a = stations[from];
    const b = stations[to];
    const p: [Pt, Pt, Pt, Pt] = [
      { x: a.x + a.w, y: cy(a) },
      { x: a.x + a.w + 50, y: cy(a) },
      { x: b.x - 50, y: cy(b) },
      { x: b.x, y: cy(b) },
    ];
    const curve: Curve = { kind: "cubic", p };
    const mid = { x: (p[0].x + p[3].x) / 2, y: (p[0].y + p[3].y) / 2 };
    const gap = b.x - (a.x + a.w);
    const dy = b.ledger ? 40 : gap < 100 ? -34 : -3;
    return {
      id,
      from,
      to,
      curve,
      d: toD(curve),
      mid,
      label: { x: mid.x, y: mid.y + dy },
      pinY: Math.min(mid.y - 48, mid.y + dy - 14 - 24),
      gate:
        ARCH.cableOwner[id] === from
          ? { x: a.x + a.w + 18, y1: cy(a) - 15, y2: cy(a) + 15 }
          : { x: b.x - 18, y1: cy(b) - 15, y2: cy(b) + 15 },
    };
  });

  const risers: RiserGeom[] = STATION_IDS.filter((id) => !stations[id].ledger).map((id) => {
    const curve = riserFor(stations[id]);
    return { station: id, curve, d: toD(curve) };
  });

  // Entry stations have no direct cable to the books: drawn as a deliberate, neutral protection.
  const all = STATION_IDS.map((id) => stations[id]);
  const books = all.find((s) => s.ledger);
  const rules: RuleGeom[] = [];
  let lowest = 0;
  if (books) {
    all
      .filter((s) => s.tier === "front")
      .forEach((s, i) => {
        const sy = s.y + (i === 0 ? 70 : 124);
        const ctrl = i === 0 ? sy - 50 : s.y + s.h;
        lowest = Math.max(lowest, ctrl);
        const ey = books.y - 31 + i * 100;
        rules.push({ from: s.id, d: `M${s.x + s.w} ${sy} C 560 ${ctrl}, 980 ${ctrl}, ${books.x + 22} ${ey}` });
      });
  }
  const bridge = all.find((s) => s.tier === "integration");
  const ruleLabel = { x: bridge ? cx(bridge) : 880, y: lowest + 18 };

  const sources: SourceBox[] = SOURCE_IDS.map((id, i) => ({ id, x: 36 + i * 296, w: 280, cx: 36 + i * 296 + 140 }));
  const zones = TIER_ORDER.map((tier) => ({ tier, x: TIERS[tier].x }));
  return { stations, cables, risers, rules, ruleLabel, hosts: hostsFor(stations), sources, zones };
}

/** Pin positions (top-left of each 20 x 20 pin) for `n` pins on a cable, centred on its midpoint. */
export function cablePins(cable: CableGeom, n: number): Pt[] {
  const x0 = cable.mid.x - (n * 24 - 4) / 2;
  return Array.from({ length: n }, (_, i) => ({ x: x0 + i * 24, y: cable.pinY }));
}

/** Pin positions for `n` pins at the top-right of a station, growing leftwards. */
export function stationPins(box: Rect, n: number): Pt[] {
  return Array.from({ length: n }, (_, i) => ({ x: box.x + box.w - 62 - i * 24, y: box.y - 14 }));
}

export function hostPins(box: Rect, n: number): Pt[] {
  return Array.from({ length: n }, (_, i) => ({ x: box.x + box.w - 26 - i * 24, y: box.y - 12 }));
}
