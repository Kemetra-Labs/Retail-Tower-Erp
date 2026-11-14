import type { AlarmKind } from "../../model/types";
import type { StringKey } from "../../i18n/strings";

export type IconKey = AlarmKind | "unknown" | "ok" | "hostok";

/** One 18 x 18 stroke path per alarm kind (copied from the approved mockup). */
export const ICONS: Record<IconKey, string> = {
  refused: "M5 8V6a4 4 0 0 1 8 0v2M4 8h10v7H4zM9 11v2",
  down: "M6 2v4M12 2v4M4 6h10v2a5 5 0 0 1-10 0zM9 13v3M2 2l14 14",
  timeout: "M5 2h8M5 16h8M6 2c0 4 6 4 6 7s-6 3-6 7M12 2c0 4-6 4-6 7s6 3 6 7",
  reset: "M1 9h5M12 9h5M6 5v8M12 5v8M9 3l-1 3M9 15l1-3",
  bug: "M6 5L2 9l4 4M12 5l4 4-4 4M10 3L8 15",
  unknown: "M7 7a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.5M9 13v.5",
  ok: "M4 9l3 3 7-7",
  latency: "M3 13a6 6 0 1 1 12 0M9 13l3-4M9 13h.01",
  nodata: "M1 9h3l2-4 3 8 2-4h2M14 4l3 3M17 4l-3 3",
  monitor: "M9 2a4 4 0 0 0-4 4v3l-1.5 3h11L13 9V6a4 4 0 0 0-4-4zM7.5 15a1.5 1.5 0 0 0 3 0",
  hostok: "M1 9h3l2-4 3 8 2-4h6",
};

/** Short code printed under each kind (not translated: it is what the tools print). */
export const KIND_CODE: Record<AlarmKind | "unknown", string> = {
  refused: "403",
  down: "502",
  timeout: "timeout",
  reset: "reset",
  bug: "React",
  unknown: "no check",
  latency: "p95",
  nodata: "no data",
  monitor: "ALR",
};

export const KIND_TITLE: Record<AlarmKind | "unknown", StringKey> = {
  refused: "kindRefused",
  down: "kindDown",
  timeout: "kindTimeout",
  reset: "kindReset",
  bug: "kindBug",
  unknown: "kindUnknown",
  latency: "kindLatency",
  nodata: "kindNodata",
  monitor: "kindMonitor",
};

/** Legend order of the alarm icons. */
export const LEGEND_KINDS: (AlarmKind | "unknown")[] = [
  "refused",
  "timeout",
  "down",
  "reset",
  "bug",
  "latency",
  "nodata",
  "unknown",
];
