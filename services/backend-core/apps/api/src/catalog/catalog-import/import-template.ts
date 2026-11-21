/**
 * RT-1537 (spec 049 S5c, contract `consoleGetCatalogImportTemplate`): the import template, a CSV with one header line
 * that names every canonical field in the chosen language and no data row. Every header is a synonym the auto-mapping
 * recognises (`import-synonym-data.ts`; the unit test proves it for both languages), including `price` and `currency`,
 * which are recognised and not imported yet (spec 049 §6). The same for every tenant.
 *
 * The Arabic words are written as code points, as the synonym data is.
 */
import { z } from "zod";

import { attachmentDisposition, CSV_BOM, csvLine } from "./import-csv";
import { CANONICAL_FIELDS, type CanonicalField } from "./import-mapping";

export const TEMPLATE_LANGUAGES = ["ar", "en"] as const;
export type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number];

/** `headers` (Arabic first): one language, no other key (a 400 `validation_error`). */
export const TemplateQuerySchema = z.object({ headers: z.enum(TEMPLATE_LANGUAGES).optional() }).strict();

export const TEMPLATE_HEADERS: Readonly<Record<TemplateLanguage, Readonly<Record<CanonicalField, string>>>> = {
  en: {
    sku: "SKU",
    barcode: "Barcode",
    plu: "PLU",
    name: "Product Name",
    description: "Description",
    category: "Category",
    brand: "Brand",
    tax_category: "Tax Category",
    is_active: "Is Active",
    price: "Price",
    currency: "Currency",
  },
  ar: {
    sku: "\u{643}\u{648}\u{62F} \u{627}\u{644}\u{635}\u{646}\u{641}",
    barcode: "\u{628}\u{627}\u{631}\u{643}\u{648}\u{62F}",
    plu: "\u{643}\u{648}\u{62F} PLU",
    name: "\u{627}\u{633}\u{645} \u{627}\u{644}\u{645}\u{646}\u{62A}\u{62C}",
    description: "\u{648}\u{635}\u{641} \u{627}\u{644}\u{645}\u{646}\u{62A}\u{62C}",
    category: "\u{627}\u{644}\u{62A}\u{635}\u{646}\u{64A}\u{641}",
    brand: "\u{627}\u{644}\u{639}\u{644}\u{627}\u{645}\u{629} \u{627}\u{644}\u{62A}\u{62C}\u{627}\u{631}\u{64A}\u{629}",
    tax_category: "\u{627}\u{644}\u{641}\u{626}\u{629} \u{627}\u{644}\u{636}\u{631}\u{64A}\u{628}\u{64A}\u{629}",
    is_active: "\u{646}\u{634}\u{637}",
    price: "\u{627}\u{644}\u{633}\u{639}\u{631}",
    currency: "\u{627}\u{644}\u{639}\u{645}\u{644}\u{629}",
  },
};

/** The template: a BOM and the header line, in the order of the canonical fields. */
export function buildTemplateCsv(language: TemplateLanguage): string {
  return CSV_BOM + csvLine(CANONICAL_FIELDS.map((field) => TEMPLATE_HEADERS[language][field]));
}

/** The attachment header of the template of one language. */
export function templateDisposition(language: TemplateLanguage): string {
  return attachmentDisposition(`import-template-${language}.csv`);
}
