import {
  EMPTY_IDENTIFIER_FORM,
  type IdentifierFormValues,
  TENANT_WIDE,
  digitWarning,
  firstErrorField,
  identifierKeyOf,
  mapIdentifierWriteError,
  retireKeyOf,
  sameKey,
  sourceSystemError,
  validateIdentifierForm,
  valueError,
} from "@/catalog/identifierFormLogic";
import type { CatalogIdentifier } from "@/lib/catalog-queries";
import { describe, expect, test } from "vitest";
import { CAIRO_STORE } from "./catalog-fixtures";

/**
 * RT-769 identifier drawer rules (CAT-C2b, RT-752 AC 3, D6). The value is an
 * identifier: it is sent byte for byte, and what the contract rejects is named,
 * never fixed.
 */
const form = (over: Partial<IdentifierFormValues> = {}): IdentifierFormValues => ({
  ...EMPTY_IDENTIFIER_FORM,
  ...over,
});

describe("byte for byte: the key is the value exactly as typed", () => {
  test.each([
    ["leading zeros", "0012345678905"],
    ["mixed case", "AbC-def"],
    ["inner spaces", "A  B"],
    ["Arabic-Indic digits", "٠١٢٣٤٥"],
    ["Extended Arabic-Indic digits", "۱۲۳"],
    ["full-width digits", "１２３"],
    ["a letter that case folding would change", "straße"],
    ["a composed and a decomposed é", "é-é"],
  ])("%s are sent unchanged", (_name, value) => {
    const key = identifierKeyOf(form({ value }));
    expect(key.value).toBe(value);
    expect(key.value.length).toBe(value.length);
  });

  test("a tenant-wide barcode sends a null store and a null source system", () => {
    expect(identifierKeyOf(form({ value: "123" }))).toEqual({
      identifierType: "barcode",
      value: "123",
      storeId: null,
      sourceSystem: null,
    });
  });

  test("a store-scoped SKU sends the store", () => {
    expect(
      identifierKeyOf(form({ identifierType: "sku", value: "S-1", storeId: CAIRO_STORE })),
    ).toEqual({ identifierType: "sku", value: "S-1", storeId: CAIRO_STORE, sourceSystem: null });
  });

  test("a typed source system is never sent on another type", () => {
    const key = identifierKeyOf(form({ identifierType: "plu", value: "7", sourceSystem: "x" }));
    expect(key.sourceSystem).toBeNull();
  });

  test("an external POS id is never store-scoped, and carries its source system as typed", () => {
    const key = identifierKeyOf(
      form({
        identifierType: "external_pos_id",
        value: "ext-9",
        storeId: CAIRO_STORE,
        sourceSystem: "Legacy POS ",
      }),
    );
    expect(key).toEqual({
      identifierType: "external_pos_id",
      value: "ext-9",
      storeId: null,
      sourceSystem: "Legacy POS ",
    });
  });

  test("retire names the identifier by its full key as read, byte for byte", () => {
    const read: CatalogIdentifier = {
      identifierType: "supplier_code",
      value: "00ab ",
      storeId: CAIRO_STORE,
      sourceSystem: null,
      createdAt: "2026-10-01T08:00:00Z",
    };
    expect(retireKeyOf(read)).toEqual({
      identifierType: "supplier_code",
      value: "00ab ",
      storeId: CAIRO_STORE,
      sourceSystem: null,
    });
  });

  test("two keys are the same only when every part matches exactly", () => {
    const a = identifierKeyOf(form({ value: "123" }));
    expect(sameKey(a, { ...a })).toBe(true);
    expect(sameKey(a, { ...a, value: "0123" })).toBe(false);
    expect(sameKey(a, { ...a, storeId: CAIRO_STORE })).toBe(false);
    expect(sameKey(a, { ...a, identifierType: "sku" })).toBe(false);
    expect(sameKey(a, { ...a, storeId: undefined })).toBe(true);
  });
});

