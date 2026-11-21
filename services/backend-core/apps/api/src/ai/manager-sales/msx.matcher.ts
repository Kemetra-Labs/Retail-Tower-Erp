/**
 * RT-1539 — the deterministic intent match `msx-match/1` (RT-1526 §2.2): a closed, versioned,
 * repo-owned lexicon; no model, no fuzzy classifier. Pure and synchronous.
 *
 *   M-1 a chip (`templateId`) is the primary input; free text is secondary;
 *   M-2 parameters come from the controls only (the matcher never reads a store or period from text);
 *   M-3 free text selects a template only, through the lexicon below;
 *   M-4 the refusal lexicon wins (finance, then forecast, then write), even with a chip;
 *   M-5 the text is untrusted data: it is never echoed, and the outcome carries none of it;
 *   M-6 a date, period word or number the controls do not reflect is flagged, not obeyed;
 *   M-7 no match is `unsupported_question`;
 *   M-8 ties are broken by the fixed priority T-10 > T-07 > T-06 > T-05 > T-12 > T-04 > T-08 > T-09 >
 *       T-03 > T-02 > T-01.
 *
 * A lexicon entry is a whole-word phrase, or, when it starts with `~`, a substring (Arabic stems
 * carry clitics). Entries are normalized with the same function as the text.
 */
import type { MsxDecline, MsxRefusalCode, MsxTemplateId } from "./msx.constants";
import {
  ALEF,
  ALEF_MAQSURA,
  ALEF_VARIANTS,
  APOSTROPHES,
  ARABIC_INDIC_DIGITS,
  HA,
  MATCH_IGNORABLES,
  PERSIAN_DIGITS,
  TA_MARBUTA,
  YA,
} from "./msx.text";

export interface MatchInput {
  readonly templateId?: MsxTemplateId;
  readonly question?: string;
  /** How many stores the controls selected (0 = the caller's whole scope). */
  readonly storeCount: number;
  readonly from: string;
  readonly to: string;
}

export type MatchOutcome =
  | {
      readonly kind: "template";
      readonly templateId: MsxTemplateId;
      readonly parametersFromControlsOnly: boolean;
      readonly declined: readonly MsxDecline[];
    }
  | { readonly kind: "refusal"; readonly code: MsxRefusalCode };

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** NFKC, bidi controls, tashkeel and tatweel removed, digits folded to ASCII, lower case. */
function fold(text: string): string {
  return text
    .normalize("NFKC")
    .replace(MATCH_IGNORABLES, "")
    .replace(ARABIC_INDIC_DIGITS, (d) => String(d.codePointAt(0)! - 0x0660))
    .replace(PERSIAN_DIGITS, (d) => String(d.codePointAt(0)! - 0x06f0))
    .toLowerCase();
}

