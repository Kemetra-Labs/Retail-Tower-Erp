import { describe, expect, it } from "vitest";
import { buildVerdict, type VerdictInput } from "../verdict";
import type { Alarm, AlarmAt, SourceId, SourceView, StationId } from "../types";

const ARABIC = /[؀-ۿ]/;

let seq = 0;
function alarm(at: AlarmAt, station: StationId | null, over: Partial<Alarm> = {}): Alarm {
  seq += 1;
  return {
    id: `a-${seq}`,
    kind: "bug",
    source: "Sentry",
    station,
    at,
    title: "t",
    message: "t",
    since: null,
    link: null,
    ...over,
  };
}

function fresh(id: SourceId): SourceView {
  return { id, state: "fresh", lastChange: "2026-11-13T11:00:00Z", lastSync: "2026-11-13T11:00:00Z" };
}

function input(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    alarms: [],
    checks: { core: { ok: 7, total: 7 }, conn: null },
    sources: { sentry: fresh("sentry"), datadog: fresh("datadog"), github: fresh("github"), jira: fresh("jira") },
    sentryRead: true,
    ...over,
  };
}

const c4 = () => alarm("c4", "conn");
const allTexts = (v: ReturnType<typeof buildVerdict>) => [
  v.lights.cashier.text,
  v.lights.backend.text,
  v.lights.accounts.text,
  v.sentence,
];

describe("buildVerdict lights", () => {
  it("no alarm and a watched backend is neutral, never a green word", () => {
    const v = buildVerdict(input({ checks: { core: { ok: 7, total: 7 }, conn: { ok: 2, total: 2 } } }));
    expect(v.lights.backend).toEqual({
      tone: "neutral",
      text: { en: "7 of 7 checks OK", ar: "7 من 7 فحوصات تمام" },
    });
    expect(v.lights.cashier.tone).toBe("neutral");
    expect(v.lights.cashier.text.en).toBe("No errors reported");
    expect(v.lights.accounts.tone).toBe("neutral");
    for (const t of allTexts(v)) expect(t.en).not.toMatch(/healthy/i);
  });

  it("Connector with no health check and no alarm is unknown, never neutral", () => {
    const v = buildVerdict(input());
    expect(v.lights.accounts.tone).toBe("unknown");
    expect(v.lights.accounts.text.en).toBe("Not sure: no health check");
  });

  it("backend without checks is unknown, never neutral", () => {
    const v = buildVerdict(input({ checks: { core: null, conn: null } }));
    expect(v.lights.backend.tone).toBe("unknown");
  });

  it("some checks not OK and no alarm is unknown with the real counts", () => {
    const v = buildVerdict(input({ checks: { core: { ok: 5, total: 7 }, conn: null } }));
    expect(v.lights.backend.tone).toBe("unknown");
    expect(v.lights.backend.text.en).toBe("5 of 7 checks OK");
  });

  it("3 on the invoice cable and 1 inside the bridge: accounts is a fault that names both", () => {
    const alarms = [c4(), c4(), c4(), alarm("conn", "conn", { kind: "reset" }), alarm("admin", "admin")];
    const v = buildVerdict(input({ alarms }));
    expect(v.lights.accounts.tone).toBe("fault");
    expect(v.lights.accounts.text.en).toBe("3 faults on the invoice cable, 1 inside the bridge");
    expect(v.lights.accounts.text.ar).toMatch(ARABIC);
    expect(v.sentence.en).toContain("3 faults");
    expect(v.sentence.en).not.toContain("4 faults");
    // The Admin Console alarm is not in any of the three lights' scope.
    expect(v.lights.cashier.tone).toBe("neutral");
  });

  it("faults only on the cable say so without a remainder", () => {
    const v = buildVerdict(input({ alarms: [c4()] }));
    expect(v.lights.accounts.text.en).toBe("1 fault on the invoice cable");
  });

  it("an alarm on a POS makes the cashier light a fault", () => {
    const v = buildVerdict(input({ alarms: [alarm("pos", "pos"), alarm("pos", "pos")] }));
    expect(v.lights.cashier).toMatchObject({ tone: "fault" });
    expect(v.lights.cashier.text.en).toBe("2 errors reported");
  });

  it("a Datadog host alarm on the ERPNext host reaches the accounts light", () => {
    const v = buildVerdict(input({ alarms: [alarm("lab-03", "erp", { source: "Datadog", kind: "monitor" })] }));
    expect(v.lights.accounts.tone).toBe("fault");
  });

  it("the example latency alarm makes the backend a fault reading Slow responses (example)", () => {
    const demo = alarm("core", "core", { source: "Datadog", kind: "latency", example: true });
    const v = buildVerdict(input({ alarms: [demo] }));
    expect(v.lights.backend.tone).toBe("fault");
    expect(v.lights.backend.text).toEqual({ en: "Slow responses (example)", ar: "ردود بطيئة (مثال)" });
  });

  it("a stale source keeps its lights from being neutral", () => {
    const sources = { ...input().sources, sentry: { ...fresh("sentry"), state: "stale" as const } };
    const v = buildVerdict(input({ sources, checks: { core: { ok: 7, total: 7 }, conn: { ok: 1, total: 1 } } }));
    expect(v.lights.cashier.tone).toBe("unknown");
    expect(v.lights.backend.tone).toBe("unknown");
    expect(v.lights.cashier.text.en).not.toMatch(/No errors reported/);
  });

  it("an unknown datadog source only affects the backend", () => {
    const sources = { ...input().sources, datadog: { ...fresh("datadog"), state: "unknown" as const } };
    const v = buildVerdict(input({ sources }));
    expect(v.lights.cashier.tone).toBe("neutral");
    expect(v.lights.backend.tone).toBe("unknown");
  });
});

