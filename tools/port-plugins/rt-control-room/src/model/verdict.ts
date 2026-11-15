import { failingHopOf } from "./architecture";
import type { Alarm, HostId, I18n, Light, LinkState, SourceId, SourceView, StationView, Verdict } from "./types";

/**
 * What the verdict needs. Station checks come from `StationView.readings.checks`
 * so the lights and the board never disagree about how many checks pass.
 */
export type VerdictInput = {
  alarms: Alarm[];
  checks: {
    core: StationView["readings"]["checks"];
    conn: StationView["readings"]["checks"];
  };
  sources: Record<SourceId, SourceView>;
  /** False when the Sentry issue read never succeeded or the latest one failed. */
  sentryRead: boolean;
  /** False while the Datadog monitors were never read: a missing check then reads "not read", not "no health check". Default true. */
  monitorsRead?: boolean;
  /** POS's Sentry lamp: only "sending" is evidence that the cashier app reports errors at all. */
  posSentry: LinkState;
  /** The Connector's Sentry lamp: "none" means no error tracker project is linked to it, so a quiet tracker proves nothing. */
  connSentry: LinkState;
  /** The servers Backend-Core runs on, with Datadog's up-state (`null` = not known). */
  coreHosts: { id: HostId; up: boolean | null }[];
};

type Checks = { ok: number; total: number } | null;

const num = (n: number): string => String(n);
const t = (en: string, ar: string): I18n => ({ en, ar });

// ---- counts: English plural, Arabic one / two / few (3-10) / many ----------

function count(n: number, en: [string, string], ar: [string, string, string, string]): I18n {
  const arabic = n === 1 ? ar[0] : n === 2 ? ar[1] : n <= 10 ? `${num(n)} ${ar[2]}` : `${num(n)} ${ar[3]}`;
  return t(`${num(n)} ${n === 1 ? en[0] : en[1]}`, arabic);
}
const faults = (n: number) => count(n, ["fault", "faults"], ["عطل واحد", "عطلين", "أعطال", "عطل"]);
const errors = (n: number) => count(n, ["error", "errors"], ["خطأ واحد", "خطأين", "أخطاء", "خطأ"]);
const alarmsOf = (n: number) => count(n, ["alarm", "alarms"], ["إنذار واحد", "إنذارين", "إنذارات", "إنذار"]);

// ---- scopes (spec 7b, placed by route owner): cashier = what the POS app reports;
// backend = every alarm whose failing hop is Backend-Core (inside it, on its servers, or on
// a cable whose route it owns: c1, c2 and c3); accounts = failing hop Connector or ERPNext
// (inside the bridge, the Invoices cable c4, the ERPNext server). An alarm the Connector
// reports about a Backend-Core route is Backend's, not the accounts side's.

const inCashier = (a: Alarm) => a.station === "pos";
const inBackend = (a: Alarm) => failingHopOf(a.at) === "core";
const inAccounts = (a: Alarm) => {
  const hop = failingHopOf(a.at);
  return hop === "conn" || hop === "erp";
};

const checksText = (c: { ok: number; total: number }): I18n =>
  t(`${num(c.ok)} of ${num(c.total)} checks OK`, `${num(c.ok)} من ${num(c.total)} فحوصات تمام`);

/** "na" (not needed) never occurs for Backend-Core or the Connector; treat it as no check. */
const checksOf = (c: StationView["readings"]["checks"]): Checks => (c === "na" ? null : c);

const notFresh = (v: VerdictInput, ids: SourceId[]) => ids.some((id) => v.sources[id].state !== "fresh");

type Unknown = {
  why: "unplaced" | "none" | "checks-unread" | "partial" | "stale" | "not-read" | "no-signal" | "host-unknown" | "unwatched";
  host?: HostId;
};

/**
 * First reason a light that has no fault cannot be neutral. Order matters: a
 * failed error read outranks everything, then alarms nobody could place.
 */