/** The form the lexicon matches on: folded, alef/ya/ta marbuta unified, punctuation as one space. */
export function normalizeText(text: string): string {
  return fold(text)
    .replace(APOSTROPHES, "")
    .replace(ALEF_VARIANTS, ALEF)
    .replace(ALEF_MAQSURA, YA)
    .replace(TA_MARBUTA, HA)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Lexicon
// ---------------------------------------------------------------------------

const FINANCE = [
  "profit", "profits", "profitability", "margin", "margins", "cogs", "cost of goods", "cost of sales", "net sales",
  "net income", "earnings", "ebitda", "markup",
  "~ربح", "~ارباح", "~هامش", "~تكلفه البضاعه", "~تكلفه المبيعات", "~صافي المبيعات", "~صافي الدخل",
];

const FORECAST = [
  "forecast", "forecasts", "predict", "prediction", "predictions", "projection", "projected", "next month", "next week",
  "next year", "tomorrow", "will we sell", "expected sales", "going to sell",
  "~توقع", "~تنبا", "~الشهر الجاي", "~الشهر القادم", "~الاسبوع الجاي", "~الاسبوع القادم", "~السنه الجايه", "~السنه القادمه", "بكره", "غدا",
];

const WRITE = [
  "refund the", "refund this", "refund that", "refund last", "refund it", "refund all", "refund my", "refund sale",
  "mark it", "mark this", "mark as", "post it", "post this", "post the", "retry", "delete", "remove", "approve",
  "change the price", "change price", "set the price", "set price", "update price", "update the price", "edit price",
  "cancel the", "cancel this", "void the", "void this", "void last", "void it", "write off", "close shift", "close the shift",
  "استرجع", "ارجع", "رجع", "امسح", "احذف", "الغي", "ارسل", "ابعت", "رحل",
  "~غير السعر", "~غير سعر", "~عدل السعر", "~عدل سعر",
];

/** A figure asked for as final: the conclusive claim `partial_data_not_conclusive` declines. */
const CONCLUSIVE = ["final", "finalized", "conclusive", "closing figure", "closing total", "end of day total", "is this complete", "is it complete", "complete total", "~نهائي", "~ختامي"];
const NEGATED_FINAL = ["not final", "isnt final", "not complete", "not conclusive", "~غير نهائي", "~مش نهائي", "~مو نهائي", "~ليس نهائي"];
const PARTIAL = ["partial", "incomplete", "still in progress", "so far", "~جزئي", "~ناقص"];

const LEXICON: Readonly<Record<MsxTemplateId, readonly string[]>> = {
  "T-10": [...PARTIAL, ...NEGATED_FINAL, ...CONCLUSIVE],
  "T-07": [
    "why", "what changed", "what happened", "explain", "explanation", "reason", "cause",
    "ليه", "ليش", "لماذا", "فسر", "اشرح", "~سبب", "~اسباب", "~ايه اللي حصل", "~شو صار", "~وش صار",
  ],
  "T-06": [
    "versus", "vs", "compared to", "compared with", "previous period", "last period", "previous week", "previous month", "than last",
    "~الفتره السابقه", "~عن الاسبوع اللي فات", "~عن الاسبوع الماضي", "~عن الشهر الماضي", "~عن الشهر اللي فات",
    "~مقارنه بالاسبوع", "~مقارنه بالشهر", "~مقارنه بالفتره",
  ],
  "T-05": ["compare", "comparison", "side by side", "between the stores", "between stores", "between the two", "~قارن", "~مقارنه", "~بين المتجرين", "~بين الفرعين"],
  "T-12": [
    "no sales", "without sales", "did not sell", "didnt sell", "havent sold", "not sold", "zero sales", "stores with no",
    "~ما باع", "~بدون مبيعات", "~بلا مبيعات", "~ما فيش مبيعات", "~لم تبع", "~لم يبع",
  ],
  "T-04": [
    "rank", "ranks", "ranked", "ranking", "which store", "best store", "top store", "worst store", "best selling", "top selling",
    "sells the most", "sold the most", "who sells most", "leaderboard",
    "رتب", "~ترتيب", "~انهي متجر", "~اي متجر", "~اي فرع", "~انهي فرع", "~افضل متجر", "~افضل فرع",
  ],
  "T-08": ["best day", "busiest day", "highest day", "peak day", "top day", "strongest day", "~افضل يوم", "~احسن يوم", "~اكتر يوم", "~اعلي يوم"],
  "T-09": [
    "average sale", "average ticket", "average basket", "average invoice", "average receipt", "average order", "average transaction", "avg sale",
    "~متوسط", "~معدل الفاتوره",
  ],
  "T-03": ["void", "voids", "return", "returns", "returned", "refunds", "legacy refunds", "~مرتجع", "~الغاء", "~استرداد"],
  "T-02": ["day by day", "daily", "per day", "each day", "every day", "by day", "day wise", "by date", "breakdown", "~يوم بيوم", "~يوميا", "~كل يوم", "~حسب اليوم", "~تفصيل"],
  "T-01": [
    "total sales", "total sale", "sales total", "how much did we sell", "how much we sold", "how much have we sold",
    "how much did i sell", "how much do we sell", "my sales", "our sales", "sales figure", "revenue",
    "~بعنا كام", "~كم بعنا", "~كام بعنا", "~مجموع المبيعات", "~اجمالي المبيعات", "~كم المبيعات", "~كام المبيعات", "~كم صار مجموع",
  ],
};

/** M-8, highest priority first. */
const PRIORITY: readonly MsxTemplateId[] = ["T-10", "T-07", "T-06", "T-05", "T-12", "T-04", "T-08", "T-09", "T-03", "T-02", "T-01"];

interface Compiled {
  readonly words: readonly string[];
  readonly stems: readonly string[];
}

function compile(entries: readonly string[]): Compiled {
  const words: string[] = [];
  const stems: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("~")) stems.push(normalizeText(entry.slice(1)));
    else words.push(` ${normalizeText(entry)} `);
  }
  return { words, stems };
}

