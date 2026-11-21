/**
 * RT-1541 (W8 P-08) — مساعد مبيعات المدير: اسأل واشرح (RT-1526 §5، U-1 .. U-11). نص عربي أولًا،
 * والإنجليزية مطابقة له في المفاتيح. الأرقام تأتي من الخادم كما هي ولا يحسب المساعد شيئًا.
 * الأسئلة المقترحة من T-01 إلى T-10 ومن T-12 (نصوصها مسودة تنتظر اعتماد المالك عدا الأربعة
 * الواردة في U-1). نصوص الأيام والفجوات والتنبيهات الإضافية مسودة كذلك.
 */
export const aiManagerSales = {
  // --- Panel ----------------------------------------------------------------------
  "aiManagerSales.title": "اسأل عن المبيعات",
  "aiManagerSales.sub": "للقراءة فقط. إجابات من المبيعات التي استلمها النظام، بلا تخمين.",
  "aiManagerSales.controls.label": "نطاق السؤال",
  "aiManagerSales.stores.legend": "المتاجر",
  "aiManagerSales.stores.all": "كل متاجري",
  "aiManagerSales.currency.label": "العملة",
  "aiManagerSales.range.note":
    "تُحدَّد المتاجر والفترة والعملة من هذه الخيارات فقط. أقصى فترة 31 يومًا.",
  "aiManagerSales.chips.legend": "أسئلة مقترحة",
  "aiManagerSales.question.label": "أو اكتب سؤالك",
  "aiManagerSales.question.hint": "الكتابة تختار سؤالًا مدعومًا فقط ولا تغيّر المتاجر أو الفترة.",
  "aiManagerSales.ask": "اسأل",
  "aiManagerSales.loading": "جارٍ تجهيز الإجابة…",
  "aiManagerSales.announce.answer": "الإجابة جاهزة.",
  "aiManagerSales.announce.noAnswer": "لا توجد إجابة. اقرأ الرسالة أسفل النموذج.",
  "aiManagerSales.retry": "إعادة المحاولة",
  "aiManagerSales.crashed": "المساعد متوقف مؤقتًا. تقارير المبيعات تعمل كالمعتاد.",

  // --- Chips (U-1; T-01 .. T-10, T-12) ---------------------------------------------
  "aiManagerSales.chip.T01": "كم بعنا في هذه الفترة؟",
  "aiManagerSales.chip.T02": "المبيعات يومًا بيوم",
  "aiManagerSales.chip.T03": "الإلغاءات والمرتجعات",
  "aiManagerSales.chip.T04": "ترتيب المتاجر",
  "aiManagerSales.chip.T05": "قارن المتاجر",
  "aiManagerSales.chip.T06": "كيف نقارن بالفترة السابقة؟",
  "aiManagerSales.chip.T07": "ما الذي تغيّر عن الفترة السابقة؟",
  "aiManagerSales.chip.T08": "أفضل يوم لكل متجر",
  "aiManagerSales.chip.T09": "متوسط قيمة البيع لكل متجر",
  "aiManagerSales.chip.T10": "لماذا الرقم غير نهائي؟",
  "aiManagerSales.chip.T12": "المتاجر التي لم تستلم مبيعات",

  // --- Answer (U-3, U-4) -----------------------------------------------------------
  "aiManagerSales.ctx.scopeAll": "كل متاجرك",
  "aiManagerSales.ctx.scopeStores": {
    zero: "لا متاجر",
    one: "متجر واحد",
    two: "متجران",
    few: "{count} متاجر",
    many: "{count} متجرًا",
    other: "{count} متجر",
  },
  "aiManagerSales.ctx.scopeAnswer": {
    zero: "لا متاجر",
    one: "متجر واحد",
    two: "متجران",
    few: "{count} متاجر",
    many: "{count} متجرًا",
    other: "{count} متجر",
  },
  "aiManagerSales.ctx.line.store":
    "المتجر: {scope} · الفترة: {period} · حتى {asOf} · يشمل ما استلمه النظام فقط",
  "aiManagerSales.ctx.line.stores":
    "المتاجر: {scope} · الفترة: {period} · حتى {asOf} · يشمل ما استلمه النظام فقط",
  "aiManagerSales.table.region": "جدول الإجابة",
  "aiManagerSales.table.caption": "أرقام الإجابة، كل رقم له مرجع",
  "aiManagerSales.cite.open": "فتح المرجع {n}",
  "aiManagerSales.figure.seeSource": "انظر المرجع",
  "aiManagerSales.col.store": "المتجر",
  "aiManagerSales.col.date": "اليوم",
  "aiManagerSales.col.receivedSales": "المبيعات المستلمة",
  "aiManagerSales.col.count": "العدد",
  "aiManagerSales.col.share": "الحصة من كل متاجرك",
  "aiManagerSales.col.rank": "الترتيب",
  "aiManagerSales.col.averageSale": "متوسط البيع",
  "aiManagerSales.col.bestDay": "أفضل يوم",
  "aiManagerSales.col.baselineTotal": "الفترة السابقة",
  "aiManagerSales.col.deltaRatio": "نسبة التغيّر",
  "aiManagerSales.col.voids": "الإلغاءات",
  "aiManagerSales.col.returns": "المرتجعات",
  "aiManagerSales.col.legacyRefunds": "المبالغ المستردة القديمة",
  "aiManagerSales.col.total": "الإجمالي",

  // --- Notices (U-5, U-5b) and declines (U-6) --------------------------------------
  "aiManagerSales.notices.label": "تنبيهات على الأرقام",
  "aiManagerSales.notice.receivedOnly":
    "الأرقام تشمل ما استلمه النظام فقط، وليست الإجمالي النهائي.",
  "aiManagerSales.notice.dayInProgress":
    "أرقام اليوم جارية: تشمل ما وصل إلى النظام حتى {time} فقط. مبيعات ما زالت على أجهزة الكاشير لم تُحتسب بعد، وقد يرتفع الرقم لاحقًا.",
  "aiManagerSales.notice.dayNotBegun": "الأيام التي لم تبدأ تظهر «لم يبدأ» وليست صفرًا.",
  "aiManagerSales.notice.multiCurrency": "كل عملة في سطر منفصل، ولا تُجمع العملات معًا.",
  "aiManagerSales.notice.scopeRelativeRatio":
    "الحصة والترتيب نسبة إلى كل متاجرك وليس إلى المتاجر المختارة فقط.",
  "aiManagerSales.notice.controlsOnly":
    "تُحدَّد الفترة والمتاجر من عناصر التحكم أعلاه. الإجابة تخص: {scope} · {period}.",
  "aiManagerSales.declines.label": "ما لا يمكن قوله",
  "aiManagerSales.decline.causal": "تُعرض الأرقام التي تغيّرت، ولا يمكن تحديد السبب من هذه البيانات.",
  "aiManagerSales.decline.conclusive": "لا يمكن اعتبار هذا الرقم نهائيًا: {reason}",
  "aiManagerSales.reason.dayInProgress": "أرقام اليوم ما زالت جارية وقد ترتفع لاحقًا.",
  "aiManagerSales.reason.receivedOnly": "الأرقام تشمل ما استلمه النظام فقط.",
  "aiManagerSales.gaps.label": "ما لا تتضمنه هذه الإجابة",
  "aiManagerSales.gap.g1": "لا يتوفر إجمالي للمتاجر المختارة وحدها.",
  "aiManagerSales.gap.g2": "لا يتوفر ترتيب أو حصة للمتاجر المختارة وحدها.",
  "aiManagerSales.gap.g3": "لا يتوفر فرق محسوب لكل المتاجر، فيُعرض إجمالي كل فترة منفصلًا.",
  "aiManagerSales.gap.g4": "لا يتوفر متوسط بيع لكل المتاجر معًا.",
  "aiManagerSales.gap.g5": "مبيعات ما زالت على أجهزة الكاشير لا يمكن عدّها هنا.",
  "aiManagerSales.gap.g6": "الإلغاءات والمرتجعات في الفترة السابقة من قراءة ملخص المبيعات.",
  "aiManagerSales.gap.g7": "صافي المبيعات والهامش والربح والتكلفة غير متوفرة.",

  // --- Sources (X-4) ---------------------------------------------------------------
  "aiManagerSales.sources.title": "المراجع",
  "aiManagerSales.source.salesSummary": "ملخص المبيعات",
  "aiManagerSales.source.salesByStore": "المبيعات حسب المتجر",

  // --- Refusals (U-6) --------------------------------------------------------------
  "aiManagerSales.refusal.finance":
    "بيانات التكلفة والربح غير متوفرة في Retail Tower بعد، لذلك لا يمكن حساب الهامش أو الربح. يمكنك عرض المبيعات المستلمة والمرتجعات.",
  "aiManagerSales.refusal.forecast":
    "المساعد لا يقدّم توقعات. يعرض فقط المبيعات الفعلية التي استلمها النظام.",
  "aiManagerSales.refusal.write":
    "المساعد للقراءة فقط ولا ينفّذ إجراءات. افتح الشاشة المختصة لتنفيذ ذلك.",
  "aiManagerSales.refusal.unsupported": "هذا السؤال غير مدعوم بعد. اختر سؤالًا من المقترحات.",

  // --- Unavailable (U-7, U-8) ------------------------------------------------------
  "aiManagerSales.unavailable.system": "المساعد متوقف حاليًا. تقارير المبيعات تعمل كالمعتاد.",
  "aiManagerSales.unavailable.generic": "المساعد غير متاح حاليًا. تواصل مع مالك الحساب.",
  "aiManagerSales.unavailable.genericOwner": "المساعد غير متاح حاليًا لمؤسستك.",
  "aiManagerSales.unavailable.optOutOwner":
    "أوقفتَ هذه الميزة لمؤسستك. يمكن إعادة تشغيلها من إعدادات الذكاء الاصطناعي.",
  "aiManagerSales.unavailable.quotaOwner": "بلغت مؤسستك حد الأسئلة لهذه الفترة.",

  // --- Errors and clarifications (U-10, U-11) --------------------------------------
  "aiManagerSales.error.generic": "تعذّر الحصول على الإجابة. لم تتغيّر أي بيانات.",
  "aiManagerSales.error.session": "انتهت جلستك. سجّل الدخول مرة أخرى.",
  "aiManagerSales.error.rateLimited": "طلبات كثيرة في وقت قصير.",
  "aiManagerSales.error.rateLimitedHint": "انتظر قليلًا ثم أعد المحاولة. لم تتغيّر أي بيانات.",
  "aiManagerSales.error.currency": "اكتب رمز عملة من ثلاثة أحرف، مثل EGP.",
  "aiManagerSales.error.noStore": "اختر متجرًا واحدًا على الأقل.",
  "aiManagerSales.error.noChoice": "اختر سؤالًا من المقترحات أو اكتب سؤالك.",
  "aiManagerSales.error.questionTooLong": "السؤال أطول من 500 حرف. اختصره.",
  "aiManagerSales.clarify.range": "الفترة أطول من 31 يومًا. اختر فترة أقصر.",
  "aiManagerSales.clarify.scopeTooLarge":
    "نطاقك يضم أكثر من 500 متجر ولا يدعمه هذا التقرير. اختر متجرًا واحدًا.",
  "aiManagerSales.clarify.invalid": "تعذّر قبول الاختيارات. راجع المتاجر والتواريخ والعملة.",
  "aiManagerSales.denied": "تعذّر عرض إجابة لهذا الاختيار.",
  "aiManagerSales.deniedHint": "اختر من المتاجر المتاحة لك ثم أعد السؤال.",
};
