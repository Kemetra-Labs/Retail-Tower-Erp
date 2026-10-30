/**
 * RT-399 message lookup (RT-266 plan §3.2). Whole sentences with named
 * `{param}` placeholders; plural maps resolve on the `count` param with
 * `Intl.PluralRules`. Numeric params render with Western digits and grouping in
 * both locales (UX-12). No string concatenation happens at call sites, so word
 * order, agreement and bidi stay the translator's call.
 *
 * Kept free of React and of the `@/` path alias, so the e2e suites can import it
 * to select by the same copy the app renders.
 */
import { catalogFor } from "./catalogs";
import { type Locale, getLocale, intlTag } from "./locale";
import type { ar } from "./messages/ar";
import type { Message, Messages } from "./messages/types";

export type MessageKey = keyof typeof ar;

export type Params = Record<string, string | number>;

/**
 * RT-962: the catalogs load on demand (catalogs.ts), but the language switch
 * names the OTHER language in its own words before that catalog is fetched.
 * tests/unit/i18n-catalog-loading.test.ts keeps these equal to the catalogs.
 */
const SWITCH_LABELS: Record<Locale, Messages> = {
  ar: { "locale.switch.name": "العربية", "locale.switch.action": "التبديل إلى العربية" },
  en: { "locale.switch.name": "English", "locale.switch.action": "Switch to English" },
};

const numberFormats = new Map<Locale, Intl.NumberFormat>();
const pluralRules = new Map<Locale, Intl.PluralRules>();

/** A count or plain number with Western digits and grouping (`1,284`). */
export function formatNumber(value: number, locale: Locale = getLocale()): string {
  let nf = numberFormats.get(locale);
  if (!nf) {
    nf = new Intl.NumberFormat(intlTag(locale));
    numberFormats.set(locale, nf);
  }
  return nf.format(value);
}

function pluralCategory(locale: Locale, count: number): Intl.LDMLPluralRule {
  let pr = pluralRules.get(locale);
  if (!pr) {
    pr = new Intl.PluralRules(intlTag(locale));
    pluralRules.set(locale, pr);
  }
  return pr.select(count);
}

/** The template for a message: the plural branch for `count`, else `other`. */
function template(locale: Locale, message: Message, params?: Params): string {
  if (typeof message === "string") return message;
  const count = params?.count;
  if (typeof count !== "number") return message.other;
  return message[pluralCategory(locale, count)] ?? message.other;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** Split a template into literal text and `{param}` names (odd indexes). */
export function splitTemplate(text: string): string[] {
  return text.split(PLACEHOLDER);
}

/**
 * Resolve a key to its template in `locale`, before params are filled. A locale
 * whose catalog is not loaded yet answers the key itself: it is never made
 * active (locale.ts), so this only guards against a crash.
 */
export function templateFor(locale: Locale, key: MessageKey, params?: Params): string {
  const message = catalogFor(locale)?.[key] ?? SWITCH_LABELS[locale][key];
  return message === undefined ? key : template(locale, message, params);
}

/** The localized string for `key` in `locale`, with params filled in. */
export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  return templateFor(locale, key, params).replace(PLACEHOLDER, (whole, name: string) => {
    const value = params?.[name];
    if (value === undefined) return whole;
    return typeof value === "number" ? formatNumber(value, locale) : value;
  });
}

/** `translate` in the active locale. React components use `useT()` instead. */
export function t(key: MessageKey, params?: Params): string {
  return translate(getLocale(), key, params);
}
