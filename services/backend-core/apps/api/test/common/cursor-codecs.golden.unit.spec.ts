/**
 * RT-1213: golden characterization of every opaque cursor codec, written against the
 * pre-migration code so that moving each module onto `common/cursor/opaque-cursor` cannot change
 * a byte of a token, an error class or message, the tenant check, or which UUID case is accepted.
 *
 * Expected tokens are derived from the exact JSON text with Node's own base64url, never written
 * as literals: a base64 literal of `{"k":` looks like a Grafana key to gitleaks and the CI scan
 * of full history cannot be allowlisted per line (the first slice hit this). Byte equality still
 * holds because the JSON text, its key order and the unpadded base64url alphabet are all fixed.
 */
import { createHash } from "node:crypto";
import { encodeCatalogCursor, decodeCatalogCursor, InvalidCatalogCursorError } from "../../src/catalog/console-catalog/console-catalog.query";
import {
  InvalidCursorError as InvalidNegativeOnHandCursorError,
  decodeItemCursor,
  decodeStoreCursor,
  encodeItemCursor,
  encodeStoreCursor,
} from "../../src/catalog/erpnext-reconciliation/negative-on-hand.projection";
import {
  InvalidSaleHistoryCursorError,
  decodeSaleHistoryCursor,
  encodeSaleHistoryCursor,
} from "../../src/catalog/sales/history/sale-history.query";
import {
  InvalidPosPayersCursorError,
  decodePosPayersCursor,
  encodePosPayersCursor,
} from "../../src/catalog/sales/payers/pos-payers.query";
import {
  InvalidPolicyCursorError,
  decodePolicyCursor,
  encodePolicyCursor,
} from "../../src/cash-variance-policy/policy.projections";
import {
  InvalidSalesSummaryCursorError,
  decodeSalesSummaryCursor,
  encodeSalesSummaryCursor,
} from "../../src/console-sales/console-sales-summary.query";
import {
  InvalidConsoleSaleCursorError,
  decodeConsoleSaleCursor,
  encodeConsoleSaleCursor,
} from "../../src/console-sales/console-sales.query";
import {
  InvalidDeviceCursorError,
  decodeDeviceCursor,
  encodeDeviceCursor,
} from "../../src/devices/devices.projections";
import {
  InvalidPairingCodeCursorError,
  decodePairingCodeCursor,
  encodePairingCodeCursor,
} from "../../src/devices/pairing-codes.projections";
import {
  StockMovementCursorError,
  decodeStockMovementCursor,
  encodeStockMovementCursor,
} from "../../src/inventory/movement-list.cursor";
import {
  SafetyFeedCursorError,
  decodePageToken as decodeSafetyFeedPageToken,
  encodePageToken as encodeSafetyFeedPageToken,
} from "../../src/inventory/safety/inventory-safety-feed.cursor";
import {
  SafetyHistoryCursorError,
  decodeSafetyHistoryCursor,
  encodeSafetyHistoryCursor,
} from "../../src/inventory/safety/safety-history.cursor";
import {
  TrackingIdentityCursorError,
  decodeTrackingIdentityCursor,
  encodeTrackingIdentityCursor,
} from "../../src/inventory/tracking-identity.cursor";
import { ReadDownCursorError, decodeCursor, encodeCursor } from "../../src/catalog/read-down/read-down.cursor";
import {
  InvalidShiftCloseCursorError,
  decodeShiftCloseCursor,
  encodeShiftCloseCursor,
} from "../../src/shift-closes/shift-closes.projections";

const T = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const OTHER_T = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const S = "0190b1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ID = "0190f0e1-d2c3-7b4a-9f8e-7d6c5b4a3f2e";
const AT = "2026-03-04T05:06:07.123456Z";
const ROLLED = "2026-02-31T05:06:07.123456Z";
const DAY = "2026-03-04";

/** The token for this exact JSON text. */
const tok = (text: string): string => Buffer.from(text, "utf8").toString("base64url");
const j = (value: unknown): string => tok(JSON.stringify(value));
const digest = (parts: unknown): string => createHash("sha256").update(JSON.stringify(parts), "utf8").digest("base64url").slice(0, 22);

