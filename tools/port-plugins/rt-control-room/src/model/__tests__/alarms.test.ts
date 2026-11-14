import { describe, expect, it } from "vitest";
import raw from "./fixtures/snapshot-2026-11-13.json";
import { ARCH, HOST_IDS, failingHopOf, stationForService } from "../architecture";
import {
  classifySentryKind,
  datadogAlarms,
  placeSentryAlarm,
  sentryAlarms,
  workloadServiceMap,
} from "../alarms";
import type { DatadogMonitor, SentryIssue, Snapshot } from "../types";

const snapshot = raw as unknown as Snapshot;
const map = workloadServiceMap(snapshot.workloads);

const T403 =
  "HTTPError: 403 Client Error: Forbidden for url: https://lab.kemetralabs.com/api/connector/v1/erpnext/postings";
const TTIMEOUT =
  "ConnectTimeout: HTTPConnectionPool(host='172.26.2.233', port=3000): Max retries exceeded with url: /api/connector/v1/erpnext/postings";
const T502 =
  "HTTPError: 502 Server Error: Bad Gateway for url: https://lab.kemetralabs.com/api/connector/v1/erpnext/bin-view-requests";
const TRESET =
  "ConnectionError: ('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))";
const TREACT =
  "Error: Objects are not valid as a React child (found: <redacted>). If you meant to render a collection of children, use an array instead.";

function issue(over: {
  title: string;
  workload?: string | null;
  properties?: SentryIssue["properties"];
}): SentryIssue {
  return {
    identifier: "sentry-x",
    title: over.title,
    properties: over.properties ?? { status: "unresolved", isUnhandled: true, link: null },
    relations: {
      workload: over.workload === undefined ? "retail-tower-erpnext-connector-staging" : over.workload,
    },
    createdAt: "2026-11-12T18:29:00Z",
    updatedAt: "2026-11-12T18:29:00Z",
  };
}

function monitor(
  title: string,
  state: string,
  opts: { workload?: string | null; tags?: string[]; link?: string | null } = {},
): DatadogMonitor {
  return {
    identifier: `m-${title}`,
    title,
    properties: { overallState: state, link: opts.link ?? null, tags: opts.tags ?? [] },
    relations: { service: opts.workload ?? null },
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-13T00:00:00Z",
  };
}

describe("classifySentryKind", () => {
  it.each([
    [T403, "refused"],
    [TTIMEOUT, "timeout"],
    [T502, "down"],
    [TRESET, "reset"],
    [TREACT, "bug"],
    ["Some brand new failure nobody classified", "bug"],
    ["503 Service Unavailable", "down"],
    ["Read timed out", "timeout"],
    ["Request aborted", "reset"],
  ])("%s", (title, kind) => {
    expect(classifySentryKind(title)).toBe(kind);
  });
});

describe("placeSentryAlarm (by route owner)", () => {
  it("pins a Connector issue that names a Backend-Core route (/api/connector/v1/) on the Postings cable c3", () => {
    expect(placeSentryAlarm("conn", T403)).toBe("c3");
    expect(placeSentryAlarm("conn", T502)).toBe("c3");
  });

  it("pins a Connector issue that targets Backend-Core's port 3000 on c3", () => {
    expect(placeSentryAlarm("conn", TTIMEOUT)).toBe("c3");
    expect(placeSentryAlarm("conn", "ConnectionError: http://10.0.0.5:3000/health refused")).toBe("c3");
  });

  it("pins a Connector issue that names a Frappe route (/api/resource/, /api/method/) on the Invoices cable c4", () => {
    expect(placeSentryAlarm("conn", "HTTPError: 417 Client Error for url: https://erp.example/api/resource/Sales%20Invoice")).toBe("c4");
    expect(placeSentryAlarm("conn", "HTTPError: 500 Server Error for url: https://erp.example/api/method/frappe.auth.get_logged_user")).toBe("c4");
  });

  it("pins a POS issue that names a Backend-Core route on the Sales cable c1", () => {
    expect(placeSentryAlarm("pos", "TypeError: Failed to fetch https://lab.example/api/v1/sales")).toBe("c1");
    expect(placeSentryAlarm("pos", "Error: connect ECONNREFUSED 127.0.0.1:3000")).toBe("c1");
  });

  it("pins an Admin Console issue that names a Backend-Core route on the Catalog cable c2", () => {
    expect(placeSentryAlarm("admin", "Error: 500 from /api/v1/catalog/items")).toBe("c2");
  });

  it("keeps an issue that names no route inside its station (never invents a route)", () => {
    expect(placeSentryAlarm("conn", TRESET)).toBe("conn");
    expect(placeSentryAlarm("admin", TREACT)).toBe("admin");
    expect(placeSentryAlarm("pos", "Error: something odd at /internal/thing")).toBe("pos");
  });

  it("never uses the old /erpnext/ rule: a Backend-Core route that contains /erpnext/ is not the Invoices cable", () => {
    expect(placeSentryAlarm("conn", T403)).not.toBe("c4");
  });

  it("keeps Backend-Core's own issues inside Backend-Core, whatever route they name", () => {
    expect(placeSentryAlarm("core", T403)).toBe("core");
    expect(placeSentryAlarm("core", "HTTPError for url: https://erp.example/api/resource/Item")).toBe("core");
  });
});

