import type { AlarmAt, CableId, HostId, I18n, StationId } from "./types";

export type Tier = "front" | "core" | "integration" | "books";

export type ArchStation = {
  id: StationId;
  name: string;
  /** Port `service` identifier; null for ERPNext, which has no service entity. */
  serviceId: string | null;
  tier: Tier;
  role: I18n;
};

export type ArchCable = {
  id: CableId;
  from: StationId;
  to: StationId;
  carries: I18n;
};

export const STATION_IDS: StationId[] = ["pos", "admin", "core", "conn", "erp"];
export const CABLE_IDS: CableId[] = ["c1", "c2", "c3", "c4"];
export const HOST_IDS: HostId[] = ["lab-01", "lab-02", "lab-03"];

/**
 * The allowed paths are a rule, not data (spec section 7), so they live here:
 * stations, cables, the request path and which station each server belongs to.
 */
export const ARCH = {
  stations: {
    pos: {
      id: "pos",
      name: "POS",
      serviceId: "pos",
      tier: "front",
      role: { en: "Where sales happen", ar: "هنا البيع بيحصل" },
    },
    admin: {
      id: "admin",
      name: "Admin Console",
      serviceId: "admin-console",
      tier: "front",
      role: { en: "Where managers run stores", ar: "هنا المديرين بيديروا المحلات" },
    },
    core: {
      id: "core",
      name: "Backend-Core",
      serviceId: "backend-core",
      tier: "core",
      role: { en: "The brain", ar: "العقل" },
    },
    conn: {
      id: "conn",
      name: "ERPNext-Connector",
      serviceId: "erpnext-connector",
      tier: "integration",
      role: { en: "The bridge to the accounts", ar: "الجسر للحسابات" },
    },
    erp: {
      id: "erp",
      name: "ERPNext",
      serviceId: null,
      tier: "books",
      role: { en: "The books", ar: "الدفاتر" },
    },
  } satisfies Record<StationId, ArchStation>,
  cables: {
    c1: { id: "c1", from: "pos", to: "core", carries: { en: "Sales, sync", ar: "مبيعات" } },
    c2: { id: "c2", from: "admin", to: "core", carries: { en: "Catalog, ops", ar: "كتالوج" } },
    c3: { id: "c3", from: "core", to: "conn", carries: { en: "Postings", ar: "قيود" } },
    c4: { id: "c4", from: "conn", to: "erp", carries: { en: "Invoices", ar: "فواتير" } },
  } satisfies Record<CableId, ArchCable>,
  /**
   * The station that owns the route each cable carries: the hop that fails
   * when a request on the cable fails. The Connector pulls postings FROM
   * Backend-Core, so c3's owner is Backend-Core, not the Connector.
   */
  cableOwner: { c1: "core", c2: "core", c3: "core", c4: "erp" } satisfies Record<CableId, StationId>,
  /** The static allowed request path, up to the hop where a fault happens. */
  path: ["pos", "core", "conn", "erp"] satisfies StationId[],
  /** Keys are the Datadog host_name exactly as Port stores it. */
  hosts: {
    "lab-01": "core",
    "lab-02": "core",
    "lab-03": "erp",
  } satisfies Record<HostId, StationId>,
  hostSub: {
    "lab-01": { en: "API and worker", ar: "واجهة البرمجة والمعالج" },
    "lab-02": { en: "Postgres database", ar: "قاعدة البيانات" },
    "lab-03": { en: "ERPNext, MariaDB, Redis", ar: "نظام الحسابات" },
  } satisfies Record<HostId, I18n>,
} as const;

/** Port workload identifier prefixes are not used: a workload maps through its `service` relation. */
export function stationForService(serviceId: string): StationId | null {
  for (const id of STATION_IDS) {
    if (ARCH.stations[id].serviceId === serviceId) return id;
  }
  return null;
}

/** The failing hop of an alarm placed at `at`: the cable's route owner, the station itself, a server's station, or none. */
export function failingHopOf(at: AlarmAt): StationId | null {
  if (at === "unlocated") return null;
  if (isCableId(at)) return ARCH.cableOwner[at];
  if (isHostId(at)) return ARCH.hosts[at];
  return at;
}

export function isCableId(value: string): value is CableId {
  return Object.prototype.hasOwnProperty.call(ARCH.cables, value);
}

export function isHostId(value: string): value is HostId {
  return Object.prototype.hasOwnProperty.call(ARCH.hosts, value);
}