/** Every refusal shape a JSON cursor must keep refusing. */
const garbage = [["not base64 JSON", "***"], ["empty string", ""], ["not JSON", tok("not json")], ["JSON null", tok("null")], ["a JSON array", tok("[1]")], ["an empty object", tok("{}")]] as const;

describe("devices cursor (golden)", () => {
  const keyset = { rank: 2, expiresAtKey: AT, deviceId: ID };
  const TEXT = `{"k":"devices","t":"${T}","r":2,"e":"${AT}","d":"${ID}"}`;

  it("encodes the exact token, tenant lowercased, key order k t r e d", () => {
    expect(encodeDeviceCursor({ tenantId: T, ...keyset })).toBe(tok(TEXT));
    expect(encodeDeviceCursor({ tenantId: T.toUpperCase(), ...keyset })).toBe(tok(TEXT));
  });
  it("decodes an existing token, tenant in either case", () => {
    expect(decodeDeviceCursor({ tenantId: T, cursor: tok(TEXT) })).toEqual(keyset);
    expect(decodeDeviceCursor({ tenantId: T.toUpperCase(), cursor: tok(TEXT) })).toEqual(keyset);
  });
  it.each([
    ...garbage,
    ["another tenant", tok(TEXT.replace(T, OTHER_T))],
    ["an upper-case id inside the token", tok(TEXT.replace(ID, ID.toUpperCase()))],
    ["a rolled-over instant", tok(TEXT.replace(AT, ROLLED))],
    ["a rank above 3", tok(TEXT.replace('"r":2', '"r":4'))],
    ["an extra key", tok(TEXT.replace(/}$/, ',"x":1}'))],
  ])("refuses %s", (_l, cursor) => {
    expect(() => decodeDeviceCursor({ tenantId: T, cursor })).toThrow(InvalidDeviceCursorError);
  });
  it("keeps its name and message", () => {
    const e = new InvalidDeviceCursorError();
    expect([e.name, e.message]).toEqual(["InvalidDeviceCursorError", "cursor is not a valid continuation token for this operation"]);
  });
});

describe("pairing-codes cursor (golden)", () => {
  const keyset = { createdAtKey: AT, pairingCodeId: ID };
  const TEXT = `{"k":"pairing_codes","t":"${T}","c":"${AT}","i":"${ID}"}`;

  it("encodes the exact token", () => {
    expect(encodePairingCodeCursor({ tenantId: T, ...keyset })).toBe(tok(TEXT));
    expect(encodePairingCodeCursor({ tenantId: T.toUpperCase(), ...keyset })).toBe(tok(TEXT));
  });
  it("decodes an existing token", () => {
    expect(decodePairingCodeCursor({ tenantId: T, cursor: tok(TEXT) })).toEqual(keyset);
    expect(decodePairingCodeCursor({ tenantId: T.toUpperCase(), cursor: tok(TEXT) })).toEqual(keyset);
  });
  it.each([
    ...garbage,
    ["another tenant", tok(TEXT.replace(T, OTHER_T))],
    ["an upper-case id inside the token", tok(TEXT.replace(ID, ID.toUpperCase()))],
    ["a rolled-over instant", tok(TEXT.replace(AT, ROLLED))],
  ])("refuses %s", (_l, cursor) => {
    expect(() => decodePairingCodeCursor({ tenantId: T, cursor })).toThrow(InvalidPairingCodeCursorError);
  });
  it("keeps its name and message", () => {
    const e = new InvalidPairingCodeCursorError();
    expect([e.name, e.message]).toEqual(["InvalidPairingCodeCursorError", "cursor is not a valid continuation token for this operation"]);
  });
});

