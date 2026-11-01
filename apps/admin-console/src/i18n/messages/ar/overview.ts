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

  "overview.greeting": "مرحبًا، {name}",

  "overview.kpi.label": "مؤشرات اليوم حتى الآن",
  "overview.kpi.transactions": "العمليات",
  "overview.kpi.context": "{scope} · اليوم حتى الآن · {date} · حتى {asOf}",
  "overview.kpi.scopeAll": "كل المتاجر",
  "overview.kpi.compareNote": "يُقارَن اليوم حتى الآن بيوم العمل السابق كاملًا.",
  "overview.kpi.up": "أعلى من يوم العمل السابق كاملًا ({value})",
  "overview.kpi.down": "أقل من يوم العمل السابق كاملًا ({value})",
  "overview.kpi.same": "مثل يوم العمل السابق كاملًا ({value})",
  "overview.kpi.previousUnknown": "يوم العمل السابق: غير متاح",
  "overview.kpi.mixed":
    "المتاجر في أيام عمل مختلفة، فلا يوجد «اليوم» واحد للنطاق. اختر متجرًا، أو افتح المبيعات اليومية.",
  "overview.kpi.none": "لا توجد متاجر في هذا النطاق.",
  "overview.kpi.sparkPeriod": "آخر 14 يوم عمل",
  "overview.kpi.sparkSummary":
    "المبيعات المستلمة بعملة {currency} خلال آخر 14 يوم عمل؛ الفجوات أيام لا تتضمنها القراءة.",

  "overview.pipeline.links": "شاشات مسار البيع",
  "overview.pipeline.devices": "الأجهزة الموثوقة: {count}",
  "overview.pipeline.devicesAtLeast": "الأجهزة الموثوقة: {count} أو أكثر",
  "overview.pipeline.posNote": "لا يُسجَّل آخر نشاط للجهاز، فلا يُعرض اتصاله.",
  "overview.pipeline.received": "عمليات اليوم: {count}",
  "overview.pipeline.posted": "مُرحَّلة: {posted} من {received}",
  "overview.pipeline.openDevices": "عرض الأجهزة",
  "overview.pipeline.openSales": "عرض المبيعات",
  "overview.pipeline.openRepair": "إصلاح المبيعات",
  "overview.pipeline.openConnection": "حالة الربط",

  "overview.trend.title": "المبيعات المستلمة: هذه الفترة مقابل السابقة",
  "overview.trend.question":
    "هل مبيعات أيام هذه الفترة أعلى أم أقل من الأيام نفسها في الفترة السابقة؟",
  "overview.trend.period": "الفترة",
  "overview.trend.days7": "7 أيام",
  "overview.trend.days14": "14 يومًا",
  "overview.trend.view": "طريقة العرض",
  "overview.trend.chart": "رسم",
  "overview.trend.table": "جدول",
  "overview.trend.summary":
    "خطّان للمبيعات المستلمة بعملة {currency}: آخر {days} يوم عمل بخط متصل، و{days} يوم عمل قبلها بخط متقطع. الفجوات أيام لا تتضمنها القراءة، والجدول يعرض الأرقام نفسها.",
  "overview.trend.current": "هذه الفترة",
  "overview.trend.previous": "الفترة السابقة",
  "overview.trend.difference": "الفرق: {value}",
  "overview.trend.colDay": "يوم العمل",
  "overview.trend.colSales": "المبيعات المستلمة ({currency})",
  "overview.trend.colPreviousDay": "اليوم نفسه في الفترة السابقة",
  "overview.trend.colPrevious": "الفترة السابقة ({currency})",
  "overview.trend.colDifference": "الفرق",
  "overview.trend.colState": "الحالة",
  "overview.trend.empty": "لا مبيعات مستلمة في هذه الأيام.",

  "overview.posting.title": "مبيعات اليوم في ERPNext",
  "overview.posting.question": "من مبيعات اليوم المستلمة، كم رحّلها ERPNext؟",
  "overview.posting.summary":
    "حلقة لمبيعات اليوم المستلمة وعددها {received} حسب حالة الترحيل إلى ERPNext. الجدول بجانبها يعرض عدد كل حالة ونسبتها.",
  "overview.posting.caption": "النسبة من {received} مبيعة مستلمة اليوم",
  "overview.posting.colState": "الحالة",
  "overview.posting.colCount": "العدد",
  "overview.posting.colShare": "النسبة",
  "overview.posting.center": "مستلمة اليوم",
  "overview.posting.none": "لم تُستلم مبيعات اليوم بعد.",

  "overview.recent.title": "آخر العمليات",
  "overview.recent.all": "كل المبيعات",
  "overview.recent.needsStore": "اختر متجرًا من مُبدِّل النطاق لعرض آخر عملياته.",
  "overview.recent.none": "لا مبيعات مستلمة لهذا المتجر في آخر 31 يوم عمل.",

  // --- Overview v4 side column (RT-993) ----------------------------------------
  "overview.side.label": "العمود الجانبي للنظرة العامة",
  "overview.quick.title": "إجراءات سريعة",
  "overview.quick.salesDaily": "المبيعات اليومية المستلمة",
  "overview.quick.salesDailyNote": "مبيعات كل يوم عمل حسب المتجر والعملة.",
  "overview.quick.repair": "مبيعات تحتاج إلى إصلاح",
  "overview.quick.repairNote": "مبيعات لم يعالجها الخادم، لإعادة المحاولة أو الإصلاح.",
  "overview.quick.catalog": "كتالوج المؤسسة",
  "overview.quick.catalogNote": "أصناف الكتالوج وأسعارها وباركوداتها.",
  "overview.quick.operators": "المستخدمون",
  "overview.quick.operatorsNote": "أعضاء المؤسسة وأدوارهم.",
  "overview.soon": "قريبًا",
  "overview.stores.title": "المتاجر اليوم",
  "overview.stores.soon": "ستظهر هنا حصة كل متجر من مبيعات اليوم عندما يوفّرها الخادم.",
  "overview.lowStock.title": "مخزون منخفض",
  "overview.lowStock.soon":
    "ستظهر هنا الأصناف التي نزلت عن حد إعادة الطلب، مرتبة حسب الخطورة، عندما يوفّرها الخادم.",
} satisfies Messages;
