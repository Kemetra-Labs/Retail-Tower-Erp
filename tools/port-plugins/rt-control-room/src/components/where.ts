import { ARCH, failingHopOf, isCableId, isHostId } from "../model/architecture";
import type { Alarm, CableId, HostId, I18n, StationId } from "../model/types";
import { format, type Lang, type StringKey } from "../i18n/strings";
import { KIND_TITLE } from "./room/icons";

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

/**
 * The two ends of a cable alarm in the direction of the request: from the
 * caller (the end that is not the route's owner) to the owner, the failing
 * hop. On c3 that is Connector to Backend-Core: the Connector pulls from Backend-Core.
 */
export function cableEnds(cable: CableId): { caller: StationId; owner: StationId } {
  const { from, to } = ARCH.cables[cable];
  const owner = ARCH.cableOwner[cable];
  return { caller: owner === from ? to : from, owner };
}

/** Where an alarm is, in words: on a cable, inside a station, on a server, or not placed. */
export function whereOf(alarm: Alarm, lang: Lang): Where {
  const at = alarm.at;
  if (at === "unlocated") return { kind: "unplaced" };
  if (isCableId(at)) {
    const { caller, owner } = cableEnds(at);
    return {
      kind: "cable",
      cable: at,
      from: SHORT[caller][lang],
      to: SHORT[owner][lang],
      carries: ARCH.cables[at].carries[lang].toLowerCase(),
    };
  }
  if (isHostId(at)) return { kind: "host", host: at, station: ARCH.hosts[at], name: ARCH.stations[ARCH.hosts[at]].name };
  return { kind: "station", station: at, name: ARCH.stations[at].name };
}

export type RequestPath = { hops: StationId[]; failing: StationId | null };

/**
 * The request path up to the hop where the fault is. A cable fault fails at
 * the route's owner: along the main path (POS, Backend-Core, Connector,
 * ERPNext) when the request runs that way, otherwise the caller then the owner
 * (the Connector pulling from Backend-Core on c3, Admin Console on c2). An
 * alarm inside a station fails at the station. A station off the path (Admin
 * Console) shows alone; an alarm that cannot be placed has no path.
 */
export function pathOf(alarm: Alarm): RequestPath {
  const at = alarm.at;
  if (at === "unlocated") return { hops: [], failing: null };
  if (isCableId(at)) {
    const { caller, owner } = cableEnds(at);
    const path = ARCH.path as readonly StationId[];
    const forward = path.includes(caller) && path.indexOf(caller) < path.indexOf(owner);
    return forward
      ? { hops: ARCH.path.slice(0, path.indexOf(owner) + 1), failing: owner }
      : { hops: [caller, owner], failing: owner };
  }
  const station: StationId = isHostId(at) ? ARCH.hosts[at] : at;
  const index = (ARCH.path as readonly StationId[]).indexOf(station);
  if (index >= 0) return { hops: ARCH.path.slice(0, index + 1), failing: station };
  return { hops: [station], failing: station };
}

/** Kinds whose title names the hop that failed, when the route (and so its owner) is known. */
const BY_HOP: Partial<Record<Alarm["kind"], StringKey>> = {
  refused: "kindRefusedBy",
  down: "kindDownBy",
  timeout: "kindTimeoutBy",
};

/**
 * The title of an alarm. On a cable the route's owner is known, so a refused,
 * down or slow request names it ("Backend-Core refused the request"). Inside a
 * station no route is known and the title stays neutral: it never blames
 * ERPNext, or anyone, without a route that says so.
 */
export function alarmTitle(alarm: Alarm, lang: Lang): string {
  const key = BY_HOP[alarm.kind];
  const hop = failingHopOf(alarm.at);
  if (key && isCableId(alarm.at) && hop) return format(key, lang, { name: SHORT[hop][lang] });
  return format(KIND_TITLE[alarm.kind], lang);
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
