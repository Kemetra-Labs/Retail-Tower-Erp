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
    posSentry: "sending",
    connSentry: "linked",
    coreHosts: [
      { id: "lab-01", up: true },
      { id: "lab-02", up: true },
    ],
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

  it("Connector alarms on the Postings cable c3 fail at Backend-Core: the backend light is a fault, accounts is not", () => {
    const c3 = () => alarm("c3", "conn", { kind: "refused" });
    const v = buildVerdict(input({ alarms: [c3(), c3(), c3()], checks: { core: { ok: 7, total: 7 }, conn: { ok: 2, total: 2 } } }));
    expect(v.lights.backend.tone).toBe("fault");
    expect(v.lights.backend.text.en).toBe("3 alarms open");
    expect(v.lights.accounts.tone).toBe("neutral");
  });

  it("POS and Admin alarms on c1 and c2 fail at Backend-Core too", () => {
    const v = buildVerdict(input({ alarms: [alarm("c2", "admin", { kind: "down" })] }));
    expect(v.lights.backend.tone).toBe("fault");
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

describe("buildVerdict honesty (never claims health from absence of evidence)", () => {
  it("the cashier light is neutral only when POS's Sentry lamp is sending", () => {
    for (const state of ["linked", "none", "na", "live", "alert"] as const) {
      const v = buildVerdict(input({ posSentry: state }));
      expect(v.lights.cashier.tone, state).toBe("unknown");
      expect(v.lights.cashier.text).toEqual({
        en: "Not sure: no sign the cashier app reports errors",
        ar: "مش متأكد: مفيش علامة إن تطبيق الكاشير بيبلّغ عن أخطاء",
      });
    }
    expect(buildVerdict(input({ posSentry: "sending" })).lights.cashier.tone).toBe("neutral");
  });

  it("the backend light is amber when a Backend-Core server's up-state is unknown", () => {
    const v = buildVerdict(input({ coreHosts: [{ id: "lab-01", up: true }, { id: "lab-02", up: null }] }));
    expect(v.lights.backend.tone).toBe("unknown");
    expect(v.lights.backend.text.en).toBe("Not sure: server lab-02 state unknown");
    expect(v.lights.backend.text.ar).toMatch(ARABIC);
  });

  it("the backend light is red when a Backend-Core server is down", () => {
    const v = buildVerdict(input({ coreHosts: [{ id: "lab-01", up: false }, { id: "lab-02", up: true }] }));
    expect(v.lights.backend.tone).toBe("fault");
    expect(v.lights.backend.text.en).toBe("Server lab-01 is down");
    expect(v.sentence.en.startsWith("Server lab-01 of the backend is down.")).toBe(true);
  });

  it("the backend light is never neutral while an alarm fails at Backend-Core", () => {
    const v = buildVerdict(input({ alarms: [alarm("c3", "conn", { kind: "down" })] }));
    expect(v.lights.backend.tone).toBe("fault");
  });

  it("the sentence puts faults first, then unknowns, then the neutral clauses", () => {
    const v = buildVerdict(
      input({
        alarms: [alarm("conn", "conn", { kind: "reset" })],
        posSentry: "linked",
        checks: { core: { ok: 7, total: 7 }, conn: { ok: 2, total: 2 } },
      }),
    );
    expect(v.lights.accounts.tone).toBe("fault");
    expect(v.lights.cashier.tone).toBe("unknown");
    expect(v.lights.backend.tone).toBe("neutral");
    const en = v.sentence.en;
    const fault = en.indexOf("The accounts side has");
    const unknown = en.indexOf("The cashier app's state is not confirmed.");
    const neutral = en.indexOf("The backend: no errors reported");
    expect(fault).toBe(0);
    expect(unknown).toBeGreaterThan(fault);
    expect(neutral).toBeGreaterThan(unknown);
    expect(v.sentence.ar.indexOf("جانب الحسابات")).toBe(0);
  });

  it("puts the not-read and unplaced notes with the unknowns, before any neutral clause", () => {
    const v = buildVerdict(input({ alarms: [alarm("unlocated", null)], checks: { core: { ok: 7, total: 7 }, conn: { ok: 1, total: 1 } } }));
    const en = v.sentence.en;
    expect(en.indexOf("could not be placed on the map")).toBeLessThan(en.indexOf("The cashier app: no errors reported."));
  });

  it("never says 'passes all' or 'reports no' in any state", () => {
    const states: Partial<VerdictInput>[] = [
      { checks: { core: { ok: 7, total: 7 }, conn: { ok: 2, total: 2 } } },
      {},
      { sentryRead: false },
      { posSentry: "linked" },
    ];
    for (const s of states) {
      const v = buildVerdict(input(s));
      for (const t of allTexts(v)) expect(t.en).not.toMatch(/passes all|reports no/i);
      expect(v.sentence.ar).not.toContain("عدّى كل");
    }
  });

  it("a fully quiet board reads 'no errors reported' clause by clause", () => {
    const v = buildVerdict(input({ checks: { core: { ok: 7, total: 7 }, conn: { ok: 2, total: 2 } } }));
    expect(v.sentence.en).toBe(
      "The backend: no errors reported, 7 of 7 health checks OK. The cashier app: no errors reported. The accounts side: no errors reported in the test lab.",
    );
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

describe("RT-1408 D: quiet is not evidence without a tracker, a down server is never hidden", () => {
  const conn = { core: { ok: 7, total: 7 }, conn: { ok: 2, total: 2 } } as const;

  it("Accounts reads unknown, not neutral, when the Connector has no error tracker project", () => {
    const none = buildVerdict(input({ checks: conn, connSentry: "none" }));
    expect(none.lights.accounts.tone).toBe("unknown");
    expect(none.lights.accounts.text.en).toBe("Not sure: no error tracker project on the bridge");
    expect(none.lights.accounts.text.ar).toMatch(ARABIC);
    // A linked or sending project is evidence: quiet is neutral.
    for (const state of ["linked", "sending"] as const) {
      expect(buildVerdict(input({ checks: conn, connSentry: state })).lights.accounts.tone).toBe("neutral");
    }
    // A fault is still a fault with no project.
    expect(buildVerdict(input({ checks: conn, connSentry: "none", alarms: [c4()] })).lights.accounts.tone).toBe("fault");
  });

  it("a down server is named in the light and the sentence even when alarms are open", () => {
    const hosts = [
      { id: "lab-01" as const, up: true },
      { id: "lab-02" as const, up: false },
    ];
    const v = buildVerdict(input({ alarms: [alarm("c3", "conn"), alarm("c3", "conn")], coreHosts: hosts }));
    expect(v.lights.backend.tone).toBe("fault");
    expect(v.lights.backend.text.en).toBe("2 alarms open, lab-02 down");
    expect(v.sentence.en).toContain("The backend has 2 alarms open. Server lab-02 is also down.");
    expect(v.lights.backend.text.ar).toContain("lab-02");
    expect(v.sentence.ar).toContain("lab-02");
    // A lone latency alarm no longer hides the down server behind "Slow responses".
    const slow = buildVerdict(input({ alarms: [alarm("core", "core", { kind: "latency", source: "Datadog" })], coreHosts: hosts }));
    expect(slow.lights.backend.text.en).toBe("1 alarm open, lab-02 down");
  });
});