describe("shift-closes cursor (golden)", () => {
  const keyset = { closedAtKey: AT, shiftId: ID };
  const TEXT = `{"k":"shift_closes","t":"${T}","c":"${AT}","s":"${ID}"}`;

  it("encodes the exact token", () => {
    expect(encodeShiftCloseCursor({ tenantId: T, ...keyset })).toBe(tok(TEXT));
    expect(encodeShiftCloseCursor({ tenantId: T.toUpperCase(), ...keyset })).toBe(tok(TEXT));
  });
  it("decodes an existing token", () => {
    expect(decodeShiftCloseCursor({ tenantId: T, cursor: tok(TEXT) })).toEqual(keyset);
    expect(decodeShiftCloseCursor({ tenantId: T.toUpperCase(), cursor: tok(TEXT) })).toEqual(keyset);
  });
  it.each([
    ...garbage,
    ["another tenant", tok(TEXT.replace(T, OTHER_T))],
    ["an upper-case id inside the token", tok(TEXT.replace(ID, ID.toUpperCase()))],
    ["a rolled-over instant", tok(TEXT.replace(AT, ROLLED))],
  ])("refuses %s", (_l, cursor) => {
    expect(() => decodeShiftCloseCursor({ tenantId: T, cursor })).toThrow(InvalidShiftCloseCursorError);
  });
  it("keeps its name and message", () => {
    const e = new InvalidShiftCloseCursorError();
    expect([e.name, e.message]).toEqual(["InvalidShiftCloseCursorError", "cursor is not a valid continuation token for this operation"]);
  });
});

describe("cash-variance policy cursor (golden)", () => {
  const keyset = { createdAtKey: AT, id: ID };
  const STORE_TEXT = `{"k":"cash_variance_policy_revisions","t":"${T}","s":"${S}","c":"${AT}","i":"${ID}"}`;
  const DEFAULT_TEXT = `{"k":"cash_variance_policy_revisions","t":"${T}","s":null,"c":"${AT}","i":"${ID}"}`;

  it("encodes the exact token for a store list and for the tenant default", () => {
    expect(encodePolicyCursor({ tenantId: T, storeId: S }, keyset)).toBe(tok(STORE_TEXT));
    expect(encodePolicyCursor({ tenantId: T.toUpperCase(), storeId: S.toUpperCase() }, keyset)).toBe(tok(STORE_TEXT));
    expect(encodePolicyCursor({ tenantId: T, storeId: null }, keyset)).toBe(tok(DEFAULT_TEXT));
  });
  it("decodes an existing token for exactly its list", () => {
    expect(decodePolicyCursor({ tenantId: T, storeId: S }, tok(STORE_TEXT))).toEqual(keyset);
    expect(decodePolicyCursor({ tenantId: T.toUpperCase(), storeId: S.toUpperCase() }, tok(STORE_TEXT))).toEqual(keyset);
    expect(decodePolicyCursor({ tenantId: T, storeId: null }, tok(DEFAULT_TEXT))).toEqual(keyset);
  });
  it.each([
    ...garbage,
    ["another tenant", tok(STORE_TEXT.replace(T, OTHER_T))],
    ["a store token on the default list", tok(STORE_TEXT)],
    ["a rolled-over instant", tok(STORE_TEXT.replace(AT, ROLLED))],
    ["year 0000", tok(STORE_TEXT.replace(AT, "0000-03-04T05:06:07.123456Z"))],
  ])("refuses %s", (_l, cursor) => {
    expect(() => decodePolicyCursor({ tenantId: T, storeId: null }, cursor)).toThrow(InvalidPolicyCursorError);
  });
  it("refuses a default token on a store list", () => {
    expect(() => decodePolicyCursor({ tenantId: T, storeId: S }, tok(DEFAULT_TEXT))).toThrow(InvalidPolicyCursorError);
  });
  it("keeps its name and message", () => {
    const e = new InvalidPolicyCursorError();
    expect([e.name, e.message]).toEqual(["InvalidPolicyCursorError", "cursor is not a valid continuation token for this operation"]);
  });
});

