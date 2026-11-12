/**
 * RT-1312 Phase 3(b) (0093) — data-lifecycle classification guard for the
 * POS sale quarantine table (SI-012, Constitution §XIV).
 *
 * `sale_quarantine_items` is BUSINESS-CLASS. Its columns are opaque ids, the
 * sale's provenance, the till's refusal claim (status and machine code),
 * timestamps, a sha256 digest, counters, a minimal summary (time, POS total,
 * currency, line count; decision C5) and the operator's write-off note. The
 * ONE column that may hold money and personal data (line amounts, tenders,
 * payer references, the receipt operator name) is `sale_body`, the capture
 * body stored verbatim, with the decision P3 retention (kept while open or
 * written off, purged 30 days after a capture). The classification prose is
 * recorded in `packages/db/drizzle/0093_sale_quarantine_items.sql`.
 *
 * Docker-FREE introspection guard: it reads the persisted column inventory off
 * the Drizzle table object and asserts it is EXACTLY the recorded allowlist,
 * so a later slice adding, removing or renaming a column fails set-equality and
 * forces a §XIV re-review.
 *
 * `@data-pulse-2/db/schema` resolves to the package's built `dist/`, so build
 * the db package first (`pnpm --filter @data-pulse-2/db build`).
 */
import "reflect-metadata";

import { getTableConfig } from "drizzle-orm/pg-core";

import { saleQuarantineItems } from "@data-pulse-2/db/schema";

function persistedColumns(table: unknown): string[] {
  const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  return cfg.columns.map((c) => (c as unknown as { name: string }).name).sort();
}

const COLUMNS = [
  "id",
  "tenant_id",
  "store_id",
  // Equipment, not customer PII.
  "device_id",
  "previous_terminal_id",
  // Provenance and the till's capture key (audit only).
  "source_system",
  "external_id",
  "idempotency_key",
  // The till's claim: a kind, a status and a machine label, never a message.
  "reason_kind",
  "till_http_status",
  "till_error_code",
  "till_recorded_at",
  "received_at",
  // The capture body: the only money / personal-data column (decision P3 retention).
  "sale_body",
  "body_purged_at",
  "facts_digest",
  // Decision C5: the minimal summary, no line amounts.
  "summary_occurred_at",
  "summary_pos_total",
  "summary_currency_code",
  "summary_line_count",
  "state",
  "resolved_at",
  "repair_count",
  "last_repair_at",
  "last_repair_outcome",
  "last_repair_http_status",
  "last_repair_error_code",
  "upload_conflict_count",
  "sale_id",
  // Free text from a signed-in operator (decision C3); no card data.
  "write_off_note",
  "created_at",
  "updated_at",
];

/** Fragments a separately persisted customer or payment-instrument column would carry. */
const PII_PAYMENT_SUBSTRINGS = [
  "customer",
  "holder",
  "email",
  "phone",
  "address",
  "national_id",
  "first_name",
  "last_name",
  "full_name",
  "birth",
  "tender",
  "payment_method",
  "instrument",
  "card",
  "iban",
  "account_number",
  "cvv",
  "payer",
];

describe("RT-1312 — sale quarantine data-class classification (SI-012 / §XIV)", () => {
  it("persists EXACTLY the recorded business-class columns (tripwire on add/remove/rename)", () => {
    expect(persistedColumns(saleQuarantineItems)).toEqual([...COLUMNS].sort());
  });

  it("persists no separate PII / payment-instrument column (they live only inside sale_body)", () => {
    const offending = persistedColumns(saleQuarantineItems).filter((col) =>
      PII_PAYMENT_SUBSTRINGS.some((frag) => col.toLowerCase().includes(frag)),
    );
    expect(offending).toEqual([]);
  });

  it("keeps the money and personal data in exactly one column, the purgeable body", () => {
    const bodyColumns = persistedColumns(saleQuarantineItems).filter((c) => c.includes("body"));
    expect(bodyColumns).toEqual(["body_purged_at", "sale_body"]);
  });
});
