/** النصوص العربية لتقرير المبيعات المستلمة اليومي (RT-821، VIZ-3). */
export const salesDaily = {
  // --- Entry and heading -------------------------------------------------------
  "salesDaily.entry": "المبيعات المستلمة يوميًا",
  "salesDaily.title": "المبيعات المستلمة يوميًا",
  "salesDaily.back": "المبيعات",

  // --- Range form --------------------------------------------------------------
  "salesDaily.range.label": "نطاق أيام العمل",
  "salesDaily.range.note": "31 يوم عمل على الأكثر، يشمل يومَي البداية والنهاية.",
  "salesDaily.range.rejected": "رفض الخادم هذا النطاق. استخدم تواريخ صحيحة، 31 يوم عمل على الأكثر.",

  // --- Context -----------------------------------------------------------------
  "salesDaily.context.calendar": "حسب يوم العمل المحلي لكل متجر",
  "salesDaily.context.zonesPartial": {
    zero: "لم تُقرأ مناطق أي متجر",
    one: "مناطق أول متجر فقط؛ لم تُقرأ باقي المتاجر",
    two: "مناطق أول متجرين فقط؛ لم تُقرأ باقي المتاجر",
    few: "مناطق أول {count} متاجر فقط؛ لم تُقرأ باقي المتاجر",
    many: "مناطق أول {count} متجرًا فقط؛ لم تُقرأ باقي المتاجر",
    other: "مناطق أول {count} متجر فقط؛ لم تُقرأ باقي المتاجر",
  },
  "salesDaily.context.soFar":
    "الأيام الموسومة «حتى الآن» لم تنتهِ بعد في متجر واحد على الأقل، والإجمالي يشملها.",

  // --- Tables ------------------------------------------------------------------
  "salesDaily.table.money.caption":
    "المبيعات المستلمة والإلغاءات والمرتجعات والاستردادات القديمة لكل يوم عمل",
  "salesDaily.table.money.hint":
    "كل خانة: العدد، ثم الإجمالي بكل عملة في سطر مستقل. لا تُجمع العملات معًا أبدًا.",
  "salesDaily.table.status.caption":
    "حالة المزامنة وحالة الترحيل إلى ERPNext وإغلاقات الورديات لكل يوم عمل",
  "salesDaily.table.status.hint":
    "حالتا المزامنة والترحيل هما حالة مبيعات ذلك اليوم الآن (وقت القراءة)، لا المتأخرات في ذلك اليوم.",
  "salesDaily.col.day": "يوم العمل",
  "salesDaily.row.notBegun": "(لم يبدأ بعد)",
  "salesDaily.row.total": "إجمالي النطاق",
  "salesDaily.row.totalSoFar": "إجمالي النطاق (يشمل أيامًا حتى الآن)",

  // --- Chart (RT-823, VIZ-5) ---------------------------------------------------
  "salesDaily.chart.title": "المبيعات المستلمة لكل يوم عمل",
  "salesDaily.chart.summary":
    "ملخص للجدول أدناه: عمود لكل يوم عمل، بعملة {currency}. اختر عمودًا للانتقال إلى صفه. الأرقام الدقيقة في الجدول.",
  "salesDaily.chart.legend":
    "العمود المخطّط يوم لم ينتهِ بعد (حتى الآن). اليوم الذي لم يرجع الخادم رقمه يُوسم «غير معروف» وبلا عمود.",
  "salesDaily.chart.currency": "العملة",
  "salesDaily.chart.bar": "{date}: {value} {currency}",
  "salesDaily.chart.barSoFar": "{date}: {value} {currency}، حتى الآن",
  "salesDaily.chart.barUnknown": "{date}: غير معروف",
  "salesDaily.chart.barNotBegun": "{date}: لم يبدأ بعد",
  "salesDaily.chart.soFar": "حتى الآن",
  "salesDaily.chart.unknown": "غير معروف",
  "salesDaily.chart.notBegun": "لم يبدأ",
  "salesDaily.chart.empty": "لم تُستلم أي مبيعات في هذا النطاق.",
  "salesDaily.chart.emptyUnknown": "لم يُرجع الخادم أي أرقام لهذه الأيام.",

  // --- Export (RT-824, VIZ-6) --------------------------------------------------
  "salesDaily.export.button": "تصدير إلى ملف جداول",
  "salesDaily.export.hint":
    "ينزّل أرقام الجداول أدناه مع سياقها: النطاق والمتاجر والمناطق الزمنية والفترة ووقت القراءة واكتمال البيانات.",

  // --- Definitions -------------------------------------------------------------
  "salesDaily.about": "ما تعنيه هذه الأرقام",

  // --- States ------------------------------------------------------------------
  "salesDaily.loading": "جارٍ تحميل التقرير…",
  "salesDaily.failed": "تعذّر تحميل التقرير.",
  "salesDaily.retry": "إعادة المحاولة",
  "salesDaily.rateLimited": "طلبات كثيرة جدًا. أعد المحاولة عند انتهاء الانتظار.",
  "salesDaily.rateLimitedHint": "يعرض الشريط أعلى الصفحة وقت الانتظار المتبقي.",

  // --- RT-1020 (v4.0): the report's band and day panel -------------------------
  "salesDaily.band.group": "التقارير · المبيعات",
  "salesDaily.band.label": "سياق التقرير من الخادم",
  "salesDaily.band.subStore": "{store} · {tenant}",
  "salesDaily.band.subScope": "كل متاجر النطاق · {tenant}",
  "salesDaily.band.subTenant": "{tenant}",
  "salesDaily.band.zone": "المنطقة الزمنية",
  "salesDaily.band.asOf": "وقت القراءة",
  "salesDaily.back.reports": "التقارير",
  "salesDaily.day.title": "تفاصيل يوم العمل",
  "salesDaily.day.hint": "الأرقام نفسها من صف اليوم في الجدولين أدناه، بلا حساب جديد.",
  "salesDaily.day.pick": "يوم العمل",
  "salesDaily.day.notBegunNote": "لم يبدأ يوم العمل هذا بعد، فلا أرقام له.",
  "salesDaily.day.unknownNote": "تعذّر تحديد أرقام هذا اليوم، وهي ليست صفرًا.",
  "salesDaily.day.salesLink": "مبيعات هذا اليوم",
  "salesDaily.day.rowLink": "صف هذا اليوم في الجدول",

  // --- RT-1020 (v4.0): the reports index ---------------------------------------
  "reports.nav.label": "التقارير",
  "reports.index.sub": "{tenant} · كل تقرير يجيب عن سؤال واحد بأرقام الخادم وسياقها",
  "reports.index.noneOpen": "لا يتاح لدورك أي تقرير أو شاشة مراجعة هنا.",
  "reports.group.sales": "المبيعات",
  "reports.group.cash": "النقد والورديات",
  "reports.group.stock": "المخزون",
  "reports.group.erp": "التكامل مع ERPNext",
  "reports.status.available": "متاح",
  "reports.status.review": "شاشة مراجعة",
  "reports.status.proposed": "مقترح، غير متاح بعد",
  "reports.answers": "يجيب عن:",
  "reports.open.report": "فتح التقرير",
  "reports.open.screen": "فتح الشاشة",
  "reports.item.daily.q":
    "كم استلم الخادم من مبيعات وإلغاءات ومرتجعات في كل يوم عمل، وأين وصلت مزامنتها وترحيلها إلى ERPNext الآن؟",
  "reports.item.shiftVariance.title": "فروقات النقد في الورديات",
  "reports.item.shiftVariance.q": "أي إقفال سُجّل فيه عجز أو زيادة، وهل سُجّل له معتمِد؟",
  "reports.item.stockDiscrepancies.title": "فروقات مخزون ERPNext",
  "reports.item.stockDiscrepancies.q": "أي الأصناف سالبة في أحدث لقطة من ERPNext لكل متجر؟",
  "reports.item.salesRepair.title": "المبيعات تحتاج إلى إصلاح",
  "reports.item.salesRepair.q": "أي مبيعات توقفت مزامنتها، ولماذا، ومن طلب إصلاحها؟",
  "reports.item.byStore.title": "المبيعات حسب المتجر",
  "reports.item.byStore.q": "أي متجر استلم أكثر وأقل في الفترة، وكيف تغيّر ترتيبه؟",
  "reports.item.byHour.title": "المبيعات حسب الساعة",
  "reports.item.byHour.q": "متى تبلغ المبيعات ذروتها في يوم العمل، وهل يكفي عدد نقاط البيع وقتها؟",
  "reports.item.shortageTrend.title": "اتجاه العجز والزيادة",
  "reports.item.shortageTrend.q": "هل يتكرر العجز في متجر أو وردية بعينها عبر الأسابيع؟",
  "reports.item.stockMovement.title": "حركة المخزون حسب النوع",
  "reports.item.stockMovement.q": "كم دخل وخرج وتسوّى وتحوّل من المخزون في الفترة، لكل متجر؟",
  "reports.item.postingHealth.title": "صحة الترحيل عبر الأيام",
  "reports.item.postingHealth.q": "كم يومًا انتهى بكل مبيعاته مرحَّلة، وأين تتجمّع حالات الفشل؟",
};
