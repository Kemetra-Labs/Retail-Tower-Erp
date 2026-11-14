// Every fixed string of the board, in English and Arabic. Copy is taken from the
// approved mockup (docs/superpowers/specs/2026-11-13-rt-control-room-mockup.html,
// its `T.en` and `T.ar`), with fixed figures turned into {n} placeholders.
// Strings that the model already produces as `{ en, ar }` (verdict, cable and
// station names) and the change-event texts are not repeated here.

import { MODE_STRINGS } from "./modeStrings";
import { PANEL_STRINGS } from "./panelStrings";
import { ROOM_STRINGS } from "./roomStrings";

export type Lang = "en" | "ar";
type Entry = { readonly en: string; readonly ar: string };

export const STRINGS = {
  // ---- header --------------------------------------------------------------
  wordmark: { en: "Retail Tower", ar: "Retail Tower" },
  scope: { en: "Test lab, not real stores", ar: "بيئة تجربة، مش محلات حقيقية" },
  asof: { en: "As of last sync, {time}", ar: "حسب آخر مزامنة، {time}" },
  alarmsNone: { en: "No alarms", ar: "مفيش إنذارات" },
  alarmsActive: { en: "{n} active alarms", ar: "{n} إنذارات شغالة" },
  alarmsActiveOne: { en: "1 active alarm", ar: "إنذار واحد شغال" },
  exampleOne: { en: "(one is an example)", ar: "(منهم مثال)" },
  exampleTwo: { en: "(2 are examples)", ar: "(منهم مثالين)" },
  errorsNotRead: { en: "Error tracker not read", ar: "متتبع الأخطاء مش مقروء" },
  lastUp: { en: "Lab updated {ago}", ar: "المعمل اتحدث {ago}" },
  labUpdatedNone: { en: "Lab updated: no data", ar: "المعمل اتحدث: مفيش بيانات" },
  replay: { en: "Replaying recent changes (partial)", ar: "إعادة عرض آخر التغييرات (جزئي)" },
  langSwitch: { en: "عربي", ar: "English" },
  light: { en: "Light", ar: "فاتح" },
  dark: { en: "Dark", ar: "غامق" },
  pause: { en: "Pause motion", ar: "وقّف الحركة" },
  resume: { en: "Resume motion", ar: "شغّل الحركة" },
  demo: { en: "Example: a Datadog alarm", ar: "مثال: إنذار من Datadog" },
  demoOn: { en: "Hide the example", ar: "اخفي المثال" },
  demoU: { en: "Example: an alarm Port cannot place", ar: "مثال: إنذار Port مش قادر يحدد مكانه" },
  demoUOn: { en: "Hide the unplaced example", ar: "اخفي المثال غير المتحدد" },

  // ---- states (spec section 10) --------------------------------------------
  stateLoading: { en: "Loading", ar: "بيحمّل" },
  stateLoadingNote: { en: "Reading Port.", ar: "بيقرا من Port." },
  stateStale: { en: "Stale", ar: "قديم" },
  stateStaleSince: { en: "Stale, last sync {time}", ar: "قديم، آخر مزامنة {time}" },
  stateStaleNote: {
    en: "Showing the last good snapshot, with its time on every panel.",
    ar: "بنعرض آخر لقطة سليمة، ووقتها على كل لوحة.",
  },
  stateError: { en: "Error", ar: "خطأ" },
  stateErrorNote: { en: "Cannot read Port.", ar: "مش قادر يقرا من Port." },
  alarmsMayBeMissing: { en: "Alarms may be missing.", ar: "إنذارات ممكن تكون ناقصة." },
  staleOldData: { en: "Older data in: {list}.", ar: "بيانات أقدم في: {list}." },
  tlNotRead: { en: "Not read yet.", ar: "لسه متقراش." },
  noData: { en: "no data", ar: "مفيش بيانات" },
  waiting: { en: "Waiting for Port...", ar: "مستني Port..." },
  untrusted: { en: "Untrusted Port API host", ar: "عنوان Port API مش موثوق" },

  // ---- times ago (en: same text for every count; ar: one / two / 3-10 / 11+) --
  agoNow: { en: "just now", ar: "دلوقتي" },
  agoMin: { en: "{n} min ago", ar: "من {n} دقايق" },
  agoMinOne: { en: "{n} min ago", ar: "من دقيقة" },
  agoMinTwo: { en: "{n} min ago", ar: "من دقيقتين" },
  agoMinMany: { en: "{n} min ago", ar: "من {n} دقيقة" },
  agoHour: { en: "{n} h ago", ar: "من {n} ساعات" },
  agoHourOne: { en: "{n} h ago", ar: "من ساعة" },
  agoHourTwo: { en: "{n} h ago", ar: "من ساعتين" },
  agoHourMany: { en: "{n} h ago", ar: "من {n} ساعة" },
  agoDay: { en: "{n} d ago", ar: "من {n} أيام" },
  agoDayOne: { en: "{n} d ago", ar: "من يوم" },
  agoDayTwo: { en: "{n} d ago", ar: "من يومين" },
  agoDayMany: { en: "{n} d ago", ar: "من {n} يوم" },

  // ---- verdict and telemetry -----------------------------------------------
  lightCashier: { en: "Cashier app", ar: "تطبيق الكاشير" },
  lightBackend: { en: "Backend", ar: "الـ Backend" },
  lightAccounts: { en: "Accounts", ar: "الحسابات" },
  gapNote: {
    en: "Sales and stores online are not on this board yet: Port has no sales data to read.",
    ar: "المبيعات والمحلات الشغالة لسه مش على اللوحة: Port معندوش بيانات مبيعات.",
  },
  tlTitle: { en: "Telemetry, last 13 full days", ar: "القياسات، آخر 13 يوم كامل" },
  tlMerged: { en: "Changes merged per day", ar: "تعديلات اتدمجت في اليوم" },
  tlMergedSub: { en: "GitHub, all repos", ar: "GitHub، كل المستودعات" },
  tlRuns: { en: "CI runs per day", ar: "تشغيلات CI في اليوم" },
  tlRunsSub: { en: "GitHub Actions", ar: "GitHub Actions" },
  tlFails: { en: "CI failures per day", ar: "فشل CI في اليوم" },
  tlFailsSub: { en: "Normal band 0 to 2", ar: "الطبيعي من 0 لـ 2" },
  tlDone: { en: "Tasks done per day", ar: "مهام خلصت في اليوم" },
  tlDoneSub: { en: "Jira, RT", ar: "Jira، RT" },
  yday: { en: "yesterday", ar: "امبارح" },
  avg: { en: "13-day avg", ar: "متوسط 13 يوم" },
  spike: { en: "Spike", ar: "قفزة" },
  spikeNote: {
    en: "One-day spike: likely a bulk import or cleanup. Check before quoting.",
    ar: "قفزة في يوم واحد: غالباً استيراد أو تنظيف جماعي. اتأكد قبل ما تستشهد بيها.",
  },
  mergedSpark: { en: "Merged per day, 13 d", ar: "اتدمج في اليوم، 13 يوم" },

  // ---- map, panels and tabs (used by the later tasks) ------------------------
  mapTitle: { en: "Control room", ar: "غرفة التحكم" },
  mapSub: {
    en: "Every station, every cable and what it carries. Alarms sit where the fault is. Select a station or an alarm.",
    ar: "كل محطة وكل كابل وشايل إيه. الإنذار بيظهر مكان العطل. اختار محطة أو إنذار.",
  },
  alarms: { en: "Alarms", ar: "الإنذارات" },
  events: { en: "Events", ar: "الأحداث" },
  back: { en: "Back", ar: "رجوع" },
  perSvc: { en: "Per station", ar: "لكل محطة" },
  perSvcSub: {
    en: "From Port: tasks, changes and checks linked to each service.",
    ar: "من Port: المهام والتعديلات والفحوصات المربوطة بكل خدمة.",
  },
  thStation: { en: "Station", ar: "المحطة" },
  thTasks: { en: "Open tasks", ar: "مهام مفتوحة" },
  thPrs: { en: "PRs", ar: "طلبات تعديل" },
  thRuns: { en: "CI runs", ar: "تشغيلات CI" },
  thFailed: { en: "Failed, all", ar: "فشل، الكل" },
  jiraTitle: { en: "Work in Jira", ar: "الشغل في Jira" },
  jiraSub: { en: "{n} RT tasks by status.", ar: "{n} مهمة حسب الحالة." },
  jiraTodo: { en: "To do", ar: "لسه" },
  jiraProgress: { en: "In progress", ar: "شغالين" },
  jiraReview: { en: "In review", ar: "مراجعة" },
  jiraDone: { en: "Done", ar: "خلصت" },
  ciTitle: { en: "Automatic checks (CI)", ar: "الفحص التلقائي (CI)" },
  ciSub: { en: "The last {n} runs, oldest on the left.", ar: "آخر {n} تشغيلة، الأقدم على الشمال." },
  ciOf: {
    en: "of the last {n} runs passed (cancelled and skipped not counted)",
    ar: "من آخر {n} تشغيلة نجحت (الملغي والمتخطّى مش محسوبين)",
  },
  passed: { en: "Passed", ar: "نجح" },
  failed: { en: "Failed", ar: "فشل" },
  cancelled: { en: "Cancelled", ar: "اتلغى" },
  skipped: { en: "Skipped", ar: "اتخطّى" },
  hostsTitle: { en: "Health checks (Datadog)", ar: "فحوصات الصحة (Datadog)" },
  hostsSub: {
    en: "{n} checks in Port, grouped by what they watch.",
    ar: "{n} فحص في Port، متقسمين حسب اللي بيراقبوه.",
  },
  up: { en: "Up", ar: "شغال" },
  unlocated: { en: "Unlocated", ar: "مش متحدد المكان" },
  dWhere: { en: "Where", ar: "فين" },
  dKind: { en: "Kind", ar: "النوع" },
  dSince: { en: "In Port since", ar: "في Port من" },
  dFrom: { en: "Reported by", ar: "بلّغ عنه" },
  dPath: { en: "Path of the request", ar: "مسار الطلب" },
  gapLine: {
    en: "How often and when last: not in Port yet",
    ar: "عدد المرات وآخر مرة: لسه مش في Port",
  },
  open: { en: "Open in Sentry", ar: "افتح في Sentry" },
  ports: { en: "Links to the control room", ar: "الروابط بغرفة التحكم" },
  cablesH: { en: "Cables", ar: "الكابلات" },
  lgLive: { en: "Cable, no faults", ar: "كابل سليم" },
  lgFault: { en: "Cable with a fault", ar: "كابل فيه عطل" },
  lgUnwatched: { en: "Cable not watched (no error source)", ar: "كابل مش متراقب (مفيش مصدر أخطاء)" },
  lgInfra: { en: "Runs on (server)", ar: "شغال على (سيرفر)" },
  lgRule: { en: "Not allowed (by design)", ar: "ممنوع (مقصود)" },
  lgIcons: { en: "Alarm icons", ar: "أيقونات الإنذار" },
  lgFlow: {
    en: "Moving dots: the link is up. On the cables up to the control room, speed follows each station's activity in the last 7 days. It is not sales traffic.",
    ar: "النقط اللي بتتحرك: الرابط شغال. على الأسلاك الطالعة لغرفة التحكم السرعة حسب نشاط كل محطة في آخر 7 أيام. دي مش حركة مبيعات.",
  },
  ...ROOM_STRINGS,
  ...PANEL_STRINGS,
  ...MODE_STRINGS,
} as const satisfies Record<string, Entry>;

