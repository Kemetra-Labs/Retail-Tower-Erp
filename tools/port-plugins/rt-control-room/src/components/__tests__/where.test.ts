import { describe, expect, it } from "vitest";
import type { Alarm, AlarmAt, AlarmKind, StationId } from "../../model/types";
import { alarmTitle, pathOf, whereOf } from "../where";

const alarm = (at: AlarmAt, station: StationId | null, kind: AlarmKind = "refused"): Alarm => ({
  id: `a-${at}`,
  kind,
  source: "Sentry",
  station,
  at,
  title: "t",
  message: "t",
  since: null,
  link: null,
});

describe("where an alarm is, by route owner", () => {
  it("c3: from the Connector to Backend-Core, Backend-Core failing", () => {
    const a = alarm("c3", "conn");
    expect(whereOf(a, "en")).toMatchObject({ kind: "cable", from: "Connector", to: "Backend-Core", carries: "postings" });
    expect(pathOf(a)).toEqual({ hops: ["conn", "core"], failing: "core" });
    expect(alarmTitle(a, "en")).toBe("Backend-Core refused the request");
    expect(alarmTitle({ ...a, kind: "down" }, "en")).toBe("Backend-Core is not answering");
    expect(alarmTitle({ ...a, kind: "timeout" }, "en")).toBe("The request to Backend-Core took too long");
    expect(alarmTitle({ ...a, kind: "down" }, "ar")).toBe("Backend-Core مش بيرد");
  });

  it("c1: POS to Backend-Core along the main path", () => {
    const a = alarm("c1", "pos", "down");
    expect(whereOf(a, "en")).toMatchObject({ from: "POS", to: "Backend-Core" });
    expect(pathOf(a)).toEqual({ hops: ["pos", "core"], failing: "core" });
  });

  it("c2: Admin Console to Backend-Core, off the main path", () => {
    const a = alarm("c2", "admin");
    expect(whereOf(a, "en")).toMatchObject({ from: "Admin Console", to: "Backend-Core", carries: "catalog, ops" });
    expect(pathOf(a)).toEqual({ hops: ["admin", "core"], failing: "core" });
  });

  it("c4: the Connector to ERPNext, ERPNext failing", () => {
    const a = alarm("c4", "conn");
    expect(whereOf(a, "en")).toMatchObject({ from: "Connector", to: "ERPNext", carries: "invoices" });
    expect(pathOf(a)).toEqual({ hops: ["pos", "core", "conn", "erp"], failing: "erp" });
    expect(alarmTitle(a, "en")).toBe("ERPNext refused the request");
  });

  it("inside a station the title blames no one", () => {
    const a = alarm("conn", "conn", "refused");
    expect(alarmTitle(a, "en")).toBe("The request was refused");
    expect(alarmTitle({ ...a, kind: "down" }, "en")).toBe("The server is not answering");
    expect(alarmTitle({ ...a, kind: "reset" }, "en")).toBe("The connection was cut");
  });
});