const COMPILED = {
  finance: compile(FINANCE),
  forecast: compile(FORECAST),
  write: compile(WRITE),
  conclusive: compile(CONCLUSIVE),
  negatedFinal: compile(NEGATED_FINAL),
  templates: new Map(PRIORITY.map((id) => [id, compile(LEXICON[id])] as const)),
};

function hits(text: string, lexicon: Compiled): boolean {
  const padded = ` ${text} `;
  return lexicon.words.some((w) => padded.includes(w)) || lexicon.stems.some((s) => text.includes(s));
}

// ---------------------------------------------------------------------------
// Parameters from the controls (M-6)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function dayCountOf(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

const ONE_DAY = ["today", "yesterday", "اليوم", "النهارده", "امس"];
const ONE_WEEK = ["this week", "last week", "past week", "~اسبوع"];
const ONE_MONTH = ["this month", "last month", "past month", "~شهر"];
const ONE_DAY_C = compile(ONE_DAY);
const ONE_WEEK_C = compile(ONE_WEEK);
const ONE_MONTH_C = compile(ONE_MONTH);

/** A period word whose length the controls do not hold. */
function periodWordDiffers(text: string, days: number): boolean {
  if (hits(text, ONE_DAY_C) && days !== 1) return true;
  if (hits(text, ONE_WEEK_C) && days !== 7) return true;
  return hits(text, ONE_MONTH_C) && (days < 28 || days > 31);
}

/** An ISO date outside the controls, or a day or week count that is not the controls' length. */
function explicitValueDiffers(folded: string, from: string, to: string, days: number): boolean {
  for (const m of folded.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
    if (m[1]! < from || m[1]! > to) return true;
  }
  for (const m of folded.matchAll(/(?<![\p{L}\p{N}])(\d{1,3})\s*(days?|weeks?|يوم|ايام|اسبوع|اسابيع)(?![\p{L}\p{N}])/gu)) {
    const unit = m[2]!;
    const weeks = unit.startsWith("week") || unit === "اسبوع" || unit === "اسابيع";
    if (Number(m[1]) * (weeks ? 7 : 1) !== days) return true;
  }
  return false;
}

/** True when the text names a date, period word or day count that the controls do not reflect. */
function parametersDiffer(question: string, from: string, to: string): boolean {
  const days = dayCountOf(from, to);
  return periodWordDiffers(normalizeText(question), days) || explicitValueDiffers(fold(question), from, to, days);
}

// ---------------------------------------------------------------------------
// The match
// ---------------------------------------------------------------------------

function refusalOf(text: string): MsxRefusalCode | null {
  if (hits(text, COMPILED.finance)) return "finance_source_absent";
  if (hits(text, COMPILED.forecast)) return "forecast_not_supported";
  if (hits(text, COMPILED.write)) return "write_action_not_supported";
  return null;
}

function templateOfText(text: string, storeCount: number): MsxTemplateId | null {
  for (const id of PRIORITY) {
    if (!hits(text, COMPILED.templates.get(id)!)) continue;
    // Comparing fewer than two selected stores is the ranking of the whole scope.
    return id === "T-05" && storeCount < 2 ? "T-04" : id;
  }
  return null;
}

function declinedOf(templateId: MsxTemplateId, text: string): readonly MsxDecline[] {
  if (templateId === "T-07") return ["causal_not_supported"];
  if (templateId === "T-10" && hits(text, COMPILED.conclusive) && !hits(text, COMPILED.negatedFinal)) return ["partial_data_not_conclusive"];
  return [];
}

/** The deterministic, model-free outcome of a request: a template, or a product refusal. */
export function matchRequest(input: MatchInput): MatchOutcome {
  const text = input.question === undefined ? "" : normalizeText(input.question);
  const refusal = refusalOf(text);
  if (refusal !== null) return { kind: "refusal", code: refusal };

  const templateId = input.templateId ?? templateOfText(text, input.storeCount);
  if (templateId === null) return { kind: "refusal", code: "unsupported_question" };
  return {
    kind: "template",
    templateId,
    parametersFromControlsOnly: input.question !== undefined && parametersDiffer(input.question, input.from, input.to),
    declined: declinedOf(templateId, text),
  };
}
