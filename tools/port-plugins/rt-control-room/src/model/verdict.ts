import type { Alarm, I18n, Light, SourceId, SourceView, StationView, Verdict } from "./types";

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

// ---- scopes (spec 7b): cashier = POS, backend = Backend-Core, accounts = Connector + Invoices cable (+ ERPNext host)

const inCashier = (a: Alarm) => a.station === "pos";
const inBackend = (a: Alarm) => a.station === "core";
const inAccounts = (a: Alarm) => a.station === "conn" || a.station === "erp" || a.at === "c4";

const checksText = (c: { ok: number; total: number }): I18n =>
  t(`${num(c.ok)} of ${num(c.total)} checks OK`, `${num(c.ok)} من ${num(c.total)} فحوصات تمام`);

/** "na" (not needed) never occurs for Backend-Core or the Connector; treat it as no check. */
const checksOf = (c: StationView["readings"]["checks"]): Checks => (c === "na" ? null : c);

const notFresh = (v: VerdictInput, ids: SourceId[]) => ids.some((id) => v.sources[id].state !== "fresh");

type Unknown = { why: "unplaced" | "none" | "checks-unread" | "partial" | "stale" | "not-read" };

/**
 * First reason a light that has no alarm cannot be neutral. Order matters: a
 * failed error read outranks everything, then alarms nobody could place.
 */
function unknownReason(
  v: VerdictInput,
  opts: { checks: Checks; needsChecks: boolean; sources: SourceId[]; unplaced: number },
): Unknown | null {
  if (!v.sentryRead) return { why: "not-read" };
  if (opts.unplaced > 0) return { why: "unplaced" };
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

// ---- the three lights and their sentence clauses ---------------------------

type Part = { light: Light; clause: I18n };

function cashierPart(v: VerdictInput, mine: Alarm[]): Part {
  if (mine.length > 0) {
    const e = errors(mine.length);
    return {
      light: { tone: "fault", text: t(`${e.en} reported`, `${e.ar} في التطبيق`) },
      clause: t(`the cashier app reports ${e.en}`, `تطبيق الكاشير فيه ${e.ar}`),
    };
  }
  const why = unknownReason(v, { checks: null, needsChecks: false, sources: ["sentry"], unplaced: 0 });
  if (why) {
    return {
      light: { tone: "unknown", text: unknownText(why, null, 0, true) },
      clause: t("the cashier app's state is not confirmed", "حالة تطبيق الكاشير مش مؤكدة"),
    };
  }
  return {
    light: { tone: "neutral", text: t("No errors reported", "مفيش أخطاء") },
    clause: t("the cashier app reports no errors", "تطبيق الكاشير مفيهوش أخطاء"),
  };
}

function backendPart(v: VerdictInput, mine: Alarm[], unplaced: number): Part {
  const checks = checksOf(v.checks.core);
  if (mine.length > 0) {
    if (mine.length === 1 && mine[0].kind === "latency") {
      const ex = mine[0].example === true;
      return {
        light: {
          tone: "fault",
          text: t(`Slow responses${ex ? " (example)" : ""}`, `ردود بطيئة${ex ? " (مثال)" : ""}`),
        },
        clause: t(`The backend is slow${ex ? " (example)" : ""}`, `الـ Backend بطيء${ex ? " (مثال)" : ""}`),
      };
    }
    const a = alarmsOf(mine.length);
    return {
      light: { tone: "fault", text: t(`${a.en} open`, `إنذارات شغالة: ${num(mine.length)}`) },
      clause: t(`The backend has ${a.en} open`, `الـ Backend عليه ${a.ar}`),
    };
  }
  const why = unknownReason(v, { checks, needsChecks: true, sources: ["sentry", "datadog"], unplaced });
  if (why) {
    return {
      light: { tone: "unknown", text: unknownText(why, checks, unplaced, false) },
      clause: t("The backend's state is not confirmed", "حالة الـ Backend مش مؤكدة"),
    };
  }
  const c = checks as { ok: number; total: number };
  return {
    light: { tone: "neutral", text: checksText(c) },
    clause: t(
      `The backend passes all ${num(c.total)} health checks`,
      `الـ Backend عدّى كل فحوصات الصحة (${num(c.total)})`,
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
  if (why) {
    return {
      light: { tone: "unknown", text: unknownText(why, checks, unplaced, false) },
      clause: t(
        "The accounts side could not be confirmed in the test lab.",
        "مقدرناش نتأكد من جانب الحسابات في بيئة التجربة.",
      ),
    };
  }
  return {
    light: { tone: "neutral", text: t("No faults", "مفيش أعطال") },
    clause: t("The accounts side reports no faults in the test lab.", "جانب الحسابات مفيهوش أعطال في بيئة التجربة."),
  };
}

function accountsFault(mine: Alarm[]): Part {
  const onCable = mine.filter((a) => a.at === "c4").length;
  const inside = mine.filter((a) => a.at !== "c4" && a.station === "conn").length;
  const onErp = mine.filter((a) => a.at !== "c4" && a.station === "erp").length;
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

/**
 * Three lights and one sentence (spec 7b). A light is a fault when its scope
 * has an open alarm, unknown when its health is not known or a source is
 * stale or unread, and neutral (never green) only when it is watched and quiet.
 * Alarms that cannot be placed keep Backend and Accounts at unknown at best.
 * A fault always outranks unknown, and a failed Sentry read never clears one.
 */
export function buildVerdict(input: VerdictInput): Verdict {
  const unplaced = input.alarms.filter((a) => a.at === "unlocated").length;
  const cashier = cashierPart(input, input.alarms.filter(inCashier));
  const backend = backendPart(input, input.alarms.filter(inBackend), unplaced);
  const accounts = accountsPart(input, input.alarms.filter(inAccounts), unplaced);

  let en = `${backend.clause.en} and ${cashier.clause.en}. ${accounts.clause.en}`;
  let ar = `${backend.clause.ar} و${cashier.clause.ar}. ${accounts.clause.ar}`;
  if (!input.sentryRead) {
    en += " The error tracker could not be read, so error counts are not known.";
    ar += " مقدرناش نقرا متتبع الأخطاء، فعدد الأخطاء مش معروف.";
  }
  if (unplaced > 0) {
    const a = alarmsOf(unplaced);
    en += ` ${a.en} could not be placed on the map.`;
    ar += unplaced === 1 ? " إنذار واحد مش قادرين نحدد مكانه على الخريطة." : ` ${a.ar} مش قادرين نحدد مكانهم على الخريطة.`;
  }

  return {
    lights: { cashier: cashier.light, backend: backend.light, accounts: accounts.light },
    sentence: { en, ar },
  };
}
