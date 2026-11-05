/**
 * RT-1224 — golden `payload_hash` vectors for sale capture.
 *
 * `SalesService.captureSale` stores `sha256CanonicalHex(body)` of the hashed
 * sale facts (the controller has already dropped `operatorUserId`,
 * `admissionCheckAt` and `receipt`). A provenance replay is compared against
 * those stored bytes (RT-1206), so they must never change when the capture
 * path is restructured.
 *
 * The hex values were captured from main at 6c76cf941 (before the RT-1224
 * decomposition) and are pinned as literals: never recompute them from the
 * code under test. Every vector is a body the capture schema accepts (the
 * golden unit spec checks it). The characterization matrix
 * (`capture/capture-characterization.spec.ts`) posts the plain, tenders and
 * credit vectors and checks the stored `payload_hash` column against the same
 * literals end to end; the sourceClockAt vector is pinned at the hash level
 * only.
 */

/** Pinned for every vector so the hash does not depend on the clock. */
export const GOLDEN_OCCURRED_AT = "2026-05-01T22:30:00.000Z";

const LINE_WIDGET = {
  lineName: "Widget",
  unitPrice: "5.0000",
  currencyCode: "USD",
  quantity: "1",
  lineAmount: "5.0000",
  unit: "ea",
} as const;

const LINE_GADGET = {
  lineName: "Gadget",
  unitPrice: "7.5000",
  currencyCode: "USD",
  quantity: "1",
  lineAmount: "7.5000",
  unit: "ea",
  taxAmount: "0.7500",
} as const;

/** The common sale facts; each vector adds or overrides its own fields. */
function base(externalId: string): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId,
    currencyCode: "USD",
    posTotal: "12.5000",
    occurredAt: GOLDEN_OCCURRED_AT,
    lines: [LINE_WIDGET, LINE_GADGET],
  };
}

export interface CaptureHashVector {
  readonly name: string;
  /** The hashed sale facts (no claim, no window instant, no receipt). */
  readonly body: Readonly<Record<string, unknown>>;
  readonly sha256Hex: string;
}

/** The credit payer the characterization spec seeds for the responsibility vector. */
export const GOLDEN_PAYER_REF = "0a000000-0000-7000-8000-0000012240a1";

const TENDER_REF_CASH = "0a000000-0000-7000-8000-0000012240b1";
const TENDER_REF_CARD = "0a000000-0000-7000-8000-0000012240b2";

export const CAPTURE_HASH_VECTORS: ReadonlyArray<CaptureHashVector> = [
  {
    name: "no tenders (tender-unknown sale)",
    body: base("rt1224-gold-plain"),
    sha256Hex: "fdc262b1a3d78894e2c4a69702bb0e9fea62378c0fbd5b201a9f40076637dd6e",
  },
  {
    name: "with sourceClockAt",
    body: { ...base("rt1224-gold-clock"), sourceClockAt: "2026-05-01T22:29:58.000Z" },
    sha256Hex: "93faaa8e3de9d08763651e649493a931c643b5c159b4b5e40a7cee437960ddac",
  },
  {
    name: "split cash + card tenders with reference, tenderRef and sequence",
    body: {
      ...base("rt1224-gold-tenders"),
      tenders: [
        { method: "cash", amount: "2.5", tenderRef: TENDER_REF_CASH, sequence: 1 },
        { method: "card_external", amount: "10.0000", reference: "A1224", tenderRef: TENDER_REF_CARD, sequence: 2 },
      ],
    },
    sha256Hex: "3e7defa1d21a63f3a98693505d96d3a846d381b7d0834d5e545b42af6886277b",
  },
  {
    name: "cash + credit responsibility",
    body: {
      ...base("rt1224-gold-credit"),
      tenders: [{ method: "cash", amount: "2.5" }],
      responsibilities: [{ payerRef: GOLDEN_PAYER_REF, amount: "10", sequence: 1 }],
    },
    sha256Hex: "353068793e4560dc024c6f43b37254677f1cad717b81b18a17d2d976787024aa",
  },
];

/** The vector named `name`; throws when it is missing so a typo fails loudly. */
export function goldenVector(name: string): CaptureHashVector {
  const v = CAPTURE_HASH_VECTORS.find((x) => x.name === name);
  if (!v) throw new Error(`no golden capture vector named ${name}`);
  return v;
}
