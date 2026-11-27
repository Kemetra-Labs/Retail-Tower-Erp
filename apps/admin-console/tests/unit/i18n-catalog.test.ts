import { AR_MODULES, ar } from "@/i18n/messages/ar";
import { EN_MODULES, en } from "@/i18n/messages/en";
import type { Message } from "@/i18n/messages/types";
import { describe, expect, test } from "vitest";

/**
 * RT-399 catalog integrity (RT-266 plan §3.2). The compiler already requires
 * every Arabic key in English; these checks cover what types can't: key
 * collisions between surface modules, placeholder parity, Arabic plural
 * completeness, and that each catalog speaks one language (UX-12 "one locale at
 * a time").
 */

const ARABIC = /[؀-ۿ]/;
const LATIN_WORD = /[A-Za-z]{2,}/;
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Latin terms that may stand inside Arabic copy: proper and machine terms
 * UX-12 keeps as-is (ERPNext, EGP, SKU, API, UTC, IDs) and the product name.
 * RT-474: the file formats PNG and SVG and the size unit KB, as the owner-approved
 * logo copy writes them.
 */
const MACHINE_TERMS =
  /\b(Retail Tower|ERPNext|Frappe|EGP|SKU|API|UTC|ID|IDs|request_id|Idempotency-Key|Connector|POS|Clerk|PNG|SVG|KB|SHA-256|PowerShell|Windows|Kemetra|CSV|XLSX|UTF|PLU|Tab)\b/g;

function branches(m: Message): string[] {
  return typeof m === "string" ? [m] : Object.values(m).filter((v): v is string => !!v);
}

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((x) => x[1]).sort();
}

function otherBranch(m: Message): string {
  return typeof m === "string" ? m : m.other;
}

const arEntries = Object.entries(ar) as [string, Message][];
const enCatalog = en as Record<string, Message>;

describe("catalog shape", () => {
  test("no key is defined by two surface modules", () => {
    for (const modules of [AR_MODULES, EN_MODULES]) {
      const seen = new Map<string, string>();
      for (const [name, mod] of Object.entries(modules)) {
        for (const key of Object.keys(mod)) {
          expect(seen.get(key), `${key} in ${name} and ${seen.get(key)}`).toBeUndefined();
          seen.set(key, name);
        }
      }
    }
  });

  test("English covers exactly the Arabic key set", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ar).sort());
  });

  test("keys are namespaced dotted identifiers, never English sentences", () => {
    for (const [key] of arEntries) {
      expect(key).toMatch(/^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/);
    }
  });

  test("no message is empty", () => {
    for (const [key, m] of arEntries) {
      for (const b of [...branches(m), ...branches(enCatalog[key])]) {
        expect(b.trim(), key).not.toBe("");
      }
    }
  });
});

describe("placeholders and plurals", () => {
  test("Arabic and English use the same named params", () => {
    for (const [key, m] of arEntries) {
      expect(placeholders(otherBranch(enCatalog[key])), key).toEqual(placeholders(otherBranch(m)));
    }
  });

  test("an Arabic count phrase defines all six CLDR plural categories", () => {
    for (const [key, m] of arEntries) {
      if (typeof m === "string") continue;
      expect(Object.keys(m).sort(), key).toEqual(["few", "many", "one", "other", "two", "zero"]);
    }
  });

  test("all branches of a count phrase agree apart from {count}", () => {
    // A branch that drops a param (say {time}) would render a sentence with a
    // hole; {count} is the one exception — Arabic spells it out in zero/one/
    // two while English counts it, so it is compared separately below.
    for (const [key, m] of [...arEntries, ...Object.entries(enCatalog)]) {
      if (typeof m === "string") continue;
      const sets = branches(m).map((b) =>
        placeholders(b).filter((p) => p !== "count"),
      );
      for (const s of sets.slice(1)) expect(s, key).toEqual(sets[0]);
    }
  });

  test("the numeral branches (few/many/other) agree on {count} too", () => {
    for (const [key, m] of [...arEntries, ...Object.entries(enCatalog)]) {
      if (typeof m === "string") continue;
      for (const b of ["few", "many", "other"] as const) {
        if (m[b] === undefined) continue;
        expect(placeholders(m[b]), `${key} (${b})`).toEqual(
          placeholders(m.other),
        );
      }
    }
  });

  // The house pattern (overview.insight.failedPosting): zero/one/two spell the
  // count out; {count} is only for few/many/other. The catalog still has
  // pre-existing keys that interpolate {count} in zero (retry-after sentences,
  // bare count labels), so this is asserted only for the keys fixed here —
  // not as a catalog-wide rule.
  test("the fixed zero branches spell the count out", () => {
    const arByKey = new Map(arEntries);
    for (const key of [
      "devices.impact.cashFacts.value",
      "devices.issue.issued.valid",
      "devices.issue.issued.validHours",
      "inventory.error.rateLimitedFor",
    ]) {
      const m = arByKey.get(key);
      expect(m, key).toBeDefined();
      expect(typeof m, key).not.toBe("string");
      if (typeof m !== "string") {
        expect(m.zero, key).toBeDefined();
        if (m.zero !== undefined) {
          expect(placeholders(m.zero), key).not.toContain("count");
        }
      }
    }
  });

  test("an English count phrase defines one and other", () => {
    for (const [key, m] of Object.entries(enCatalog)) {
      if (typeof m === "string") continue;
      expect(m.one, key).toBeDefined();
      expect(m.other, key).toBeDefined();
    }
  });
});

describe("one locale at a time", () => {
  // The switch label is the one place a catalog names the other language.
  const SWITCH = new Set(["locale.switch.name", "locale.switch.action"]);

  test("Arabic copy is Arabic: no untranslated English left behind", () => {
    for (const [key, m] of arEntries) {
      for (const b of branches(m)) {
        const prose = b.replace(PLACEHOLDER, "").replace(MACHINE_TERMS, "");
        expect(LATIN_WORD.test(prose), `${key}: ${b}`).toBe(false);
      }
    }
  });

  test("English copy has no Arabic in it", () => {
    for (const [key, m] of Object.entries(enCatalog)) {
      if (SWITCH.has(key)) continue;
      for (const b of branches(m)) expect(ARABIC.test(b), `${key}: ${b}`).toBe(false);
    }
  });

  test("UX-12 terms: Store is «المتجر», never «الفرع»", () => {
    for (const [key, m] of arEntries) {
      for (const b of branches(m)) expect(b.includes("الفرع"), key).toBe(false);
    }
  });
});
