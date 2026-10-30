import { DEVICE, SALE, SHIFT, STORE, mockRealisticApi } from "./compact-shell-data";
import type { Page } from "./fixtures";
/**
 * RT-961: contract-valid detail bodies for the five detail pages, on top of the
 * realistic shell mock (compact-shell-data). Each carries what the template is
 * meant to show: a sale whose ERP posting failed, with several lines, tenders,
 * change and a return; a shift close with a variance and cash movements; a
 * catalog product with identifiers and a store override.
 */
export { DEVICE, SALE, SHIFT, STORE };
export const PRODUCT = "0190f000-0000-7000-8000-0000000007b1";
const USER = "0190f000-0000-7000-8000-0000000000e1";

function line(n: number, name: string, qty: string, unit: string, amount: string, tax: string) {
  return {
    lineRef: `0190f000-0000-7000-8000-0000000005e${n}`,
    sequence: n,
    lineName: name,
    unitPrice: unit,
    currencyCode: "EGP",
    quantity: qty,
    lineAmount: amount,
    taxAmount: tax,
    unit: "piece",
    returnedQuantity: n === 1 ? "1" : "0",
  };
}

const saleDetail = {
  summary: {
    saleRef: SALE,
    storeRef: STORE,
    saleNumber: "R-0336-CFC-1001",
    businessDate: "2026-10-30",
    occurredAt: "2026-10-30T19:24:00Z",
    receivedAt: "2026-10-30T19:24:03Z",
    device: { deviceRef: null, label: "كاشير المدخل 2", labelSource: "snapshot" },
    operator: { userRef: null, displayName: "كريم عادل", nameSource: "snapshot" },
    currencyCode: "EGP",
    posTotal: "1245.5000",
    syncStatus: "synced",
    voided: false,
    returnState: "partial",
    erpPostingState: "failed",
  },
  storeTimezone: "Africa/Cairo",
  lines: [
    line(1, "مياه معدنية طبيعية 1.5 لتر", "6", "10.0000", "60.0000", "7.3700"),
    line(2, "زيت عباد الشمس 1.8 لتر", "2", "189.7500", "379.5000", "46.6000"),
    line(3, "أرز مصري 5 كجم", "2", "265.0000", "530.0000", "65.0900"),
    line(4, "شاي أسود 250 جم", "4", "69.0000", "276.0000", "33.9000"),
  ],
  lineOrder: "recorded",
  tenderState: "recorded",
  tenders: [
    { method: "cash", amount: "1000.0000", reference: null, sequence: 1 },
    { method: "card_external", amount: "245.5000", reference: "AUTH-7781-0042", sequence: 2 },
  ],
  changeGiven: "0.0000",
  settledAt: "2026-10-30T19:24:00Z",
  receiptNumber: "R-0336-CFC-1001",
  receiptHeader: {
    branchName: "فرع كايرو فستيفال سيتي",
    branchAddress: "التجمع الخامس، القاهرة الجديدة",
    taxRegistrationId: "100-200-300",
  },
  void: null,
  returns: [
    {
      returnRef: "0190f000-0000-7000-8000-0000000005f1",
      recordedAt: "2026-10-30T19:50:00Z",
      businessDate: "2026-10-30",
      returnTotal: "10.0000",
      lines: [
        { lineRef: "0190f000-0000-7000-8000-0000000005e1", quantity: "1", lineAmount: "10.0000" },
      ],
    },
  ],
  erpPosting: {
    sale: "failed",
    saleDocumentRef: null,
    reversal: null,
    reversalDocumentRef: null,
  },
};

const shiftDetail = {
  shiftId: SHIFT,
  storeId: STORE,
  currencyCode: "EGP",
  openedAt: "2026-10-30T06:05:00Z",
  closedAt: "2026-10-30T18:30:00Z",
  closeKind: "normal",
  forcedReason: null,
  openingUserId: USER,
  closingUserId: USER,
  recordedByUserId: USER,
  varianceApprovedByUserId: USER,
  openingFloat: "500.0000",
  cashSalesTotal: "25000.0000",
  cashRefundsTotal: "100.0000",
  payInTotal: "200.0000",
  payOutTotal: "50.0000",
  expectedCash: "25550.0000",
  countedCash: "25525.5000",
  variance: "-24.5000",
  saleCount: 42,
  receivedAt: "2026-10-30T18:31:12Z",
  cashRefundReturnRefs: ["0190f000-0000-7000-8000-0000000005f1"],
  cashMovements: [
    {
      movementId: "0190f000-0000-7000-8000-0000000006a1",
      kind: "pay_in",
      reasonCode: "float_top_up",
      amount: "200.0000",
      note: "تعزيز الفكة من الخزنة",
      occurredAt: "2026-10-30T12:00:00Z",
      receivedAt: "2026-10-30T12:00:02Z",
      recordedByUserId: USER,
    },
    {
      movementId: "0190f000-0000-7000-8000-0000000006a2",
      kind: "pay_out",
      reasonCode: "petty_expense",
      amount: "50.0000",
      note: null,
      occurredAt: "2026-10-30T15:10:00Z",
      receivedAt: "2026-10-30T15:10:02Z",
      recordedByUserId: USER,
    },
  ],
};

const product = {
  summary: {
    productId: PRODUCT,
    name: "مياه معدنية طبيعية 1.5 لتر",
    status: "active",
    categoryId: "0190f000-0000-7000-8000-0000000007c1",
    categoryName: "مشروبات",
    primarySku: "SKU-0042",
    primaryBarcode: "6221007011234",
    defaultPrice: { amount: "10.0000", currencyCode: "EGP" },
    taxCategory: "standard",
    trackingMode: "none",
    updatedAt: "2026-10-07T10:30:00Z",
  },
  description: "مياه معدنية طبيعية، عبوة 1.5 لتر.",
  expiryRequired: false,
  sourceGlobalProductId: null,
  createdAt: "2026-09-01T08:00:00Z",
  identifiers: [
    {
      identifierType: "barcode",
      value: "6221007011234",
      storeId: null,
      sourceSystem: null,
      createdAt: "2026-10-01T08:00:00Z",
    },
    {
      identifierType: "sku",
      value: "SKU-0042",
      storeId: STORE,
      sourceSystem: null,
      createdAt: "2026-10-01T08:00:00Z",
    },
  ],
  storeOverrides: [
    {
      storeId: STORE,
      price: { amount: "12.0000", currencyCode: "EGP" },
      isActive: null,
      taxCategory: null,
      updatedAt: "2026-10-05T09:00:00Z",
    },
  ],
};

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** The realistic shell mock plus the five detail bodies above (later routes win). */
export async function mockDetailTemplate(page: Page): Promise<void> {
  await mockRealisticApi(page);
  await page.route(`**/api/v1/sales/${SALE}`, (r) => r.fulfill(json(saleDetail)));
  await page.route(`**/api/v1/shift-closes/${SHIFT}`, (r) => r.fulfill(json(shiftDetail)));
  await page.route(`**/api/v1/catalog/products/${PRODUCT}`, (r) => r.fulfill(json(product)));
  await page.route("**/api/v1/catalog/categories", (r) => r.fulfill(json({ items: [] })));
}

/** The five detail routes the template applies to. */
export const DETAIL_ROUTES = {
  sale: `/sales/${SALE}`,
  shift: `/shift-closes/${SHIFT}`,
  device: `/devices/${DEVICE}`,
  product: `/catalog/products/${PRODUCT}`,
  store: `/stores/${STORE}`,
} as const;