describe("console sales summary cursor (golden)", () => {
  const binding = { tenantId: T, storeId: S as string | null, from: DAY, to: "2026-03-10", pageSize: 10 };
  const text = (store: string | null) =>
    `{"op":"console_sales_summary","tenant":"${T}","store":${store === null ? "null" : `"${store}"`},"from":"${DAY}","to":"2026-03-10","size":10,"after":"${ID}"}`;

  it("encodes the exact token; the tenant and the after id are lowercased, the store is as bound", () => {
    expect(encodeSalesSummaryCursor(binding, ID)).toBe(tok(text(S)));
    expect(encodeSalesSummaryCursor({ ...binding, tenantId: T.toUpperCase() }, ID.toUpperCase())).toBe(tok(text(S)));
    expect(encodeSalesSummaryCursor({ ...binding, storeId: null }, ID)).toBe(tok(text(null)));
  });
  it("decodes an existing token to the after id", () => {
    expect(decodeSalesSummaryCursor(binding, tok(text(S)))).toBe(ID);
    expect(decodeSalesSummaryCursor({ ...binding, storeId: null }, tok(text(null)))).toBe(ID);
  });
  it.each([
    ...garbage,
    ["another tenant", tok(text(S).replace(T, OTHER_T))],
    ["another page size", tok(text(S).replace('"size":10', '"size":20'))],
    ["another range", tok(text(S).replace(DAY, "2026-03-05"))],
    ["a different key order", tok(`{"tenant":"${T}","op":"console_sales_summary","store":"${S}","from":"${DAY}","to":"2026-03-10","size":10,"after":"${ID}"}`)],
    ["a store token for the all-stores binding", tok(text(S))],
  ])("refuses %s", (_l, cursor) => {
    expect(() => decodeSalesSummaryCursor({ ...binding, storeId: _l.startsWith("a store token") ? null : S }, cursor)).toThrow(InvalidSalesSummaryCursorError);
  });
  it("keeps its name and message", () => {
    const e = new InvalidSalesSummaryCursorError();
    expect([e.name, e.message]).toEqual(["InvalidSalesSummaryCursorError", "cursor is not a valid continuation token for this query"]);
  });
});

describe("console sales cursor (golden)", () => {
  const filters = { from: DAY, to: "2026-03-10", saleNumber: null, syncStatus: null, voided: null, returnState: null, erpPostingState: null };
  const binding = { tenantId: T, storeId: S, filters };
  const keyset = { businessDate: DAY, occurredAtKey: AT, saleId: ID };
  const DIGEST = digest([DAY, "2026-03-10", null, null, null, null, null]);
  const TEXT = `{"op":"console_sales","tenant":"${T}","store":"${S}","digest":"${DIGEST}","date":"${DAY}","at":"${AT}","id":"${ID}"}`;

  it("encodes the exact token", () => {
    expect(encodeConsoleSaleCursor(binding, keyset)).toBe(tok(TEXT));
    expect(encodeConsoleSaleCursor({ ...binding, tenantId: T.toUpperCase(), storeId: S.toUpperCase() }, keyset)).toBe(tok(TEXT));
  });
  it("decodes an existing token", () => {
    expect(decodeConsoleSaleCursor(binding, tok(TEXT))).toEqual(keyset);
    expect(decodeConsoleSaleCursor({ ...binding, tenantId: T.toUpperCase() }, tok(TEXT))).toEqual(keyset);
  });
  it.each([
    ...garbage,
    ["another tenant", tok(TEXT.replace(T, OTHER_T))],
    ["another store", tok(TEXT.replace(S, ID))],
    ["other filters", tok(TEXT.replace(DIGEST, digest(["x"])))],
    ["a rolled-over instant", tok(TEXT.replace(AT, ROLLED))],
    ["year 0000", tok(TEXT.replace(AT, "0000-03-04T05:06:07.123456Z"))],
    ["an impossible business date", tok(TEXT.replace(`"date":"${DAY}"`, '"date":"2026-02-31"'))],
    ["an upper-case id inside the token", tok(TEXT.replace(ID, ID.toUpperCase()))],
  ])("refuses %s", (_l, cursor) => {
    expect(() => decodeConsoleSaleCursor(binding, cursor)).toThrow(InvalidConsoleSaleCursorError);
  });
  it("keeps its name and message", () => {
    const e = new InvalidConsoleSaleCursorError();
    expect([e.name, e.message]).toEqual(["InvalidConsoleSaleCursorError", "cursor is not a valid continuation token for this query"]);
  });
});