export type StringKey = keyof typeof STRINGS;
export type Vars = Record<string, string | number>;

/** One string in a language, with `{name}` placeholders filled. Digits are always Latin. */
export function format(key: StringKey, lang: Lang, vars?: Vars): string {
  const raw: string = STRINGS[key][lang];
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (hole, name: string) => (name in vars ? String(vars[name]) : hole));
}

/** Pick one side of a model-produced `{ en, ar }`. */
export function pick(text: { en: string; ar: string }, lang: Lang): string {
  return text[lang];
}

// ---- clock ----------------------------------------------------------------

const CAIRO = "Africa/Cairo";
const LATIN_DIGIT = (ch: string): string => {
  const code = ch.charCodeAt(0);
  if (code >= 0x660 && code <= 0x669) return String(code - 0x660);
  if (code >= 0x6f0 && code <= 0x6f9) return String(code - 0x6f0);
  return ch;
};
// Latin digits are enforced twice, independent of the ICU build: the formatters ask for `latn` (both as
// the `-u-nu-latn` tag and as `numberingSystem`), and every part is mapped through `toLatin` anyway.
const toLatin = (s: string): string => s.replace(/[٠-٩۰-۹]/g, LATIN_DIGIT);

const clocks: Record<Lang, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: CAIRO }),
  ar: new Intl.DateTimeFormat("ar-EG-u-nu-latn", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    numberingSystem: "latn",
    timeZone: CAIRO,
  }),
};

