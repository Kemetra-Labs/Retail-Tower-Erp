import { describe, expect, it } from "vitest";
import { STRINGS } from "../../i18n/strings";
import { replayEvents } from "../events";
import { NOW, fixture } from "./testkit";

const ARABIC = /[؀-ۿ]/;
const LATIN_WORD = /[A-Za-z]{3,}/;
const HOUR = 3_600_000;

describe("Arabic event texts (RT-1408 D)", () => {
  it("translates the state words of Jira, CI and monitor events; names stay as they are", () => {
    const snap = fixture();
    const recent = new Date(NOW.getTime() - HOUR).toISOString();
    snap.jira = [{ ...snap.jira[0], identifier: "RT-9", updatedAt: recent, properties: { ...snap.jira[0].properties, status: "In Progress" } }];
    snap.runs = [{ ...snap.runs[0], title: "ci", createdAt: recent, properties: { conclusion: "timed_out", createdAt: recent } }];
    const monitor = snap.monitors.find((m) => m.properties?.overallState)!;
    snap.monitors = [{ ...monitor, title: "mon", updatedAt: recent, properties: { ...monitor.properties, overallState: "No Data" } }];
    snap.prs = [];
    snap.deployments = [];

    const events = replayEvents(snap, NOW);
    const text = (kind: string) => events.find((e) => e.kind === kind)!.text.ar;
    expect(text("jira")).toBe("RT-9 بقت قيد التنفيذ");
    expect(text("ci")).toBe("تشغيل CI انتهت مهلته: ci");
    expect(text("monitor")).toBe("المراقب mon: مفيش بيانات");
    for (const kind of ["jira", "ci", "monitor"]) {
      // Only identifiers and titles (RT-9, ci, mon) may stay Latin; no English state word is left.
      expect(text(kind).replace(/RT-9|\bCI\b|\bci\b|\bmon\b/g, "")).not.toMatch(LATIN_WORD);
    }
  });

  it("an unknown state keeps its raw word instead of vanishing", () => {
    const snap = fixture();
    const recent = new Date(NOW.getTime() - HOUR).toISOString();
    snap.jira = [{ ...snap.jira[0], identifier: "RT-9", updatedAt: recent, properties: { ...snap.jira[0].properties, status: "Waiting For Vendor" } }];
    snap.prs = [];
    snap.runs = [];
    snap.deployments = [];
    snap.monitors = [];
    expect(replayEvents(snap, NOW)[0].text.ar).toBe("RT-9 بقت Waiting For Vendor");
  });
});

describe("legend wording never claims health from absent evidence (RT-1408 D)", () => {
  it("the no-fault cable legend says no faults were reported, in both languages", () => {
    expect(STRINGS.lgLive.en).toBe("Cable, no faults reported");
    expect(STRINGS.lgLive.ar).toMatch(ARABIC);
    expect(STRINGS.lgLive.ar).not.toContain("سليم");
  });
});