describe("sale-history cursor (golden)", () => {
  const filters = { from: DAY, to: "2026-03-10", deviceRef: null, operatorUserId: null, saleNumber: null };
  const scope = { tenantId: T, storeId: S, filters };
  const keyset = { businessDate: DAY, occurredAtKey: AT, saleId: ID };
  const DIGEST = digest([DAY, "2026-03-10", null, null, null]);
  const TEXT = `{"k":"sale_history","t":"${T}","s":"${S}","f":"${DIGEST}","d":"${DAY}","o":"${AT}","i":"${ID}"}`;

  it("encodes the exact token", () => {
    expect(encodeSaleHistoryCursor({ ...scope, keyset })).toBe(tok(TEXT));
    expect(encodeSaleHistoryCursor({ ...scope, tenantId: T.toUpperCase(), storeId: S.toUpperCase(), keyset })).toBe(tok(TEXT));
  });
  it("decodes an existing token", () => {
    expect(decodeSaleHistoryCursor({ ...scope, cursor: tok(TEXT) })).toEqual(keyset);
    expect(decodeSaleHistoryCursor({ ...scope, tenantId: T.toUpperCase(), cursor: tok(TEXT) })).toEqual(keyset);
  });
  it.each([
    ...garbage,
    ["another tenant", tok(TEXT.replace(T, OTHER_T))],
    ["another store", tok(TEXT.replace(S, ID))],
    ["other filters", tok(TEXT.replace(DIGEST, digest(["x"])))],
    ["a rolled-over instant", tok(TEXT.replace(AT, ROLLED))],
    ["an upper-case id inside the token", tok(TEXT.replace(ID, ID.toUpperCase()))],
  ])("refuses %s", (_l, cursor) => {
    expect(() => decodeSaleHistoryCursor({ ...scope, cursor })).toThrow(InvalidSaleHistoryCursorError);
  });
  it("keeps its name and message", () => {
    const e = new InvalidSaleHistoryCursorError();
    expect([e.name, e.message]).toEqual(["InvalidSaleHistoryCursorError", "cursor is not a valid continuation token for this query"]);
  });
});

describe("pos-payers cursor (golden)", () => {
  const scope = { tenantId: T, storeId: S, category: null };
  const TEXT = `{"k":"pos_payers","t":"${T}","s":"${S}","c":null,"i":"${ID}"}`;

  it("encodes the exact token, ids lowercased", () => {
    expect(encodePosPayersCursor({ ...scope, lastPayerRef: ID })).toBe(tok(TEXT));
    expect(encodePosPayersCursor({ tenantId: T.toUpperCase(), storeId: S.toUpperCase(), category: null, lastPayerRef: ID.toUpperCase() })).toBe(tok(TEXT));
  });
  it("decodes an existing token to the last payer ref", () => {
    expect(decodePosPayersCursor({ ...scope, cursor: tok(TEXT) })).toBe(ID);
    expect(decodePosPayersCursor({ ...scope, tenantId: T.toUpperCase(), cursor: tok(TEXT) })).toBe(ID);
  });
  it.each([
    ...garbage,
    ["another tenant", tok(TEXT.replace(T, OTHER_T))],
    ["another store", tok(TEXT.replace(S, ID))],
    ["another category", tok(TEXT.replace('"c":null', '"c":"nonsense"'))],
    ["an upper-case id inside the token", tok(TEXT.replace(ID, ID.toUpperCase()))],
  ])("refuses %s", (_l, cursor) => {
    expect(() => decodePosPayersCursor({ ...scope, cursor })).toThrow(InvalidPosPayersCursorError);
  });
  it("keeps its name and message", () => {
    const e = new InvalidPosPayersCursorError();
    expect([e.name, e.message]).toEqual(["InvalidPosPayersCursorError", "cursor is not a valid continuation token for this query"]);
  });
});