function unknownReason(
  v: VerdictInput,
  opts: { checks: Checks; needsChecks: boolean; sources: SourceId[]; unplaced: number; hosts?: VerdictInput["coreHosts"] },
): Unknown | null {
  if (!v.sentryRead) return { why: "not-read" };
  if (opts.unplaced > 0) return { why: "unplaced" };
  const unknownHost = opts.hosts?.find((h) => h.up === null);
  if (unknownHost) return { why: "host-unknown", host: unknownHost.id };
  if (opts.needsChecks && opts.checks === null) return { why: v.monitorsRead === false ? "checks-unread" : "none" };
  if (opts.needsChecks && opts.checks && opts.checks.ok < opts.checks.total) return { why: "partial" };
  if (notFresh(v, opts.sources)) return { why: "stale" };
  return null;
}

function unknownText(reason: Unknown, checks: Checks, unplaced: number, cashier: boolean): I18n {
  switch (reason.why) {
    case "not-read": {
      if (cashier) return t("Error tracker not read", "متتبع الأخطاء مش مقروء");
      if (checks) {
        const c = checksText(checks);
        return t(`Errors not read, ${c.en}`, `الأخطاء مش مقروءة، ${c.ar}`);
      }
      return t("Errors not read", "الأخطاء مش مقروءة");
    }
    case "unplaced": {
      const a = alarmsOf(unplaced);
      return t(`Not sure: ${a.en} not placed`, unplaced === 1 ? "مش متأكد: إنذار واحد مش متحدد" : `مش متأكد: ${a.ar} مش متحدد`);
    }
    case "no-signal":
      return t("Not sure: no sign the cashier app reports errors", "مش متأكد: مفيش علامة إن تطبيق الكاشير بيبلّغ عن أخطاء");
    case "unwatched":
      return t("Not sure: no error tracker project on the bridge", "مش متأكد: مفيش مشروع لتتبع الأخطاء على الجسر");
    case "host-unknown":
      return t(`Not sure: server ${reason.host} state unknown`, `مش متأكد: حالة السيرفر ${reason.host} مش معروفة`);
    case "none":
      return t("Not sure: no health check", "مجهول: مفيش فحص صحة");
    case "checks-unread":
      return t("Not sure: health checks not read", "مجهول: فحوصات الصحة مش مقروءة");
    case "partial":
      return checksText(checks as { ok: number; total: number });
    case "stale":
      return cashier
        ? t("Error data may be out of date", "بيانات الأخطاء ممكن تكون قديمة")
        : t("Data may be out of date", "البيانات ممكن تكون قديمة");
  }
}

// ---- the three lights and their sentence clauses (each clause a full sentence) ----

type Part = { light: Light; clause: I18n };

function cashierPart(v: VerdictInput, mine: Alarm[]): Part {
  if (mine.length > 0) {
    const e = errors(mine.length);
    return {
      light: { tone: "fault", text: t(`${e.en} reported`, `${e.ar} في التطبيق`) },
      clause: t(`The cashier app reports ${e.en}.`, `تطبيق الكاشير فيه ${e.ar}.`),
    };
  }
  let why = unknownReason(v, { checks: null, needsChecks: false, sources: ["sentry"], unplaced: 0 });
  // Neutral needs evidence the app reports errors at all: its Sentry lamp is sending.
  if (!why && v.posSentry !== "sending") why = { why: "no-signal" };
  if (why) {
    return {
      light: { tone: "unknown", text: unknownText(why, null, 0, true) },
      clause: t("The cashier app's state is not confirmed.", "حالة تطبيق الكاشير مش مؤكدة."),
    };
  }
  return {
    light: { tone: "neutral", text: t("No errors reported", "مفيش أخطاء متبلّغ عنها") },
    clause: t("The cashier app: no errors reported.", "تطبيق الكاشير: مفيش أخطاء متبلّغ عنها."),
  };
}