describe("buildVerdict unlocated alarms", () => {
  const unlocated = () => alarm("unlocated", null, { source: "Datadog", kind: "monitor" });

  it("keeps backend and accounts no better than unknown and adds the clause in both languages", () => {
    const v = buildVerdict(
      input({ alarms: [unlocated()], checks: { core: { ok: 7, total: 7 }, conn: { ok: 2, total: 2 } } }),
    );
    expect(v.lights.backend.tone).toBe("unknown");
    expect(v.lights.backend.text).toEqual({
      en: "Not sure: 1 alarm not placed",
      ar: "مش متأكد: إنذار واحد مش متحدد",
    });
    expect(v.lights.accounts.tone).toBe("unknown");
    expect(v.lights.cashier.tone).toBe("neutral");
    expect(v.sentence.en).toContain("1 alarm could not be placed on the map.");
    expect(v.sentence.ar).toMatch(ARABIC);
    expect(v.sentence.ar).toContain("إنذار واحد");
  });

  it("uses the plural for several", () => {
    const v = buildVerdict(input({ alarms: [unlocated(), unlocated(), unlocated()] }));
    expect(v.sentence.en).toContain("3 alarms could not be placed on the map.");
    expect(v.lights.backend.text.en).toBe("Not sure: 3 alarms not placed");
  });

  it("never downgrades a fault to unknown", () => {
    const v = buildVerdict(input({ alarms: [unlocated(), c4()] }));
    expect(v.lights.accounts.tone).toBe("fault");
  });
});

describe("buildVerdict when the Sentry read failed", () => {
  it("no light says No errors reported and the sentence says the tracker could not be read", () => {
    const v = buildVerdict(
      input({ sentryRead: false, checks: { core: { ok: 7, total: 7 }, conn: { ok: 1, total: 1 } } }),
    );
    expect(v.lights.cashier.tone).toBe("unknown");
    expect(v.lights.backend.tone).toBe("unknown");
    expect(v.lights.accounts.tone).toBe("unknown");
    for (const t of allTexts(v)) {
      expect(t.en).not.toMatch(/no errors|no faults/i);
      expect(t.ar).not.toContain("مفيش أخطاء");
      expect(t.ar).not.toContain("مفيش أعطال");
    }
    expect(v.sentence.en).toContain("The error tracker could not be read");
    expect(v.sentence.ar).toMatch(ARABIC);
    expect(v.lights.backend.text.en).toBe("Errors not read, 7 of 7 checks OK");
  });

  it("alarms already known still count: a failed read never clears them", () => {
    const v = buildVerdict(input({ sentryRead: false, alarms: [c4(), c4(), c4(), alarm("pos", "pos")] }));
    expect(v.lights.accounts.tone).toBe("fault");
    expect(v.lights.cashier.tone).toBe("fault");
    expect(v.sentence.en).toContain("The error tracker could not be read");
  });
});

describe("buildVerdict language", () => {
  it("every text has Arabic, in every state", () => {
    const states: Partial<VerdictInput>[] = [
      {},
      { sentryRead: false },
      { alarms: [c4(), alarm("conn", "conn"), alarm("pos", "pos"), alarm("core", "core", { kind: "latency" })] },
      { alarms: [alarm("unlocated", null)] },
      { checks: { core: null, conn: { ok: 1, total: 1 } } },
      { checks: { core: { ok: 2, total: 4 }, conn: null } },
      { sources: { ...input().sources, sentry: { ...fresh("sentry"), state: "stale" } } },
      { alarms: Array.from({ length: 12 }, () => c4()) },
    ];
    for (const s of states) {
      for (const t of allTexts(buildVerdict(input(s)))) {
        expect(t.en.length).toBeGreaterThan(0);
        expect(t.ar).toMatch(ARABIC);
        expect(t.ar).not.toMatch(/undefined|NaN/);
      }
    }
  });

  it("counts use Latin digits", () => {
    const v = buildVerdict(input({ alarms: [c4(), c4(), c4()] }));
    expect(v.lights.accounts.text.ar).toContain("3");
    expect(v.lights.accounts.text.ar).not.toMatch(/[٠-٩]/);
  });
});
