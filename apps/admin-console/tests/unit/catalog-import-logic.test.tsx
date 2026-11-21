import { ConflictList } from "@/catalog-import/ConflictList";
import {
  canImportCatalog,
  canPublish,
  classifyImport,
  errorKey,
  isZeroEffect,
  issueKey,
  offeredResolutions,
  previewConflicts,
  resolveStep,
  stepAfterValidate,
} from "@/catalog-import/catalogImportLogic";
import { ar } from "@/i18n/messages/ar";
import type {
  CatalogImportBatch,
  CatalogImportPreview,
  CatalogImportRow,
} from "@/lib/catalog-import-queries";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

/**
 * RT-1509: the pure rules of the import workspace. The step is the server's state; a refusal is
 * sorted by status and machine code; the offered resolutions follow the documented rules; the
 * RT-1536 adapter names no conflict until the contract does.
 */
const COUNTS = {
  ready_create: 1,
  ready_update: 0,
  unchanged: 0,
  needs_review: 0,
  error: 0,
  excluded: 0,
};

function batch(over: Partial<CatalogImportBatch>): CatalogImportBatch {
  return {
    batchId: "b",
    state: "draft",
    version: 1,
    mode: "upsert",
    mapping: null,
    counts: null,
    ...over,
  } as CatalogImportBatch;
}

function reviewRow(over: Partial<CatalogImportRow>): CatalogImportRow {
  return {
    rowNumber: 2,
    status: "needs_review",
    reviewReason: "ambiguous",
    resolution: null,
    outcome: { match: "ambiguous", candidates: [{ productId: "p", name: "n", identifiers: [] }] },
    ...over,
  } as CatalogImportRow;
}

describe("the step is the server's state", () => {
  test.each([
    [batch({ state: "draft", mapping: null }), undefined, "map"],
    [batch({ state: "draft", mapping: [] }), undefined, "validate"],
    [batch({ state: "validated" }), undefined, "validate"],
    [batch({ state: "validated" }), "review", "review"],
    [batch({ state: "validated" }), "result", "validate"],
    [batch({ state: "draft", mapping: null }), "preview", "map"],
    [batch({ state: "published" }), "map", "result"],
    [batch({ state: "cancelled" }), "map", null],
    [batch({ state: "expired" }), undefined, null],
  ])("%#: a step the state does not allow falls back to what it does", (b, asked, want) => {
    expect(resolveStep(b, asked)).toBe(want);
  });

  test("validate leads to the review only while rows lack a decision", () => {
    expect(stepAfterValidate({ ...COUNTS, error: 1 })).toBe("review");
    expect(stepAfterValidate({ ...COUNTS, needs_review: 2 })).toBe("review");
    expect(stepAfterValidate(COUNTS)).toBe("preview");
    expect(stepAfterValidate(null)).toBe("preview");
  });

  test("only an owner or a tenant admin gets the entry", () => {
    expect(canImportCatalog("owner")).toBe(true);
    expect(canImportCatalog("tenant_admin")).toBe(true);
    for (const role of ["store_manager", "store_staff", "cashier", null, undefined, ""]) {
      expect(canImportCatalog(role)).toBe(false);
    }
  });
});

describe("answers are sorted by status and machine code", () => {
  test("a 201 is ok and carries the replay flag", () => {
    const out = classifyImport({ status: 201, data: { x: 1 }, replayed: true }, { success: [201] });
    expect(out).toEqual({ kind: "ok", data: { x: 1 }, replayed: true });
  });

  test("no answer, a 5xx and a 425 are unclear; the 425 carries its wait", () => {
    expect(classifyImport({ status: 0 }).kind).toBe("unclear");
    expect(classifyImport({ status: 503 }).kind).toBe("unclear");
    const waiting = classifyImport({
      status: 425,
      error: { error: "idempotency_in_progress", retryAfterSec: 3 },
    });
    expect(waiting).toMatchObject({ kind: "unclear", status: 425, retryAfterSec: 3 });
    const header = classifyImport({ status: 425, retryAfter: "7" });
    expect(header).toMatchObject({ kind: "unclear", retryAfterSec: 7 });
  });

  test("a 429 is unclear only for the actions that are resent as they were", () => {
    expect(classifyImport({ status: 429 }, { resend: true }).kind).toBe("unclear");
    expect(classifyImport({ status: 429 }).kind).toBe("refused");
  });

  test("a refusal carries its code, request id and the open batch id", () => {
    const out = classifyImport({
      status: 409,
      error: { error: { code: "import_batch_open", request_id: "req_1", openBatchId: "ob" } },
    });
    expect(out).toEqual({
      kind: "refused",
      status: 409,
      code: "import_batch_open",
      requestId: "req_1",
      openBatchId: "ob",
    });
  });
});

