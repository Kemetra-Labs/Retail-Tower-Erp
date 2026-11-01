/** النصوص العربية لتقرير «المبيعات حسب المتجر» (RT-1054، لوحة Report-stores). */
export const salesByStore = {
  // --- Heading and band ----------------------------------------------------------
  "salesByStore.title": "المبيعات حسب المتجر",
  "salesByStore.band.subtitle": "أي متجر استلم أكثر وأقل في الفترة، وكيف تغيّر ترتيبه؟",
  "salesByStore.band.label": "إجمالي النطاق من الخادم",
  "salesByStore.fact.received": "المبيعات المستلمة",
  "salesByStore.fact.stores": "المتاجر",
  "salesByStore.fact.withoutSales": "متاجر بلا مبيعات",

  // --- Controls ------------------------------------------------------------------
  "salesByStore.controls.label": "النطاق والمقارنة",
  "salesByStore.preset.label": "نطاقات جاهزة",
  "salesByStore.preset.last7": "آخر 7 أيام عمل",
  "salesByStore.preset.last10": "آخر 10 أيام عمل",
  "salesByStore.preset.month": "هذا الشهر حتى الآن",
  "salesByStore.compare.label": "مقارنة بالفترة السابقة المساوية",
  "salesByStore.currency.label": "عملة الترتيب",

  // --- Context line --------------------------------------------------------------
  "salesByStore.context.scope": "المتاجر: كل متاجر النطاق ({count})",
  "salesByStore.context.baseline": "الفترة السابقة: {range}",
  "salesByStore.context.noCompare": "بلا مقارنة بالفترة السابقة",
  "salesByStore.context.soFar": "يشمل أيامًا حتى الآن",

  // --- Ranking -------------------------------------------------------------------
  "salesByStore.rank.title": "ترتيب المتاجر",
  "salesByStore.rank.hint": "الشريط: حصة المتجر من إجمالي النطاق، كما قدّمها الخادم.",
  "salesByStore.rank.hintCompare":
    "الشريط: حصة المتجر من إجمالي النطاق. الشارة: التغيّر عن الفترة السابقة.",
  "salesByStore.rank.aria": "المرتبة {rank}، {name}، {amount}",
  "salesByStore.rank.unrankedAria": "بلا مرتبة، {name}",
  "salesByStore.rank.unrankedHeading": "متاجر بلا مبيعات بهذه العملة",
  "salesByStore.rank.unrankedNote": "تُعرض بعد المتاجر المرتّبة، بلا مرتبة.",
  "salesByStore.rank.notRankable":
    "نطاقك فيه متجر واحد أو لا متجر، فلا ترتيب. تُعرض أرقام المتجر كما هي.",
  "salesByStore.move.was": "كان في المرتبة {rank} في الفترة السابقة",
  "salesByStore.move.notRankedBefore": "بلا مبيعات في الفترة السابقة",
  "salesByStore.noSales": "لا مبيعات مستلمة بهذه العملة في النطاق",
  "salesByStore.sales.count": "المبيعات: {count}",
  "salesByStore.share": "{share} من إجمالي النطاق",
  "salesByStore.delta.aria": "التغيّر عن الفترة السابقة: {delta}",
  "salesByStore.delta.none": "لا مقارنة: لا مبيعات في الفترة السابقة",
  "salesByStore.status.inactive": "غير نشط",
  "salesByStore.status.deleted": "محذوف",
  "salesByStore.notAvailable": "غير متاح",

  // --- Store × business day ------------------------------------------------------
  "salesByStore.matrix.title": "متجر × يوم عمل",
  "salesByStore.matrix.hint":
    "أين ومتى تتركّز المبيعات؟ المبلغ المستلم بعملة الترتيب كما قدّمه الخادم. ★ أفضل يوم للمتجر.",
  "salesByStore.matrix.caption": "المبيعات المستلمة لكل متجر في كل يوم عمل بعملة الترتيب",
  "salesByStore.matrix.store": "المتجر",
  "salesByStore.matrix.best": "أفضل يوم",
  "salesByStore.matrix.legend":
    "الخلية المخطّطة: يوم لم ينتهِ بعد. الخلية الباهتة: لا مبيعات مستلمة (صفر حقيقي).",

  // --- Selected store panel ------------------------------------------------------
  "salesByStore.panel.label": "تفاصيل المتجر المختار",
  "salesByStore.panel.rank": "المتجر المختار · المرتبة {rank}",
  "salesByStore.panel.unranked": "المتجر المختار · بلا مرتبة",
  "salesByStore.panel.shareLine": "{share} من إجمالي النطاق · المبيعات: {count}",
  "salesByStore.panel.vsPrevious": "عن الفترة السابقة",
  "salesByStore.panel.previousTotal": "الفترة السابقة",
  "salesByStore.panel.average": "متوسط قيمة المبيعة",
  "salesByStore.panel.averageNote": "من الخادم",
  "salesByStore.panel.returns": "المرتجعات",
  "salesByStore.panel.voids": "الإلغاءات",
  "salesByStore.panel.legacyRefunds": "الاستردادات القديمة",
  "salesByStore.panel.bestDay": "أفضل يوم",
  "salesByStore.panel.days": "أيام النطاق",
  "salesByStore.panel.storeLink": "تفاصيل المتجر",

  // --- Exact figures -------------------------------------------------------------
  "salesByStore.table.title": "الأرقام الدقيقة",
  "salesByStore.table.hint":
    "كل عملة في سطر مستقل ولا تُجمع العملات معًا. الإجمالي من الخادم، لا مجموع الصفوف.",
  "salesByStore.table.caption":
    "المبيعات المستلمة والمرتجعات والإلغاءات لكل متجر في النطاق، مع الفترة السابقة",
  "salesByStore.table.col.store": "المتجر",
  "salesByStore.table.col.sales": "المبيعات المستلمة",
  "salesByStore.table.col.returns": "المرتجعات",
  "salesByStore.table.col.voids": "الإلغاءات",
  "salesByStore.table.col.legacy": "الاستردادات القديمة",
  "salesByStore.table.col.baseline": "الفترة السابقة ({currency})",
  "salesByStore.table.col.change": "التغيّر",
  "salesByStore.table.total": "إجمالي النطاق",
  "salesByStore.table.totalSoFar": "إجمالي النطاق (يشمل أيامًا حتى الآن)",

  // --- States --------------------------------------------------------------------
  "salesByStore.loading": "جارٍ تحميل التقرير…",
  "salesByStore.failed": "تعذّر تحميل التقرير.",
  "salesByStore.retry": "إعادة المحاولة",
  "salesByStore.rateLimited": "طلبات كثيرة جدًا. أعد المحاولة عند انتهاء الانتظار.",
  "salesByStore.rateLimitedHint": "يعرض الشريط أعلى الصفحة وقت الانتظار المتبقي.",
  "salesByStore.rejected":
    "رفض الخادم هذا الطلب. تحقق من النطاق (31 يوم عمل على الأكثر) ومن رمز العملة.",
  "salesByStore.scopeTooLarge": "نطاقك أكبر مما يرتّبه التقرير (500 متجر على الأكثر).",
  "salesByStore.scopeTooLargeHint": "لم يُعرض شيء ولم يُقتطع شيء. اطلب نطاقًا أصغر من مدير المنصة.",
  "salesByStore.empty": "لا توجد متاجر في نطاقك.",
  "salesByStore.emptyHint": "أضف متجرًا ثم عُد إلى التقرير.",
  "salesByStore.allUnranked":
    "لا مبيعات مستلمة بعملة {currency} في هذا النطاق، فكل المتاجر بلا مرتبة.",
};