describe("failingHopOf", () => {
  it("names the owner of the route: Backend-Core for c1, c2 and c3, ERPNext for c4", () => {
    expect(failingHopOf("c1")).toBe("core");
    expect(failingHopOf("c2")).toBe("core");
    expect(failingHopOf("c3")).toBe("core");
    expect(failingHopOf("c4")).toBe("erp");
  });

  it("is the station itself inside a station, the server's station on a server, and none when unplaced", () => {
    expect(failingHopOf("conn")).toBe("conn");
    expect(failingHopOf("lab-03")).toBe("erp");
    expect(failingHopOf("unlocated")).toBeNull();
  });
});

describe("sentryAlarms on the 2026-11-13 snapshot", () => {
  const alarms = sentryAlarms(snapshot.sentryIssues, map);
  const at = (id: string) => alarms.filter((a) => a.at === id).length;

  it("raises 5 alarms, each from Sentry", () => {
    expect(alarms).toHaveLength(5);
    expect(alarms.every((a) => a.source === "Sentry")).toBe(true);
  });

  it("places 3 on c3 (Postings), none on c4, 1 inside the Connector and 1 inside Admin Console", () => {
    expect(at("c3")).toBe(3);
    expect(at("c4")).toBe(0);
    expect(at("conn")).toBe(1);
    expect(at("admin")).toBe(1);
  });

  it("classifies and places each real title", () => {
    const by = (needle: string) => alarms.find((a) => a.title.includes(needle))!;
    expect(by("403")).toMatchObject({ kind: "refused", at: "c3", station: "conn" });
    expect(by("ConnectTimeout")).toMatchObject({ kind: "timeout", at: "c3", station: "conn" });
    expect(by("502")).toMatchObject({ kind: "down", at: "c3", station: "conn" });
    expect(by("ConnectionResetError")).toMatchObject({ kind: "reset", at: "conn", station: "conn" });
    expect(by("React child")).toMatchObject({ kind: "bug", at: "admin", station: "admin" });
  });

  it("carries the Port creation time and an https link", () => {
    for (const a of alarms) {
      expect(a.since).toBe("2026-11-12T18:29:00Z");
      expect(a.link).toMatch(/^https:\/\/sentry\.io\//);
    }
  });
});

describe("sentryAlarms rules", () => {
  it("ignores resolved and ignored issues", () => {
    const resolved = issue({ title: T403, properties: { status: "resolved" } });
    const ignored = issue({ title: T403, properties: { status: "ignored" } });
    expect(sentryAlarms([resolved, ignored], map)).toEqual([]);
  });

  it("puts an unknown title inside its station as a code error", () => {
    const [a] = sentryAlarms(
      [issue({ title: "Totally new problem", workload: "retail-tower-admin-console-staging" })],
      map,
    );
    expect(a).toMatchObject({ kind: "bug", at: "admin", station: "admin" });
  });

  it("never hides an issue whose workload is missing or unknown: it is unlocated", () => {
    const none = sentryAlarms([issue({ title: TREACT, workload: null })], map);
    const unknown = sentryAlarms([issue({ title: TREACT, workload: "no-such-workload" })], map);
    for (const list of [none, unknown]) {
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ at: "unlocated", station: null, kind: "bug" });
    }
  });

  it("drops a link that is not http(s)", () => {
    const [a] = sentryAlarms(
      [issue({ title: TREACT, properties: { status: "unresolved", link: "javascript:alert(1)" } })],
      map,
    );
    expect(a.link).toBeNull();
  });
});

