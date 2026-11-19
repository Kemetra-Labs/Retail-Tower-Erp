/**
 * RT-1312 Phase 3(b), slice B: the request rules of the Console quarantine
 * routes (`sale-sync-ops/sale-sync-ops.yaml` 1.3.0-draft). Pure, no database.
 */
import {
  QUARANTINE_STATES,
  QuarantineListQuerySchema,
  QuarantineRefSchema,
  QuarantineWriteOffBodySchema,
} from "../../../src/catalog/sale-sync-ops/dto/sale-quarantine-ops.dto";

const V7 = "0190f0f0-0000-7000-8000-00000000c001";

describe("QuarantineListQuerySchema", () => {
  it("accepts an empty query (state defaults to open in the service)", () => {
    expect(QuarantineListQuerySchema.parse({})).toEqual({});
  });

  it("takes the four contract states and nothing else", () => {
    expect(QUARANTINE_STATES).toEqual(["open", "captured", "already-captured", "written-off"]);
    for (const state of QUARANTINE_STATES) expect(QuarantineListQuerySchema.parse({ state })).toEqual({ state });
    expect(QuarantineListQuerySchema.safeParse({ state: "dismissed" }).success).toBe(false);
    expect(QuarantineListQuerySchema.safeParse({ state: "" }).success).toBe(false);
  });

  it("takes a UUIDv7 cursor only", () => {
    expect(QuarantineListQuerySchema.safeParse({ cursor: V7 }).success).toBe(true);
    expect(QuarantineListQuerySchema.safeParse({ cursor: V7.toUpperCase() }).success).toBe(true);
    expect(QuarantineListQuerySchema.safeParse({ cursor: "0190f0f0-0000-4000-8000-00000000c001" }).success).toBe(false);
    expect(QuarantineListQuerySchema.safeParse({ cursor: "not-a-cursor" }).success).toBe(false);
    expect(QuarantineListQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
  });

  it("bounds page_size to 1..200 and coerces the query string", () => {
    expect(QuarantineListQuerySchema.parse({ page_size: "200" })).toEqual({ page_size: 200 });
    expect(QuarantineListQuerySchema.safeParse({ page_size: "0" }).success).toBe(false);
    expect(QuarantineListQuerySchema.safeParse({ page_size: "201" }).success).toBe(false);
    expect(QuarantineListQuerySchema.safeParse({ page_size: "1.5" }).success).toBe(false);
  });

  it("takes a UUID store_id", () => {
    expect(QuarantineListQuerySchema.safeParse({ store_id: V7 }).success).toBe(true);
    expect(QuarantineListQuerySchema.safeParse({ store_id: "store-1" }).success).toBe(false);
  });

  it("rejects an unknown key, so a smuggled tenant_id is a 400", () => {
    expect(QuarantineListQuerySchema.safeParse({ tenant_id: V7 }).success).toBe(false);
  });
});

describe("QuarantineRefSchema", () => {
  it("accepts a UUID and rejects anything else", () => {
    expect(QuarantineRefSchema.safeParse(V7).success).toBe(true);
    expect(QuarantineRefSchema.safeParse("1").success).toBe(false);
    expect(QuarantineRefSchema.safeParse("").success).toBe(false);
  });
});

describe("QuarantineWriteOffBodySchema (decision C3)", () => {
  const note = (value: unknown) => QuarantineWriteOffBodySchema.safeParse({ note: value });

  it("requires a note of 1 to 500 characters", () => {
    expect(note("refunded in cash outside Retail Tower").success).toBe(true);
    expect(note("x").success).toBe(true);
    expect(note("x".repeat(500)).success).toBe(true);
    expect(note("").success).toBe(false);
    expect(note("x".repeat(501)).success).toBe(false);
    expect(QuarantineWriteOffBodySchema.safeParse({}).success).toBe(false);
    expect(note(null).success).toBe(false);
    expect(note(5).success).toBe(false);
  });

  it("counts code points like the contract's maxLength, not UTF-16 units", () => {
    // 500 emoji are 1000 UTF-16 units but 500 characters: valid by the contract.
    expect(note("\u{1F600}".repeat(500)).success).toBe(true);
    expect(note("\u{1F600}".repeat(501)).success).toBe(false);
  });

  it("stores the note as entered (no trimming)", () => {
    expect(QuarantineWriteOffBodySchema.parse({ note: "  padded  " })).toEqual({ note: "  padded  " });
  });

  it("refuses a NUL (Postgres refuses it in text) and a lone surrogate", () => {
    expect(note("a\u0000b").success).toBe(false);
    expect(note("a\uD800b").success).toBe(false);
  });

  it("is closed: no state, tenant or store from the body", () => {
    expect(QuarantineWriteOffBodySchema.safeParse({ note: "ok", state: "captured" }).success).toBe(false);
    expect(QuarantineWriteOffBodySchema.safeParse({ note: "ok", tenant_id: V7 }).success).toBe(false);
    expect(QuarantineWriteOffBodySchema.safeParse({ note: "ok", storeId: V7 }).success).toBe(false);
  });
});
