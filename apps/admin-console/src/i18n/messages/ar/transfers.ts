/**
 * Arabic copy for the read-only shipment-Transfer views (RT-1515, PR 1): the
 * list inside the Inventory section and one Transfer's drawer.
 *
 * Glossary: shipment Transfer → «تحويل» (list: «تحويلات المخزون»); In Transit →
 * «قيد النقل» (a quantity of the line, never a location or a status); Store →
 * «المتجر», never «الفرع»; Retail Item → «الصنف». Traps: no plain «المخزون» as a
 * figure, and no Available-to-Sell figure (none exists yet). The 404 while the
 * workflow is off is non-disclosing: say "not available", never claim why.
 */
export const transfers = {
  "transfers.entry": "تحويلات المخزون بين المتاجر",
  "transfers.title": "تحويلات المخزون",
  "transfers.sub": "تحويلات البضاعة بين متاجر المؤسسة، الأحدث أولًا.",
  "transfers.note.readOnly": "عرض للقراءة فقط. لا يُنشأ هنا أي تحويل ولا يُعتمد ولا يُشحن ولا يُستلم.",
  "transfers.note.inTransit":
    "الكمية «قيد النقل» كمية في سطر التحويل، وليست موقع تخزين ولا حالة مخزون.",

  "transfers.value.unknown": "غير معروف",
  "transfers.value.none": "—",
  "transfers.notFound": "هذا التحويل غير متاح.",
  "transfers.notAvailable": "تحويلات المخزون غير متاحة لهذه المؤسسة.",
  "transfers.notAvailable.hint":
    "قد لا تكون التحويلات مفعّلة للمؤسسة بعد. يفعّلها المالك أو مسؤول المؤسسة عند جاهزيتها.",
  "transfers.notAvailable.filtered":
    "قد لا تكون التحويلات مفعّلة للمؤسسة، أو أن المتجر المختار غير متاح لك. أعد ضبط عوامل التصفية.",
  "transfers.route": "من {source} إلى {destination}",

  "transfers.state.draft": "مسودة",
  "transfers.state.approved": "معتمد",
  "transfers.state.in_transit": "قيد النقل",
  "transfers.state.partially_received": "مستلم جزئيًا",
  "transfers.state.received": "مستلم",
  "transfers.state.closed": "مغلق",
  "transfers.state.cancelled": "ملغى",

  "transfers.leg.not_posted": "لم يُرحَّل بعد",
  "transfers.leg.pending": "قيد الترحيل",
  "transfers.leg.confirmed": "أكّده ERPNext",
  "transfers.leg.rejected": "رفضه ERPNext",
  "transfers.leg.reconciliation_required": "تحتاج إلى مطابقة",
  "transfers.leg.notDispatched": "لم يُشحن بعد",

  "transfers.filter.legend": "تصفية التحويلات",
  "transfers.filter.store": "المتجر",
  "transfers.filter.store.all": "كل المتاجر",
  "transfers.filter.direction": "الاتجاه",
  "transfers.filter.direction.any": "صادر ووارد",
  "transfers.filter.direction.outbound": "صادر من المتجر",
  "transfers.filter.direction.inbound": "وارد إلى المتجر",
  "transfers.filter.state": "الحالة",
  "transfers.filter.state.all": "كل الحالات",
  "transfers.filter.reset": "إعادة ضبط عوامل التصفية",

  "transfers.list.title": "التحويلات",
  "transfers.list.caption": "تحويلات المخزون، الأحدث أولًا",
  "transfers.list.col.created": "وقت الإنشاء",
  "transfers.list.col.route": "المسار",
  "transfers.list.col.state": "الحالة",
  "transfers.list.col.lines": "الأسطر",
  "transfers.list.col.receipts": "الاستلامات",
  "transfers.list.col.dispatchErp": "ترحيل الشحن في ERPNext",
  "transfers.list.openHint": "فتح تفاصيل التحويل",
  "transfers.list.loadingNoun": "التحويلات",
  "transfers.list.loadFailed": "تعذّر تحميل التحويلات.",
  "transfers.list.empty": "لا توجد تحويلات مخزون بعد.",
  "transfers.list.emptyFiltered": "لا توجد تحويلات تطابق عوامل التصفية.",
  "transfers.list.loadMore": "تحميل تحويلات أقدم",

  "transfers.detail.title": "تفاصيل التحويل",
  "transfers.detail.loadingNoun": "التحويل",
  "transfers.detail.loadFailed": "تعذّر تحميل التحويل.",
  "transfers.detail.route": "المسار",
  "transfers.detail.state": "الحالة",
  "transfers.detail.createdAt": "أُنشئ",
  "transfers.detail.approvedAt": "اعتُمد",
  "transfers.detail.dispatchedAt": "شُحن",
  "transfers.detail.shortClosedAt": "اعتُمد إغلاق الكمية الناقصة",
  "transfers.detail.closedAt": "أُغلق",
  "transfers.detail.cancelledAt": "أُلغي",
  "transfers.detail.dispatchErp": "ترحيل الشحن في ERPNext",
  "transfers.detail.reason": "السبب",
  "transfers.detail.shortCloseReason": "سبب إغلاق الكمية الناقصة",
  "transfers.detail.cancelReason": "سبب الإلغاء",
  "transfers.detail.id": "مرجع التحويل",

  "transfers.lines.title": "الأسطر",
  "transfers.lines.caption": "أسطر التحويل وكمياتها",
  "transfers.lines.col.seq": "السطر",
  "transfers.lines.col.product": "الصنف",
  "transfers.lines.col.tracking": "هوية التتبع",
  "transfers.lines.col.unit": "الوحدة",
  "transfers.lines.col.ordered": "المطلوب",
  "transfers.lines.col.dispatched": "المشحون",
  "transfers.lines.col.received": "المستلم",
  "transfers.lines.col.shortClosed": "المغلق ناقصًا",
  "transfers.lines.col.inTransit": "قيد النقل",

  "transfers.receipts.title": "الاستلامات",
  "transfers.receipts.caption": "استلامات التحويل، الأقدم أولًا",
  "transfers.receipts.col.receivedAt": "وقت الاستلام",
  "transfers.receipts.col.erp": "ترحيل الاستلام في ERPNext",
  "transfers.receipts.col.line": "السطر",
  "transfers.receipts.col.quantity": "الكمية المستلمة",
  "transfers.receipts.col.status": "حالة المخزون عند الاستلام",
  "transfers.receipts.col.note": "ملاحظة",
  "transfers.receipts.loadingNoun": "الاستلامات",
  "transfers.receipts.loadFailed": "تعذّر تحميل الاستلامات.",
  "transfers.receipts.empty": "لم يُسجَّل أي استلام لهذا التحويل بعد.",
  "transfers.receipts.loadMore": "تحميل استلامات أحدث",
};