describe("stock movement cursor (golden)", () => {
  const binding = { tenantId: T, storeId: S, productId: null, scope: "all" as const };
  const keyset = { occurredAtKey: AT, id: ID };
  const DIGEST = digest([null, "all"]);
  const TEXT = `{"op":"stock_movements","tenant":"${T}","store":"${S}","digest":"${DIGEST}","at":"${AT}","id":"${ID}"}`;

  it("encodes the exact token", () => {
    expect(encodeStockMovementCursor(binding, keyset)).toBe(tok(TEXT));
    expect(encodeStockMovementCursor({ ...binding, tenantId: T.toUpperCase(), storeId: S.toUpperCase() }, { occurredAtKey: AT, id: ID.toUpperCase() })).toBe(tok(TEXT));
  });
  it("decodes an existing token", () => {
    expect(decodeStockMovementCursor(binding, tok(TEXT))).toEqual(keyset);
  });
  it.each([
    ...garbage,
    ["another tenant", tok(TEXT.replace(T, OTHER_T))],
    ["another store", tok(TEXT.replace(S, ID))],
    ["another scope", tok(TEXT.replace(DIGEST, digest([null, "adhoc"])))],
    ["a rolled-over instant", tok(TEXT.replace(AT, ROLLED))],
  ])("refuses %s", (_l, cursor) => {
    expect(() => decodeStockMovementCursor(binding, cursor)).toThrow(StockMovementCursorError);
  });
  it("keeps its name and message", () => {
    const e = new StockMovementCursorError();
    expect([e.name, e.message]).toEqual(["StockMovementCursorError", "cursor is not a valid continuation token for this query"]);
  });
});

describe("safety-history cursor (golden)", () => {
  const binding = { op: "tracking_holds" as const, tenantId: T, filters: [S, null] as const };
  const keyset = { atKey: AT, id: ID };
  const DIGEST = digest([S, null]);
  const TEXT = `{"op":"tracking_holds","tenant":"${T}","digest":"${DIGEST}","at":"${AT}","id":"${ID}"}`;

  it("encodes the exact token", () => {
    expect(encodeSafetyHistoryCursor(binding, keyset)).toBe(tok(TEXT));
    expect(encodeSafetyHistoryCursor({ ...binding, tenantId: T.toUpperCase(), filters: [S.toUpperCase(), null] }, { atKey: AT, id: ID.toUpperCase() })).toBe(tok(TEXT));
  });
  it("decodes an existing token", () => {
    expect(decodeSafetyHistoryCursor(binding, tok(TEXT))).toEqual(keyset);
  });
  it.each([
    ...garbage,
    ["another tenant", tok(TEXT.replace(T, OTHER_T))],
    ["another operation", tok(TEXT.replace("tracking_holds", "inventory_recalls"))],
    ["other filters", tok(TEXT.replace(DIGEST, digest(["x"])))],
    ["a rolled-over instant", tok(TEXT.replace(AT, ROLLED))],
  ])("refuses %s", (_l, cursor) => {
    expect(() => decodeSafetyHistoryCursor(binding, cursor)).toThrow(SafetyHistoryCursorError);
  });
  it("keeps its name and message", () => {
    const e = new SafetyHistoryCursorError();
    expect([e.name, e.message]).toEqual(["SafetyHistoryCursorError", "cursor is not a valid continuation token for this query"]);
  });
});

describe("console catalog cursor (golden, binary token)", () => {
  const filters = { q: null, status: null, categoryId: null, storeId: null } as never;
  const binding = { tenantId: T, filters };
  const keyset = { matchRank: 1 as const, name: "Tea", productId: ID };

  it("keeps the header bytes: version 1, rank, tenant, product, 16-byte digest, then the name", () => {
    const bytes = Buffer.from(encodeCatalogCursor(binding, keyset), "base64url");
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([1, 1]));
    expect(bytes.subarray(2, 18).toString("hex")).toBe(T.replaceAll("-", ""));
    expect(bytes.subarray(18, 34).toString("hex")).toBe(ID.replaceAll("-", ""));
    expect(bytes.subarray(50).toString("utf8")).toBe("Tea");
    expect(bytes.length).toBe(53);
  });
  it("round-trips, tenant in either case", () => {
    const cursor = encodeCatalogCursor(binding, keyset);
    expect(decodeCatalogCursor(binding, cursor)).toEqual(keyset);
    expect(decodeCatalogCursor({ ...binding, tenantId: T.toUpperCase() }, cursor)).toEqual(keyset);
  });
  it.each([["not base64", "***"], ["too short", tok("ab")], ["empty", ""]])("refuses %s", (_l, cursor) => {
    expect(() => decodeCatalogCursor(binding, cursor)).toThrow(InvalidCatalogCursorError);
  });
  it("refuses another tenant and a non-canonical token", () => {
    const cursor = encodeCatalogCursor(binding, keyset);
    expect(() => decodeCatalogCursor({ ...binding, tenantId: OTHER_T }, cursor)).toThrow(InvalidCatalogCursorError);
    expect(() => decodeCatalogCursor(binding, `${cursor}=`)).toThrow(InvalidCatalogCursorError);
  });
  it("keeps its name and message", () => {
    const e = new InvalidCatalogCursorError();
    expect([e.name, e.message]).toEqual(["InvalidCatalogCursorError", "cursor is not a valid continuation token for this query"]);
  });
});

