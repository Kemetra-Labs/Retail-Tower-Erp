import { ARCH, isCableId, isHostId } from "../model/architecture";
import type { Alarm, CableId, HostId, I18n, StationId } from "../model/types";
import type { Lang } from "../i18n/strings";

/** Short names for a cable's two ends ("Connector", not "ERPNext-Connector"), as the mockup writes them. */
export const SHORT: Record<StationId, I18n> = {
  pos: { en: "POS", ar: "POS" },
  admin: { en: "Admin Console", ar: "لوحة الإدارة" },
  core: { en: "Backend-Core", ar: "Backend-Core" },
  conn: { en: "Connector", ar: "الجسر" },
  erp: { en: "ERPNext", ar: "ERPNext" },
};

export type Where =
  | { kind: "cable"; cable: CableId; from: string; to: string; carries: string }
  | { kind: "station"; station: StationId; name: string }
  | { kind: "host"; host: HostId; station: StationId; name: string }
  | { kind: "unplaced" };

/** Where an alarm is, in words: on a cable, inside a station, on a server, or not placed. */
export function whereOf(alarm: Alarm, lang: Lang): Where {
  const at = alarm.at;
  if (at === "unlocated") return { kind: "unplaced" };
  if (isCableId(at)) {
    const cable = ARCH.cables[at];
    return {
      kind: "cable",
      cable: at,
      from: SHORT[cable.from][lang],
      to: SHORT[cable.to][lang],
      carries: cable.carries[lang].toLowerCase(),
    };
  }
  if (isHostId(at)) return { kind: "host", host: at, station: ARCH.hosts[at], name: ARCH.stations[ARCH.hosts[at]].name };
  return { kind: "station", station: at, name: ARCH.stations[at].name };
}

export type RequestPath = { hops: StationId[]; failing: StationId | null };

/**
 * The allowed request path up to the hop where the fault is. A cable fault
 * fails at the cable's far end; an alarm inside a station fails at the
 * station. A station off the path (Admin Console) shows alone; an alarm that
 * cannot be placed has no path.
 */
export function pathOf(alarm: Alarm): RequestPath {
  const at = alarm.at;
  if (at === "unlocated") return { hops: [], failing: null };
  if (isCableId(at)) {
    const { from, to } = ARCH.cables[at];
    const path = ARCH.path as readonly StationId[];
    // A cable off the main path (Admin Console to Backend-Core) shows its two ends only.
    return path.includes(from) ? { hops: ARCH.path.slice(0, path.indexOf(to) + 1), failing: to } : { hops: [from, to], failing: to };
  }
  const station: StationId = isHostId(at) ? ARCH.hosts[at] : at;
  const index = (ARCH.path as readonly StationId[]).indexOf(station);
  if (index >= 0) return { hops: ARCH.path.slice(0, index + 1), failing: station };
  return { hops: [station], failing: station };
}

/** A link is shown only when it is https (Sentry and Datadog links come from Port entity data). */
export function httpsLink(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