const stampers: Record<Lang, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: CAIRO,
  }),
  ar: new Intl.DateTimeFormat("ar-EG-u-nu-latn", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    numberingSystem: "latn",
    timeZone: CAIRO,
  }),
};

/** "12 Nov, 20:29": day, month and a 24-hour clock in Africa/Cairo, Latin digits in both languages. */
export function fmtStamp(d: Date, lang: Lang): string {
  const parts = stampers[lang].formatToParts(d);
  const part = (type: string) => toLatin(parts.find((p) => p.type === type)?.value ?? "");
  return `${part("day")} ${part("month")}, ${part("hour").padStart(2, "0")}:${part("minute").padStart(2, "0")}`;
}

/** HH:MM on a 24-hour clock in Africa/Cairo (the lab's day), Latin digits in both languages. */
export function fmtTime(d: Date, lang: Lang): string {
  const parts = clocks[lang].formatToParts(d);
  const part = (type: string) => toLatin(parts.find((p) => p.type === type)?.value ?? "").padStart(2, "0");
  return `${part("hour")}:${part("minute")}`;
}

// ---- how long ago ----------------------------------------------------------

type Unit = "Min" | "Hour" | "Day";

function agoKey(unit: Unit, n: number, lang: Lang): StringKey {
  const base = `ago${unit}`;
  if (lang === "en") return base as StringKey;
  if (n === 1) return `${base}One` as StringKey;
  if (n === 2) return `${base}Two` as StringKey;
  return (n <= 10 ? base : `${base}Many`) as StringKey;
}

/** "5 min ago", "1 h ago", "3 d ago" (Arabic: one / two / 3-10 / 11+ forms). A negative age reads as just now. */
export function agoText(ms: number, lang: Lang): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return format("agoNow", lang);
  if (minutes < 60) return format(agoKey("Min", minutes, lang), lang, { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return format(agoKey("Hour", hours, lang), lang, { n: hours });
  const days = Math.floor(hours / 24);
  return format(agoKey("Day", days, lang), lang, { n: days });
}