describe("negative-on-hand cursors (golden)", () => {
  const STORE_TEXT = `{"k":"s","t":"${T}","s":"${S}"}`;
  const entry = { quantity: "-1.5", name: "Tea", ordinal: 3 } as never;
  const ITEM_TEXT = `{"k":"i","t":"${T}","st":"${S}","q":"-1.5","n":"Tea","o":3}`;
  const scope = { tenantId: T, storeId: S };

  it("encodes the exact tokens; ids are written as given, not lowercased", () => {
    expect(encodeStoreCursor({ tenantId: T, storeId: S })).toBe(tok(STORE_TEXT));
    expect(encodeStoreCursor({ tenantId: T.toUpperCase(), storeId: S })).toBe(tok(STORE_TEXT.replace(T, T.toUpperCase())));
    expect(encodeItemCursor({ ...scope, entry })).toBe(tok(ITEM_TEXT));
  });
  it("decodes an existing store token; the tenant compares case-insensitively; the id comes back lowercased", () => {
    expect(decodeStoreCursor({ tenantId: T, cursor: tok(STORE_TEXT) })).toBe(S);
    expect(decodeStoreCursor({ tenantId: T.toUpperCase(), cursor: tok(STORE_TEXT) })).toBe(S);
    expect(decodeStoreCursor({ tenantId: T, cursor: tok(STORE_TEXT.replace(S, S.toUpperCase())) })).toBe(S);
  });
  it("decodes an existing item token", () => {
    expect(decodeItemCursor({ ...scope, cursor: tok(ITEM_TEXT) })).toEqual({ scaled: expect.any(BigInt), name: "Tea", ordinal: 3 });
    expect(decodeItemCursor({ tenantId: T.toUpperCase(), storeId: S.toUpperCase(), cursor: tok(ITEM_TEXT) }).ordinal).toBe(3);
  });
  it.each([
    ...garbage,
    ["another tenant", tok(STORE_TEXT.replace(T, OTHER_T))],
    ["an item token", tok(ITEM_TEXT)],
  ])("refuses %s as a store cursor", (_l, cursor) => {
    expect(() => decodeStoreCursor({ tenantId: T, cursor })).toThrow(InvalidNegativeOnHandCursorError);
  });
  it.each([
    ...garbage,
    ["another tenant", tok(ITEM_TEXT.replace(T, OTHER_T))],
    ["another store", tok(ITEM_TEXT.replace(S, ID))],
    ["a store token", tok(STORE_TEXT)],
  ])("refuses %s as an item cursor", (_l, cursor) => {
    expect(() => decodeItemCursor({ ...scope, cursor })).toThrow(InvalidNegativeOnHandCursorError);
  });
  it("keeps its name and message", () => {
    const e = new InvalidNegativeOnHandCursorError();
    expect([e.name, e.message]).toEqual(["InvalidCursorError", "cursor is not a valid continuation token for this operation"]);
  });
});

