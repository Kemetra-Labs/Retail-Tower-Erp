import type { Messages } from "../types";

/**
 * Arabic copy for the Overview landing (RT-559, spec 009). The page links to
 * the screens that own the work; it never acts. Counts are noun-first
 * («الأصناف: 11») and a count read from one page of a longer list says
 * «أو أكثر», never a total. Snapshot words reuse the stock screen's copy
 * (`stock.*`), so «غير معروف» stays the shipped RT-178 wording.
 */
export const overview = {
  "overview.refresh": "تحديث",
  "overview.refreshing": "جارٍ التحديث…",

  // --- Attention ledger (P-1…P-4) --------------------------------------------
  "overview.attention.title": "ما يحتاج إلى متابعتك",
  "overview.attention.nothingForRole": "لا توجد عناصر متابعة متاحة لدورك في هذا النطاق.",
  "overview.count.exact": "{noun}: {count}",
  "overview.count.atLeast": "{noun}: {count} أو أكثر",
  "overview.count.none": "لا يوجد",
  "overview.count.unproven": "في القائمة المزيد للمراجعة",
  "overview.row.loading": "جارٍ التحميل…",
  "overview.row.failed": "تعذّر التحميل.",
  "overview.row.retry": "إعادة المحاولة",

  "overview.stock.label": "فروقات المخزون · {store}",
  "overview.stock.noun": "الأصناف السالبة",
  "overview.stock.asOf": "بتاريخ {asOf}",
  "overview.stock.open": "عرض فروقات المتجر",
  "overview.stock.none": "لا توجد متاجر لعرض فروقاتها.",
  "overview.stock.labelAll": "فروقات المخزون",
  "overview.stock.more": "بعض المتاجر لم تُعرض هنا. افتح فروقات المخزون لعرضها كلها.",
  "overview.stock.openAll": "عرض الفروقات كاملة",

  "overview.shift.label": "فروقات إقفال الورديات بلا معتمِد مسجَّل (آخر 7 أيام)",
  "overview.shift.noun": "الإقفالات",
  "overview.shift.open": "مراجعة الإقفالات",

  "overview.unknown.label": "أصناف غير معروفة بانتظار المراجعة",
  "overview.unknown.noun": "الأصناف",
  "overview.unknown.open": "مراجعة الأصناف",

  // --- Overview v2 (RT-970) ---------------------------------------------------
  "overview.unavailable": "غير متاح",
  "overview.panel.failed": "تعذّر تحميل هذا الجزء. لم يتغيّر شيء.",
  "overview.panel.retry": "إعادة المحاولة",

  "overview.kpi.label": "مؤشرات اليوم حتى الآن",
  "overview.kpi.transactions": "العمليات",
  "overview.kpi.soFar": "حتى الآن · {date}",
  "overview.kpi.compareNote": "يُقارَن اليوم حتى الآن بيوم العمل السابق كاملًا.",
  "overview.kpi.up": "أعلى من يوم العمل السابق كاملًا ({value})",
  "overview.kpi.down": "أقل من يوم العمل السابق كاملًا ({value})",
  "overview.kpi.same": "مثل يوم العمل السابق كاملًا ({value})",
  "overview.kpi.previousUnknown": "يوم العمل السابق: غير متاح",
  "overview.kpi.mixed":
    "المتاجر في أيام عمل مختلفة، فلا يوجد «اليوم» واحد للنطاق. اختر متجرًا، أو افتح المبيعات اليومية.",
  "overview.kpi.none": "لا توجد متاجر في هذا النطاق.",

  "overview.pipeline.label": "مسار البيع من الكاشير إلى ERPNext",
  "overview.pipeline.pos": "نقاط البيع",
  "overview.pipeline.devices": "الأجهزة الموثوقة: {count}",
  "overview.pipeline.devicesAtLeast": "الأجهزة الموثوقة: {count} أو أكثر",
  "overview.pipeline.posNote": "لا يُسجَّل آخر نشاط للجهاز، فلا يُعرض اتصاله.",
  "overview.pipeline.server": "استلمها الخادم",
  "overview.pipeline.received": "عمليات اليوم: {count}",
  "overview.pipeline.asOf": "حتى {asOf}",
  "overview.pipeline.erp": "الترحيل إلى ERPNext",
  "overview.pipeline.posted": "مُرحَّلة: {posted} من {received}",
  "overview.pipeline.openDevices": "عرض الأجهزة",
  "overview.pipeline.openSales": "عرض المبيعات",
  "overview.pipeline.openRepair": "إصلاح المبيعات",
  "overview.pipeline.openConnection": "حالة الربط",

  "overview.trend.title": "المبيعات المستلمة، آخر 14 يوم عمل",
  "overview.trend.view": "طريقة العرض",
  "overview.trend.chart": "رسم",
  "overview.trend.table": "جدول",
  "overview.trend.summary":
    "أعمدة المبيعات المستلمة بعملة {currency} لكل يوم عمل. الجدول يعرض الأرقام نفسها.",
  "overview.trend.colDay": "يوم العمل",
  "overview.trend.colSales": "المبيعات المستلمة ({currency})",
  "overview.trend.colCount": "العمليات",
  "overview.trend.colState": "الحالة",
  "overview.trend.empty": "لا مبيعات مستلمة في هذه الأيام.",

  "overview.recent.title": "آخر العمليات",
  "overview.recent.all": "كل المبيعات",
  "overview.recent.needsStore": "اختر متجرًا من مُبدِّل النطاق لعرض آخر عملياته.",
  "overview.recent.none": "لا مبيعات مستلمة لهذا المتجر في آخر 31 يوم عمل.",
} satisfies Messages;