describe("every code has Arabic copy; the wire text is never used", () => {
  const ISSUES = [
    "required_field_missing",
    "value_invalid",
    "identifier_numeric_cell",
    "identifier_formula_cell",
    "identifier_non_ascii_digits",
    "identifier_invisible_char",
    "formula_without_value",
    "duplicate_in_file",
    "category_not_found",
    "product_retired",
    "already_exists",
    "not_found",
    "ambiguous",
    "no_identifier",
    "sku_mismatch",
    "store_scoped_conflict",
    "possible_duplicate",
    "gtin_check_digit",
    "tax_category_unused",
    "store_scoped_same_product",
    "deactivates_product",
    "price_not_imported",
    "whitespace_trimmed",
    "formula_cached_value",
    "brand_created",
  ];
  const ERRORS = [
    "origin_rejected",
    "validation_error",
    "file_too_large",
    "file_type_unsupported",
    "encoding_not_utf8",
    "file_unreadable",
    "xlsx_limits_exceeded",
    "sheet_not_found",
    "header_missing",
    "no_data_rows",
    "too_many_rows",
    "file_too_many_rows",
    "too_many_columns",
    "cell_too_long",
    "idempotency_key_conflict",
    "import_batch_open",
    "version_conflict",
    "import_batch_closed",
    "import_batch_not_validated",
    "preview_changed",
    "import_not_publishable",
    "stale_validation",
    "mapping_invalid",
    "mapping_required",
    "resolution_not_allowed",
    "idempotency_in_progress",
    "rate_limited",
  ];

  test("each of the 25 row issue codes maps to its own message", () => {
    for (const code of ISSUES) {
      expect(issueKey(code)).toBe(`catalogImport.issue.${code}`);
      expect(ar[issueKey(code)], code).toBeTypeOf("string");
    }
    expect(issueKey("brand_new_code")).toBe("catalogImport.issue.unknown");
  });

  test("each server error code maps to its own message; an unknown one is generic", () => {
    for (const code of ERRORS) {
      expect(errorKey(code, 409)).toBe(`catalogImport.error.${code}`);
      expect(ar[errorKey(code, 409)], code).toBeDefined();
    }
    expect(errorKey("something_new", 409)).toBe("catalogImport.error.unknown");
    expect(errorKey(undefined, 404)).toBe("catalogImport.error.notAvailable");
    expect(errorKey(undefined, 401)).toBe("catalogImport.error.session");
    expect(errorKey(undefined, 0)).toBe("catalogImport.error.generic");
  });
});

describe("what a review row offers", () => {
  test("an error row takes exclude only", () => {
    const row = reviewRow({
      status: "error",
      reviewReason: null,
      outcome: { match: "no_match", candidates: [] } as never,
    });
    expect(offeredResolutions("upsert", row)).toEqual(["exclude"]);
  });

  test("an ambiguous row offers each candidate and exclude, never create", () => {
    expect(offeredResolutions("upsert", reviewRow({}))).toEqual(["update_product", "exclude"]);
    expect(offeredResolutions("create", reviewRow({}))).toEqual(["exclude"]);
  });

  test("a row with no identifier offers create and exclude, and create is never offered in an update batch", () => {
    const row = reviewRow({
      reviewReason: "no_identifier",
      outcome: { match: "no_match", candidates: [] } as never,
    });
    expect(offeredResolutions("upsert", row)).toEqual(["create_new", "exclude"]);
    expect(offeredResolutions("update", row)).toEqual(["exclude"]);
  });

  test("a decided row can also be cleared", () => {
    const decided = reviewRow({
      status: "excluded",
      resolution: { action: "exclude", productId: null, decidedAt: "x" },
    });
    expect(offeredResolutions("upsert", decided)).toContain("clear");
  });
});

describe("the preview", () => {
  const preview = (over: Partial<CatalogImportPreview>) =>
    ({
      publishable: true,
      productsToCreate: 1,
      productsToUpdate: 0,
      identifiersToAdd: 0,
      brandsToCreate: [],
      ...over,
    }) as CatalogImportPreview;

  test("RT-1536 adapter: no conflict is named until the contract names one", () => {
    expect(previewConflicts(preview({}))).toBeNull();
    expect(canPublish(preview({}))).toBe(true);
    expect(canPublish(preview({ publishable: false }))).toBe(false);
  });

  test("a batch with nothing to write is zero effect", () => {
    expect(isZeroEffect(preview({ productsToCreate: 0 }))).toBe(true);
    expect(isZeroEffect(preview({ brandsToCreate: ["x"], productsToCreate: 0 }))).toBe(false);
  });
});

describe("ConflictList renders exactly the conflicts it is given", () => {
  test("a field disagreement and a second SKU, with rows in a table and the way out in text", () => {
    render(
      <ConflictList
        conflicts={[
          {
            productName: "Orange juice",
            sku: "SKU-1001",
            rowNumbers: [14, 212],
            reason: { kind: "field_disagreement", field: "tax_category" },
          },
          { productName: "Milk", sku: null, rowNumbers: [33, 340], reason: { kind: "second_sku" } },
        ]}
      />,
    );
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("Orange juice")).toBeTruthy();
    expect(screen.getByText("14, 212")).toBeTruthy();
    expect(screen.getByText(/Two different values for “Tax category”/)).toBeTruthy();
    expect(screen.getByText(/second SKU/)).toBeTruthy();
    expect(screen.getByText(/one row/)).toBeTruthy();
  });
});