describe("prevent: each rule the contract enforces is named, never fixed", () => {
  test("an empty value is required", () => {
    expect(valueError("")).toBe("catalog.identifier.error.valueRequired");
  });

  test.each([
    ["a tab", "12\t34"],
    ["a newline", "12\n"],
    ["NUL", "\u0000123"],
    ["DEL", "123\u007f"],
    ["the last C0 control", "1\u001f2"],
  ])("a control character (%s) is refused", (_name, value) => {
    expect(valueError(value)).toBe("catalog.identifier.error.valueControl");
  });

  test.each([
    ["a leading space", " 123"],
    ["a trailing space", "123 "],
    ["a trailing no-break space", "123 "],
    ["only spaces", "   "],
  ])("%s is refused, not trimmed", (_name, value) => {
    expect(valueError(value)).toBe("catalog.identifier.error.valueEdgeSpace");
    expect(identifierKeyOf(form({ value })).value).toBe(value);
  });

  test("200 characters pass; 201 do not", () => {
    expect(valueError("9".repeat(200))).toBeUndefined();
    expect(valueError("9".repeat(201))).toBe("catalog.identifier.error.valueTooLong");
  });

  test("the length counts characters, not UTF-16 units", () => {
    // 200 astral characters are 400 UTF-16 units: still within the contract's 200.
    expect(valueError("𝟗".repeat(200))).toBeUndefined();
    expect(valueError("𝟗".repeat(201))).toBe("catalog.identifier.error.valueTooLong");
  });

  test("inner spaces and any printable character are allowed", () => {
    expect(valueError("A B-é/٣")).toBeUndefined();
  });

  test("a source system is required only on an external POS id", () => {
    expect(sourceSystemError(form({ identifierType: "barcode" }))).toBeUndefined();
    expect(sourceSystemError(form({ identifierType: "external_pos_id" }))).toBe(
      "catalog.identifier.error.sourceRequired",
    );
    expect(sourceSystemError(form({ identifierType: "external_pos_id", sourceSystem: "  " }))).toBe(
      "catalog.identifier.error.sourceRequired",
    );
    expect(
      sourceSystemError(form({ identifierType: "external_pos_id", sourceSystem: "a\u0000" })),
    ).toBe("catalog.identifier.error.sourceControl");
    expect(
      sourceSystemError(form({ identifierType: "external_pos_id", sourceSystem: "x".repeat(101) })),
    ).toBe("catalog.identifier.error.sourceTooLong");
    expect(
      sourceSystemError(form({ identifierType: "external_pos_id", sourceSystem: "x".repeat(100) })),
    ).toBeUndefined();
  });

  test("every error at once; focus goes to the first in drawer order (source before value)", () => {
    const errors = validateIdentifierForm(form({ identifierType: "external_pos_id" }));
    expect(errors).toEqual({
      sourceSystem: "catalog.identifier.error.sourceRequired",
      value: "catalog.identifier.error.valueRequired",
    });
    expect(firstErrorField(errors)).toBe("sourceSystem");
    expect(firstErrorField(validateIdentifierForm(form({ value: " x" })))).toBe("value");
    expect(validateIdentifierForm(form({ value: "123" }))).toEqual({});
    expect(firstErrorField({})).toBeUndefined();
  });

  test("the scope choice defaults to tenant-wide", () => {
    expect(EMPTY_IDENTIFIER_FORM.storeId).toBe(TENANT_WIDE);
    expect(EMPTY_IDENTIFIER_FORM.identifierType).toBe("barcode");
  });
});

describe("D6: Arabic-Indic digits in a barcode or PLU warn, never block, never convert", () => {
  test.each([
    ["barcode", "٠١٢٣٤٥٦٧٨٩"],
    ["barcode", "12٣4"],
    ["plu", "۴۲"],
  ] as const)("a %s with %s warns", (identifierType, value) => {
    const values = form({ identifierType, value });
    expect(digitWarning(values)).toBe("catalog.identifier.warning.arabicDigits");
    expect(validateIdentifierForm(values)).toEqual({});
    expect(identifierKeyOf(values).value).toBe(value);
  });

  test.each([
    ["barcode", "0012345678905"],
    ["plu", "42"],
    ["barcode", ""],
  ] as const)("a %s of Latin digits (%s) does not warn", (identifierType, value) => {
    expect(digitWarning(form({ identifierType, value }))).toBeUndefined();
  });

  test.each(["sku", "supplier_code", "external_pos_id"] as const)(
    "a %s is not scanned as digits: no warning",
    (identifierType) => {
      expect(digitWarning(form({ identifierType, value: "٣٤" }))).toBeUndefined();
    },
  );
});

describe("the failure of a write", () => {
  const add = (status: number, code?: string) =>
    mapIdentifierWriteError({ op: "add", status, code, requestId: "r1" });
  const retire = (status: number, code?: string) =>
    mapIdentifierWriteError({ op: "retire", status, code, requestId: "r1" });

  test("409 alias_conflict is an error on the value that names no other item", () => {
    expect(add(409, "alias_conflict")).toEqual({
      kind: "field",
      field: "value",
      messageKey: "catalog.identifier.error.aliasConflict",
    });
  });

  test("409 product_retired is a surface error", () => {
    expect(add(409, "product_retired")).toEqual({ kind: "retired", requestId: "r1" });
  });

  test("another 409 is a conflict banner", () => {
    expect(add(409, "other")).toMatchObject({
      kind: "banner",
      messageKey: "catalog.write.error.conflict",
    });
  });

  test.each([
    [400, undefined, "catalog.identifier.error.validation", "danger"],
    [401, undefined, "catalog.write.error.session", "danger"],
    [403, "origin_rejected", "catalog.write.error.origin", "danger"],
    [403, undefined, "catalog.write.error.forbidden", "danger"],
    [404, "not_found", "catalog.identifier.error.notFound", "danger"],
    [429, "rate_limited", "catalog.write.error.rateLimited", "warning"],
    [500, "internal_error", "catalog.write.error.server", "danger"],
    [503, undefined, "catalog.write.error.server", "danger"],
  ])("add %i %s is a %s banner", (status, code, messageKey, variant) => {
    expect(add(status, code)).toEqual({ kind: "banner", variant, messageKey, requestId: "r1" });
  });

  test("a 404 on retire is the non-disclosing 'no longer active here'", () => {
    expect(retire(404, "not_found")).toEqual({ kind: "gone", requestId: "r1" });
  });

  test("other retire failures are banners", () => {
    expect(retire(500)).toMatchObject({ kind: "banner", messageKey: "catalog.write.error.server" });
    expect(retire(400)).toMatchObject({
      kind: "banner",
      messageKey: "catalog.identifier.error.validation",
    });
  });
});