function backendFault(mine: Alarm[], down: VerdictInput["coreHosts"]): Part {
  if (mine.length === 0) {
    const ids = down.map((h) => h.id).join(", ");
    return {
      light: { tone: "fault", text: t(`Server ${ids} is down`, `السيرفر ${ids} واقع`) },
      clause: t(`Server ${ids} of the backend is down.`, `السيرفر ${ids} بتاع الـ Backend واقع.`),
    };
  }
  if (mine.length === 1 && mine[0].kind === "latency" && down.length === 0) {
    const ex = mine[0].example === true;
    return {
      light: { tone: "fault", text: t(`Slow responses${ex ? " (example)" : ""}`, `ردود بطيئة${ex ? " (مثال)" : ""}`) },
      clause: t(`The backend is slow${ex ? " (example)" : ""}.`, `الـ Backend بطيء${ex ? " (مثال)" : ""}.`),
    };
  }
  const a = alarmsOf(mine.length);
  const ids = down.map((h) => h.id).join(", ");
  // A server that is down is not hidden behind the alarm count (RT-1408 D).
  const alsoEn = down.length > 0 ? ` Server ${ids} is also down.` : "";
  const alsoAr = down.length > 0 ? ` والسيرفر ${ids} واقع كمان.` : "";
  return {
    light: {
      tone: "fault",
      text: t(`${a.en} open${down.length > 0 ? `, ${ids} down` : ""}`, `إنذارات شغالة: ${num(mine.length)}${down.length > 0 ? `، ${ids} واقع` : ""}`),
    },
    clause: t(`The backend has ${a.en} open.${alsoEn}`, `الـ Backend عليه ${a.ar}.${alsoAr}`),
  };
}

function backendPart(v: VerdictInput, mine: Alarm[], unplaced: number): Part {
  const checks = checksOf(v.checks.core);
  const down = v.coreHosts.filter((h) => h.up === false);
  if (mine.length > 0 || down.length > 0) return backendFault(mine, down);
  const why = unknownReason(v, { checks, needsChecks: true, sources: ["sentry", "datadog"], unplaced, hosts: v.coreHosts });
  if (why) {
    return {
      light: { tone: "unknown", text: unknownText(why, checks, unplaced, false) },
      clause: t("The backend's state is not confirmed.", "حالة الـ Backend مش مؤكدة."),
    };
  }
  const c = checks as { ok: number; total: number };
  return {
    light: { tone: "neutral", text: checksText(c) },
    clause: t(
      `The backend: no errors reported, ${num(c.ok)} of ${num(c.total)} health checks OK.`,
      `الـ Backend: مفيش أخطاء متبلّغ عنها، ${num(c.ok)} من ${num(c.total)} فحوصات صحة تمام.`,
    ),
  };
}

function accountsPart(v: VerdictInput, mine: Alarm[], unplaced: number): Part {
  const checks = checksOf(v.checks.conn);
  if (mine.length > 0) return accountsFault(mine);
  const why = unknownReason(v, {
    checks,
    needsChecks: true,
    sources: checks ? ["sentry", "datadog"] : ["sentry"],
    unplaced,
  });
  // Quiet is only evidence when the Connector has an error tracker project at all (the cashier's rule).
  const unwatched: Unknown | null = !why && v.connSentry === "none" ? { why: "unwatched" } : null;
  const reason = why ?? unwatched;
  if (reason) {
    return {
      light: { tone: "unknown", text: unknownText(reason, checks, unplaced, false) },
      clause: t(
        "The accounts side could not be confirmed in the test lab.",
        "مقدرناش نتأكد من جانب الحسابات في بيئة التجربة.",
      ),
    };
  }
  return {
    light: { tone: "neutral", text: t("No errors reported", "مفيش أخطاء متبلّغ عنها") },
    clause: t("The accounts side: no errors reported in the test lab.", "جانب الحسابات: مفيش أخطاء متبلّغ عنها في بيئة التجربة."),
  };
}

