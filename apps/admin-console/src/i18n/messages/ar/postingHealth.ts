/** النصوص العربية لتقرير صحة الترحيل عبر الأيام. */
export const postingHealth = {
  // --- Band ---------------------------------------------------------------
  "postingHealth.band.subStore": "{store} · {tenant}",
  "postingHealth.band.subScope": "كل متاجر النطاق · {tenant}",
  "postingHealth.band.subTenant": "{tenant}",

  // --- Loading and failure ------------------------------------------------
  "postingHealth.loading": "جارٍ تحميل التقرير…",
  "postingHealth.failed": "تعذّر تحميل التقرير.",
  "postingHealth.retry": "إعادة المحاولة",
  "postingHealth.rateLimited": "طلبات كثيرة جدًا. أعد المحاولة عند انتهاء الانتظار.",
  "postingHealth.rateLimitedHint": "يعرض الشريط أعلى الصفحة وقت الانتظار المتبقي.",

  // --- Table ---------------------------------------------------------------
  "postingHealth.table.caption": "الترحيل حسب اليوم",
  "postingHealth.table.hint":
    "عدد المبيعات المستلمة التي رُحّلت، والعالقة، والمرفوضة نهائيًا، وتلك التي لا صف ترحيل لها — لكل يوم عمل. «غير معروف» لا تعني «لم تُرحَّل».",
  "postingHealth.summary.days": "الأيام المكتملة المنتهية بترحيل كامل: {fully} من {total}.",
  "postingHealth.summary.failures": "أيام مكتملة بها ترحيلات مرفوضة: {days}.",
  "postingHealth.col.day": "اليوم",
  "postingHealth.col.posted": "مُرحَّلة",
  "postingHealth.col.pending": "عالقة",
  "postingHealth.col.failed": "مرفوضة",
  "postingHealth.col.unknown": "بلا صف",
  "postingHealth.col.verdict": "الحكم",
  "postingHealth.row.total": "الإجمالي",
  "postingHealth.row.totalSoFar": "الإجمالي حتى الآن",
  "postingHealth.repairHint": "المبيعات المرفوضة الفردية موجودة في قائمة الإصلاح:",

  // --- Day verdicts --------------------------------------------------------
  "postingHealth.verdict.fullyPosted": "مُرحَّلة بالكامل",
  "postingHealth.verdict.needsAttention": "تحتاج انتباهًا",
  "postingHealth.verdict.unknownRows": "بلا صفوف ترحيل",
  "postingHealth.verdict.noSales": "لا مبيعات",
  "postingHealth.verdict.noData": "غير معروف",
  "postingHealth.verdict.running": "جارٍ",
  "postingHealth.verdict.notBegun": "لم يبدأ",
};