describe("datadogAlarms", () => {
  const core = "retail-tower-backend-api-staging";
  const worker = "retail-tower-backend-worker-staging";

  it("raises nothing when every monitor in the fixture is OK", () => {
    expect(snapshot.monitors).toHaveLength(18);
    expect(datadogAlarms(snapshot.monitors, map)).toEqual([]);
  });

  it("classifies latency, no data and other states on Backend-Core", () => {
    const alarms = datadogAlarms(
      [
        monitor("backend p95 latency high (lab)", "Alert", { workload: core }),
        monitor("backend request latency", "Warn", { workload: core }),
        monitor("backend not sending metrics (lab)", "No Data", { workload: core }),
        monitor("backend 5xx error rate high (lab)", "Alert", { workload: core }),
        monitor("backend worker heartbeat missing (lab)", "Warn", { workload: worker }),
        monitor("backend health ready failing (lab)", "OK", { workload: core }),
        monitor("backend ignored check", "Ignored", { workload: core }),
      ],
      map,
    );
    expect(alarms.map((a) => a.kind)).toEqual(["latency", "latency", "nodata", "monitor", "monitor"]);
    for (const a of alarms) expect(a).toMatchObject({ source: "Datadog", station: "core", at: "core" });
  });

  it("maps both Backend-Core workloads to the backend-core station", () => {
    expect(map.get(core)).toBe("backend-core");
    expect(map.get(worker)).toBe("backend-core");
    expect(stationForService("backend-core")).toBe("core");
  });

  it("places a monitor that names a known host in its title at that host", () => {
    const [a] = datadogAlarms([monitor("lab-03 Redis instance down", "Alert")], map);
    expect(a).toMatchObject({ at: "lab-03", station: "erp", kind: "monitor" });
    const [b] = datadogAlarms([monitor("lab-02 Postgres connections near the limit", "Warn")], map);
    expect(b).toMatchObject({ at: "lab-02", station: "core" });
  });

  it("places a monitor with a host: tag at that host", () => {
    const [a] = datadogAlarms([monitor("Disk is full", "Alert", { tags: ["env:lab", "host:lab-01"] })], map);
    expect(a).toMatchObject({ at: "lab-01", station: "core" });
  });

  it("never coerces an unknown host name to a known host", () => {
    const list = datadogAlarms(
      [
        monitor("lab-04 CPU high", "Alert"),
        monitor("lab-020 CPU high", "Alert"),
        monitor("CPU is high", "Alert", { tags: ["host:lab-04"] }),
      ],
      map,
    );
    expect(list).toHaveLength(3);
    for (const x of list) expect(x).toMatchObject({ at: "unlocated", station: null });
  });

  it("leaves a multi-host or ambiguous monitor unlocated", () => {
    const list = datadogAlarms(
      [
        monitor("CPU usage is high for host {{host.name}}", "Alert", { tags: ["integration:host"] }),
        monitor("lab-01 and lab-03 link down", "Alert"),
      ],
      map,
    );
    expect(list).toHaveLength(2);
    for (const a of list) expect(a).toMatchObject({ at: "unlocated", station: null, kind: "monitor" });
  });

  it("is unlocated when its workload does not resolve to a station", () => {
    const [a] = datadogAlarms([monitor("Something high", "Alert", { workload: "no-such-workload" })], map);
    expect(a).toMatchObject({ at: "unlocated", station: null });
  });

  it("keeps the monitor title and state in the alarm", () => {
    const [a] = datadogAlarms(
      [monitor("lab-03 Redis instance down", "Alert", { link: "https://app.datadoghq.eu/monitors/1" })],
      map,
    );
    expect(a.title).toBe("lab-03 Redis instance down");
    expect(a.message).toContain("Alert");
    expect(a.link).toBe("https://app.datadoghq.eu/monitors/1");
  });
});

describe("ARCH", () => {
  it("uses the Datadog host_name unchanged for hosts", () => {
    const fixtureLabHosts = snapshot.hosts
      .map((h) => h.properties.host_name as string)
      .filter((n) => n.startsWith("lab-"))
      .sort();
    expect([...HOST_IDS].sort()).toEqual(fixtureLabHosts);
    expect(Object.keys(ARCH.hosts).sort()).toEqual(fixtureLabHosts);
  });

  it("maps servers to stations and keeps the static request path", () => {
    expect(ARCH.hosts).toEqual({ "lab-01": "core", "lab-02": "core", "lab-03": "erp" });
    expect(ARCH.path).toEqual(["pos", "core", "conn", "erp"]);
  });

  it("has the four cables of the architecture", () => {
    expect(Object.values(ARCH.cables).map((c) => [c.id, c.from, c.to])).toEqual([
      ["c1", "pos", "core"],
      ["c2", "admin", "core"],
      ["c3", "core", "conn"],
      ["c4", "conn", "erp"],
    ]);
  });

  it("maps services to stations, with ERPNext having no service", () => {
    expect(ARCH.stations.pos.serviceId).toBe("pos");
    expect(ARCH.stations.admin.serviceId).toBe("admin-console");
    expect(ARCH.stations.conn.serviceId).toBe("erpnext-connector");
    expect(ARCH.stations.erp.serviceId).toBeNull();
    expect(stationForService("erpnext-connector")).toBe("conn");
    expect(stationForService("nope")).toBeNull();
  });

  it("has a role in both languages for every station", () => {
    for (const s of Object.values(ARCH.stations)) {
      expect(s.role.en).not.toBe("");
      expect(s.role.ar).not.toBe("");
    }
  });
});
