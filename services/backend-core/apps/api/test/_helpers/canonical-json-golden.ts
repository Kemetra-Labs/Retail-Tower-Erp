/**
 * Shared golden fixture for the canonical-JSON serializers (sonar S2871
 * remediation): the idempotency fingerprint and the sale payload hash both
 * serialize to the same canonical form, so they share one pinned fixture.
 *
 * The expected values were captured from the code BEFORE the explicit
 * comparator was introduced and are pinned here as literals — never recompute
 * them from the code under test.
 */

// Mixed-case, non-ASCII, underscore and integer-like keys. Object.keys yields
// "9" before "10"; code-unit sort must put "10" first.
export const GOLDEN_FIXTURE = {
  b: 1,
  B: 2,
  a: 3,
  "é": 4,
  _: 5,
  "10": 6,
  "9": 7,
  nested: { z: 1, Z: 2 },
};

export const GOLDEN_STRING =
  '{"10":6,"9":7,"B":2,"_":5,"a":3,"b":1,"nested":{"Z":2,"z":1},"é":4}';

export const GOLDEN_SHA256_HEX =
  "93fa82fc5dc408821bae29ddf65c2af4cd77a73a408e9dd9a308a3bbabfb2d87";

// ---------------------------------------------------------------------------
// RT-1214 — settlement-intent request-hash vectors.
//
// `ReceivableService` stores sha256(canonical JSON of the intent) in
// `idempotency_keys.request_hash`; a retry is compared byte-for-byte against
// it. These vectors pin that serializer's exact bytes for representative and
// stored (integration-fixture) intents. The strings were captured from the
// receivable service's private serializer BEFORE it was pointed at the shared
// payload-hash serializer, and are pinned as literals — never recompute them
// from the code under test.
//
// The `rich` vector covers the payload-hash semantics the
// idempotency-interceptor serializer (`idempotency/canonical-json.ts`) does NOT share: an `undefined`
// member is written as `null` (not dropped). The `Date` vector pins that a
// `Date` serializes by its own enumerable keys (`{}`), not as an ISO string.
// ---------------------------------------------------------------------------

const GOLDEN_SALE = "71000000-0000-4000-8000-000000000004";
const GOLDEN_PAYER_A = "71000000-0000-4000-8000-000000000005";
const GOLDEN_PAYER_B = "71000000-0000-4000-8000-000000000008";

export interface ReceivableIntentVector {
  readonly name: string;
  readonly saleRef: string;
  readonly payers: ReadonlyArray<{
    readonly payerRef: string;
    readonly owedAmount: string;
    readonly claimMetadata?: Record<string, unknown> | null;
  }>;
  readonly canonical: string;
  readonly sha256Hex: string;
}

export const RECEIVABLE_INTENT_VECTORS: readonly ReceivableIntentVector[] = [
  {
    name: "stored single-payer intent, claimMetadata absent",
    saleRef: GOLDEN_SALE,
    payers: [{ payerRef: GOLDEN_PAYER_A, owedAmount: "120.00" }],
    canonical:
      '{"payers":[{"claimMetadata":null,"owedAmount":"120.00",' +
      `"payerRef":"${GOLDEN_PAYER_A}"}],"saleRef":"${GOLDEN_SALE}"}`,
    sha256Hex:
      "f99c55680ffd8db4d158ca3a822d8ee1031d49cfb1d217fdcec17a7596f39b70",
  },
  {
    name: "stored split intent keeps payer order",
    saleRef: GOLDEN_SALE,
    payers: [
      { payerRef: GOLDEN_PAYER_A, owedAmount: "70.00" },
      { payerRef: GOLDEN_PAYER_B, owedAmount: "50.00" },
    ],
    canonical:
      '{"payers":[{"claimMetadata":null,"owedAmount":"70.00",' +
      `"payerRef":"${GOLDEN_PAYER_A}"},{"claimMetadata":null,"owedAmount":"50.00",` +
      `"payerRef":"${GOLDEN_PAYER_B}"}],"saleRef":"${GOLDEN_SALE}"}`,
    sha256Hex:
      "f85cacb5d0689e22a2640452b4afdfbc74bea0187d1266d637868e47aa172e41",
  },
  {
    name: "stored intent with claimMetadata",
    saleRef: GOLDEN_SALE,
    payers: [
      {
        payerRef: GOLDEN_PAYER_A,
        owedAmount: "120.00",
        claimMetadata: { policy: "P-1", note: "covered" },
      },
    ],
    canonical:
      '{"payers":[{"claimMetadata":{"note":"covered","policy":"P-1"},' +
      `"owedAmount":"120.00","payerRef":"${GOLDEN_PAYER_A}"}],"saleRef":"${GOLDEN_SALE}"}`,
    sha256Hex:
      "5f9f7914a3b0466007358cd028670dde3979c54f5835386bf56757b14c235160",
  },
  {
    name: "explicit null claimMetadata, four-decimal amount",
    saleRef: GOLDEN_SALE,
    payers: [{ payerRef: GOLDEN_PAYER_A, owedAmount: "50.0000", claimMetadata: null }],
    canonical:
      '{"payers":[{"claimMetadata":null,"owedAmount":"50.0000",' +
      `"payerRef":"${GOLDEN_PAYER_A}"}],"saleRef":"${GOLDEN_SALE}"}`,
    sha256Hex:
      "5d0bc3b8937ddd0ab03e97db7c0a2edd8b9c0a682714477ef8d2b3de07106d5c",
  },
  {
    name: "rich claimMetadata (nesting, unicode, escapes, numbers, undefined)",
    saleRef: GOLDEN_SALE,
    payers: [
      {
        payerRef: GOLDEN_PAYER_A,
        owedAmount: "9.99",
        claimMetadata: {
          z: [3, 1, { b: true, a: false }],
          ar: "تأمين",
          esc: 'say "hi"\n',
          num: 1.5,
          neg: -0,
          big: 1e21,
          empty: {},
          list: [],
          nil: null,
          skip: undefined,
        },
      },
    ],
    canonical:
      '{"payers":[{"claimMetadata":{"ar":"تأمين","big":1e+21,"empty":{},' +
      '"esc":"say \\"hi\\"\\n","list":[],"neg":0,"nil":null,"num":1.5,"skip":null,' +
      '"z":[3,1,{"a":false,"b":true}]},"owedAmount":"9.99",' +
      `"payerRef":"${GOLDEN_PAYER_A}"}],"saleRef":"${GOLDEN_SALE}"}`,
    sha256Hex:
      "c63c59c76655c2121ebc24c7fceb1ec4a852f2fa048635a10405582fbca12fb6",
  },
  {
    name: "Date in claimMetadata serializes as an empty object",
    saleRef: GOLDEN_SALE,
    payers: [{ payerRef: GOLDEN_PAYER_A, owedAmount: "1.00", claimMetadata: { at: new Date(0) } }],
    canonical:
      '{"payers":[{"claimMetadata":{"at":{}},"owedAmount":"1.00",' +
      `"payerRef":"${GOLDEN_PAYER_A}"}],"saleRef":"${GOLDEN_SALE}"}`,
    sha256Hex:
      "3707fe712b56080ad0dc3d0965c7cb01ee8c211d025fa380f7f10cb9664e59a9",
  },
];