function accountsFault(mine: Alarm[]): Part {
  const onCable = mine.filter((a) => a.at === "c4").length;
  const inside = mine.filter((a) => a.at !== "c4" && failingHopOf(a.at) === "conn").length;
  const onErp = mine.filter((a) => a.at !== "c4" && failingHopOf(a.at) === "erp").length;
  if (onCable === 0) {
    const a = alarmsOf(mine.length);
    return {
      light: { tone: "fault", text: t(`${a.en} open`, `إنذارات شغالة: ${num(mine.length)}`) },
      clause: t(`The accounts side has ${a.en} open in the test lab.`, `جانب الحسابات عليه ${a.ar} في بيئة التجربة.`),
    };
  }
  const f = faults(onCable);
  const extraEn = [inside > 0 ? `${num(inside)} inside the bridge` : "", onErp > 0 ? `${num(onErp)} on ERPNext` : ""];
  const extraAr = [inside > 0 ? `${num(inside)} جوه الجسر` : "", onErp > 0 ? `${num(onErp)} في ERPNext` : ""];
  const joinEn = [`${f.en} on the invoice cable`, ...extraEn].filter(Boolean).join(", ");
  const joinAr = [`${f.ar} على كابل الفواتير`, ...extraAr].filter(Boolean).join("، ");
  const rest = inside + onErp;
  const more = alarmsOf(rest);
  return {
    light: { tone: "fault", text: t(joinEn, joinAr) },
    clause: t(
      `The invoice cable from the bridge to ERPNext has ${f.en} in the test lab.${rest > 0 ? ` Also ${more.en} inside the bridge or ERPNext.` : ""}`,
      `كابل الفواتير من الجسر لـ ERPNext عليه ${f.ar} في بيئة التجربة.${rest > 0 ? ` وفيه كمان ${more.ar} جوه الجسر أو ERPNext.` : ""}`,
    ),
  };
}

/** Notes that make the board less certain: they read with the unknowns. */
function notes(input: VerdictInput, unplaced: number): I18n[] {
  const out: I18n[] = [];
  if (!input.sentryRead) {
    out.push(t("The error tracker could not be read, so error counts are not known.", "مقدرناش نقرا متتبع الأخطاء، فعدد الأخطاء مش معروف."));
  }
  if (unplaced > 0) {
    const a = alarmsOf(unplaced);
    out.push(
      t(
        `${a.en} could not be placed on the map.`,
        unplaced === 1 ? "إنذار واحد مش قادرين نحدد مكانه على الخريطة." : `${a.ar} مش قادرين نحدد مكانهم على الخريطة.`,
      ),
    );
  }
  return out;
}

const RANK: Record<Light["tone"], number> = { fault: 0, unknown: 1, neutral: 2 };

/**
 * Three lights and one sentence (spec 7b). A light is a fault when its scope
 * has an open alarm (or, for Backend, a server is down), unknown when its
 * health is not known (no check, a server of unknown state, no sign the app
 * reports errors, a stale or unread source), and neutral (never green, no
 * check mark) only when it is watched and quiet. The sentence names faults
 * first, then unknowns, then the neutral clauses, and never claims health from
 * absence of evidence: it says "no errors reported", never "passes all".
 */
export function buildVerdict(input: VerdictInput): Verdict {
  const unplaced = input.alarms.filter((a) => a.at === "unlocated").length;
  const cashier = cashierPart(input, input.alarms.filter(inCashier));
  const backend = backendPart(input, input.alarms.filter(inBackend), unplaced);
  const accounts = accountsPart(input, input.alarms.filter(inAccounts), unplaced);

  // Stable sort keeps backend, cashier, accounts within a tone.
  const ordered = [backend, cashier, accounts]
    .map((p) => ({ rank: RANK[p.light.tone], clause: p.clause }))
    .concat(notes(input, unplaced).map((clause) => ({ rank: RANK.unknown, clause })))
    .sort((a, b) => a.rank - b.rank)
    .map((p) => p.clause);

  return {
    lights: { cashier: cashier.light, backend: backend.light, accounts: accounts.light },
    sentence: { en: ordered.map((c) => c.en).join(" "), ar: ordered.map((c) => c.ar).join(" ") },
  };
}