describe("read-down snapshot cursor (golden)", () => {
  const TEXT = `{"t":"${T}","s":"${S}","q":"12345678901234567890"}`;
  it("encodes the exact token, ids as given", () => {
    expect(encodeCursor({ tenantId: T, storeId: S, sequence: "12345678901234567890" })).toBe(tok(TEXT));
  });
  it("decodes an existing token", () => {
    expect(decodeCursor(tok(TEXT), T, S)).toEqual({ tenantId: T, storeId: S, sequence: "12345678901234567890" });
  });
  it.each([
    ["not base64 JSON", "***", "malformed cursor"],
    ["not JSON", tok("not json"), "malformed cursor"],
    ["JSON null", tok("null"), "malformed cursor"],
    ["a JSON array", tok("[1]"), "malformed cursor"],
    ["another tenant", tok(TEXT.replace(T, OTHER_T)), "cursor scope mismatch"],
    ["a numeric sequence", tok(`{"t":"${T}","s":"${S}","q":5}`), "cursor scope mismatch"],
    ["a non-digit sequence", tok(`{"t":"${T}","s":"${S}","q":"1x"}`), "cursor scope mismatch"],
  ])("refuses %s with its own message", (_l, cursor, message) => {
    expect(() => decodeCursor(cursor, T, S)).toThrow(ReadDownCursorError);
    expect(() => decodeCursor(cursor, T, S)).toThrow(message);
  });
});

describe("inventory safety feed page token (golden)", () => {
  const TEXT = `{"t":"${T}","s":"${S}","r":7,"a":"${ID}"}`;
  it("encodes the exact token", () => {
    expect(encodeSafetyFeedPageToken({ tenantId: T, storeId: S, revision: 7, afterHoldId: ID })).toBe(tok(TEXT));
  });
  it("decodes an existing token, accepting an upper-case hold id as before", () => {
    expect(decodeSafetyFeedPageToken(tok(TEXT), T, S)).toEqual({ tenantId: T, storeId: S, revision: 7, afterHoldId: ID });
    expect(decodeSafetyFeedPageToken(tok(TEXT.replace(ID, ID.toUpperCase())), T, S).afterHoldId).toBe(ID.toUpperCase());
  });
  it.each([
    ["not base64 JSON", "***", "malformed page token"],
    ["JSON null", tok("null"), "malformed page token"],
    ["another tenant", tok(TEXT.replace(T, OTHER_T)), "page token scope mismatch"],
    ["a negative revision", tok(TEXT.replace('"r":7', '"r":-1')), "malformed page token"],
    ["a fractional revision", tok(TEXT.replace('"r":7', '"r":1.5')), "malformed page token"],
    ["a non-UUID hold id", tok(TEXT.replace(ID, "nope")), "malformed page token"],
  ])("refuses %s with its own message", (_l, token, message) => {
    expect(() => decodeSafetyFeedPageToken(token, T, S)).toThrow(SafetyFeedCursorError);
    expect(() => decodeSafetyFeedPageToken(token, T, S)).toThrow(message);
  });
});

describe("tracking-identity cursor (golden)", () => {
  const cursor = { productId: ID, kind: "batch", expiry: DAY, code: "B-1", id: S };
  const TEXT = `{"p":"${ID}","k":"batch","e":"${DAY}","c":"B-1","i":"${S}"}`;
  it("encodes the exact token, product lowercased", () => {
    expect(encodeTrackingIdentityCursor(cursor)).toBe(tok(TEXT));
    expect(encodeTrackingIdentityCursor({ ...cursor, productId: ID.toUpperCase() })).toBe(tok(TEXT));
  });
  it("decodes an existing token, product in either case", () => {
    expect(decodeTrackingIdentityCursor(tok(TEXT), ID)).toEqual(cursor);
    expect(decodeTrackingIdentityCursor(tok(TEXT), ID.toUpperCase())).toEqual(cursor);
  });
  it.each([
    ...garbage,
    ["another product", tok(TEXT.replace(ID, S))],
    ["an upper-case product in the token", tok(TEXT.replace(ID, ID.toUpperCase()))],
    ["an impossible expiry", tok(TEXT.replace(DAY, "2026-02-31"))],
    ["another kind", tok(TEXT.replace("batch", "lot"))],
  ])("refuses %s with malformed cursor", (_l, token) => {
    expect(() => decodeTrackingIdentityCursor(token, ID)).toThrow(TrackingIdentityCursorError);
    expect(() => decodeTrackingIdentityCursor(token, ID)).toThrow("malformed cursor");
  });
});
