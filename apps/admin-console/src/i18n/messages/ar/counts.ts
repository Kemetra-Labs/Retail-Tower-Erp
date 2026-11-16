import type { Messages } from "../types";

/**
 * Arabic copy for the Count Session screens (RT-1425; RT-292 Gate 6, RT-1419
 * contract): open a count, blind capture by position, the Count Cut, submit,
 * variance review, recount, approval and late-event findings.
 *
 * Glossary: stock count → «جرد»; Count Session → «جلسة جرد»; Count Cut → «قطع
 * الجرد»; variance → «الفرق»; expected at the cut → «المتوقع عند القطع»; approval
 * → «اعتماد»; recount → «إعادة العدّ». Traps: ERP status is the session's own
 * status as the server reports it («قيد الترحيل», «أكّده ERPNext»), never a
 * claim about a document the console did not read; a refusal is never worded as
 * a success; self-approval is always named as such.
 */
export const counts = {
  "counts.value.unknown": "غير معروف",
  "counts.value.none": "—",
  "counts.optional": "(اختياري)",
  "counts.scopePrompt": "اختر مؤسسة من شريط النطاق لعرض الجرد.",

  // --- Pages -------------------------------------------------------------------
  "counts.title": "جرد المخزون",
  "counts.back": "مخزون المتجر",
  "counts.store.sub": "جلسات الجرد في هذا المتجر.",
  "counts.store.notFound": "جرد المخزون غير مفعّل لهذه المؤسسة، أو أن هذا المتجر غير متاح لك.",
  "counts.note.blind": "العدّ أعمى: لا تظهر الكميات المتوقعة إلا بعد إرسال الجرد للمراجعة.",
  "counts.note.deskGuard":
    "سجّل الجرد هنا فقط. لا تُعدّل المخزون بنفسك في ERPNext أثناء جلسة جرد مفتوحة.",

  // --- Sessions list -----------------------------------------------------------
  "counts.list.title": "جلسات الجرد",
  "counts.list.caption": "جلسات الجرد في المتجر، الأحدث أولًا",
  "counts.list.col.opened": "وقت الفتح",
  "counts.list.col.state": "الحالة",
  "counts.list.col.products": "المنتجات",
  "counts.list.col.openedBy": "فتحها",
  "counts.list.col.findings": "ملاحظات متأخرة",
  "counts.list.open": "افتح جلسة الجرد التي بدأت في {when}",
  "counts.list.filter": "تصفية بالحالة",
  "counts.list.filter.all": "كل الحالات",
  "counts.list.loadingNoun": "جلسات الجرد",
  "counts.list.loadFailed": "تعذّر تحميل جلسات الجرد.",
  "counts.list.empty": "لا توجد جلسات جرد في هذا المتجر بعد. افتح جلسة لبدء الجرد.",
  "counts.list.emptyFiltered": "لا توجد جلسات بهذه الحالة.",
  "counts.list.loadMore": "تحميل جلسات أقدم",

  // --- Open a count --------------------------------------------------------------
  "counts.open.title": "فتح جلسة جرد",
  "counts.open.sub": "اختر المنتجات التي ستُجرد. يُجرد كل منتج كاملًا في كل مواقع المتجر وحالاته.",
  "counts.open.search": "ابحث عن منتج بالاسم أو الرمز",
  "counts.open.searchAction": "بحث",
  "counts.open.searchFailed": "تعذّر البحث في الكتالوج. حاول مرة أخرى.",
  "counts.open.loadingNoun": "المنتجات",
  "counts.open.noProducts": "لا توجد منتجات مطابقة.",
  "counts.open.results": "نتائج البحث",
  "counts.open.tracked": "بدفعة أو رقم تسلسلي",
  "counts.open.selected": {
    zero: "لم تختر أي منتج.",
    one: "اخترت منتجًا واحدًا.",
    two: "اخترت منتجين.",
    few: "اخترت {count} منتجات.",
    many: "اخترت {count} منتجًا.",
    other: "اخترت {count} منتج.",
  },
  "counts.open.error.empty": "اختر منتجًا واحدًا على الأقل.",
  "counts.open.note": "ملاحظة",
  "counts.open.submit": "فتح جلسة الجرد",
  "counts.open.failed": "لم تُفتح جلسة الجرد",

  // --- Session ---------------------------------------------------------------------
  "counts.session.title": "جلسة جرد",
  "counts.session.back": "كل جلسات الجرد",
  "counts.session.loadingNoun": "جلسة الجرد",
  "counts.session.loadFailed": "تعذّر تحميل جلسة الجرد.",
  "counts.session.notFound": "جرد المخزون غير مفعّل لهذه المؤسسة، أو أن جلسة الجرد هذه غير متاحة.",

  "counts.state.open": "مفتوحة",
  "counts.state.cut_taken": "تم القطع",
  "counts.state.submitted": "بانتظار الاعتماد",
  "counts.state.approved": "معتمدة",
  "counts.state.posting": "قيد الترحيل",
  "counts.state.confirmed": "أكّدها ERPNext",
  "counts.state.needs_attention": "تحتاج إلى متابعة",
  "counts.state.closed": "مغلقة",
  "counts.state.cancelled": "ملغاة",

  // --- Status and facts -------------------------------------------------------------
  "counts.status.title": "الحالة",
  "counts.erp.title": "حالة ERPNext",
  "counts.erp.posting": "الجرد المعتمد قيد الترحيل إلى ERPNext. لم يؤكد ERPNext النتيجة بعد.",
  "counts.erp.confirmed": "أكّد ERPNext نتيجة الجرد.",
  "counts.erp.needs_attention":
    "الجرد المعتمد يحتاج إلى متابعة: رُفض الترحيل أو تعذّر تأكيده، أو ظهر حدث متأخر بعد الاعتماد. لا يُلغى أي مستند في ERPNext لإخفاء فرق.",
  "counts.selfApproved.title": "اعتماد ذاتي",
  "counts.selfApproved.message":
    "اعتُمدت هذه الجلسة ممن شارك في عدّها أو إرسالها، بموجب الاستثناء الموثّق لصاحب المؤسسة. يظهر هذا في المراجعة والتدقيق.",
  "counts.policy.strict": "اعتماد من شخص آخر",
  "counts.policy.exception": "استثناء المتجر الصغير",
  "counts.fact.opened": "فُتحت",
  "counts.fact.cut": "قطع الجرد",
  "counts.fact.submitted": "أُرسلت للمراجعة",
  "counts.fact.approved": "اعتُمدت",
  "counts.fact.cancelled": "أُلغيت",
  "counts.fact.note": "ملاحظة",
  "counts.fact.products": "المنتجات",
  "counts.fact.findings": "ملاحظات الأحداث المتأخرة",

  // --- Capture -------------------------------------------------------------------------
  "counts.capture.title": "العدّ",
  "counts.capture.sub":
    "سجّل ما تراه على الرف في كل موقع وحالة. لا تظهر الكميات المتوقعة هنا، حتى لا تؤثر في العدّ.",
  "counts.capture.product": "المنتج",
  "counts.capture.location": "موقع المخزون",
  "counts.capture.status": "الحالة",
  "counts.capture.quantity": "الكمية المعدودة",
  "counts.capture.unit": "الوحدة المعدودة",
  "counts.capture.choose": "اختر…",
  "counts.capture.submit": "تسجيل العدّ",
  "counts.capture.saved": "سُجّل العدّ.",
  "counts.capture.failed": "لم يُسجَّل العدّ",
  "counts.capture.locationsFailed": "تعذّر تحميل مواقع التخزين. أعد تحميل الصفحة.",
  "counts.capture.error.product": "اختر المنتج.",
  "counts.capture.error.location": "اختر موقع المخزون.",
  "counts.capture.error.quantity": "أدخل كمية صفرًا أو أكثر، بحد أقصى أربع خانات عشرية.",
  "counts.capture.error.unit": "أدخل الوحدة التي عددت بها (حتى 32 حرفًا).",
  "counts.capture.recorded": "المسجّل في هذه الزيارة",
  "counts.capture.recordedEmpty": "لم تسجّل أي عدّ في هذه الزيارة بعد.",
  "counts.capture.coverage": "التغطية",
  "counts.capture.covered": "سُجّل له عدّ",
  "counts.capture.notCovered": "لم يُسجَّل له عدّ",
  "counts.capture.coverageNote":
    "القائمة تعرض ما سجّلته في هذه الزيارة فقط. يتحقق الخادم من تغطية كل منتج عند الإرسال، ويرفض الإرسال إن بقي منتج بلا عدّ.",

  // --- Commands ------------------------------------------------------------------------
  "counts.actions.title": "الإجراءات",
  "counts.cut.title": "قطع الجرد",
  "counts.cut.sub":
    "يثبّت قطع الجرد الكمية المتوقعة لكل منتج. لا يتم القطع إلا بعد مزامنة كل أجهزة نقاط البيع في المتجر ولحاق استيراد ERPNext.",
  "counts.cut.action": "قطع الجرد",
  "counts.cut.failed": "لم يتم قطع الجرد",
  "counts.submit.title": "إرسال الجرد للمراجعة",
  "counts.submit.sub":
    "بعد الإرسال تظهر الكميات المتوقعة والفروقات. يمكنك إعادة العدّ لمنتجات محددة قبل الاعتماد.",
  "counts.submit.action": "إرسال الجرد للمراجعة",
  "counts.submit.failed": "لم يُرسَل الجرد للمراجعة",
  "counts.cancel.start": "إلغاء جلسة الجرد",
  "counts.cancel.title": "إلغاء جلسة الجرد",
  "counts.cancel.consequence":
    "تُحفظ العمليات المسجّلة وسجل التدقيق، ولا تتغير أي كمية. لا يمكن إعادة فتح الجلسة الملغاة.",
  "counts.cancel.reason": "سبب الإلغاء",
  "counts.cancel.error.reason": "اكتب سبب الإلغاء.",
  "counts.cancel.confirm": "تأكيد إلغاء الجلسة",
  "counts.cancel.keep": "إبقاء الجلسة",
  "counts.cancel.failed": "لم تُلغَ جلسة الجرد",

  // --- Review ----------------------------------------------------------------------------
  "counts.review.title": "مراجعة الفروقات",
  "counts.review.sub": "الفرق هو المعدود ناقص المتوقع عند القطع. الأرقام كما أرسلها الخادم.",
  "counts.review.caption": "فروقات الجرد حسب المنتج",
  "counts.review.col.product": "المنتج",
  "counts.review.col.expected": "المتوقع عند القطع",
  "counts.review.col.counted": "المعدود",
  "counts.review.col.variance": "الفرق",
  "counts.review.col.flags": "تنبيهات",
  "counts.review.col.actions": "إجراء",
  "counts.review.loadingNoun": "الفروقات",
  "counts.review.loadFailed": "تعذّر تحميل الفروقات.",
  "counts.review.empty": "لا توجد سطور للمراجعة.",
  "counts.review.acknowledge": "راجعت هذا السطر",
  "counts.review.acknowledgeLine": "تأكيد مراجعة سطر {product}",
  "counts.review.acknowledged": "تمت مراجعته",
  "counts.review.cannotPost": "لا يُرحَّل",
  "counts.review.recount": "إعادة العدّ",
  "counts.review.recountLine": "إعادة عدّ {product}",
  "counts.flag.divergence": "اختلاف عن ERPNext",
  "counts.flag.stale_snapshot": "لقطة ERPNext قديمة",
  "counts.flag.pending": "حركات قيد الترحيل",
  "counts.flag.unmapped": "غير مربوط بـ ERPNext",
  "counts.flag.uom_mismatch": "وحدة مختلفة",
  "counts.refusal.count_up_without_valuation_history":
    "لا يمكن ترحيل زيادة لمنتج بلا رصيد أو تقييم سابق في ERPNext. يلزم استلام أو تقييم أولًا. باقي الجلسة يمضي.",
  "counts.refusal.count_line_unmapped":
    "هذا المنتج غير مربوط بصنف في ERPNext، فلا يمكن ترحيله. باقي الجلسة يمضي.",
  "counts.refusal.count_line_uom_mismatch":
    "الوحدة المعدودة تختلف عن وحدة التخزين، فلا يمكن ترحيله. باقي الجلسة يمضي.",

  // --- Approval and recount --------------------------------------------------------------
  "counts.approve.action": "اعتماد الجرد",
  "counts.approve.failed": "لم يُعتمد الجرد",
  "counts.approve.loadingLines": "جارٍ تحميل كل السطور قبل الاعتماد…",
  "counts.approve.pending": {
    zero: "كل السطور المنبَّه عليها روجعت. يمكنك الاعتماد.",
    one: "بقي سطر واحد منبَّه عليه لم تراجعه.",
    two: "بقي سطران منبَّه عليهما لم تراجعهما.",
    few: "بقيت {count} سطور منبَّه عليها لم تراجعها.",
    many: "بقي {count} سطرًا منبَّهًا عليه لم تراجعه.",
    other: "بقي {count} سطر منبَّه عليه لم تراجعه.",
  },
  "counts.approve.tookPart":
    "شاركت في عدّ هذه الجلسة أو إرسالها. يشترط الخادم أن يعتمدها شخص آخر، إلا إذا فعّل صاحب المؤسسة استثناء المتجر الصغير. الخادم هو من يقرر.",
  "counts.recount.reason": "سبب إعادة العدّ",
  "counts.recount.error.reason": "اكتب سبب إعادة العدّ.",
  "counts.recount.action": {
    zero: "إرسال للعدّ مجددًا",
    one: "إعادة عدّ منتج واحد",
    two: "إعادة عدّ منتجين",
    few: "إعادة عدّ {count} منتجات",
    many: "إعادة عدّ {count} منتجًا",
    other: "إعادة عدّ {count} منتج",
  },

  // --- Late events -------------------------------------------------------------------------
  "counts.late.title": "أحداث متأخرة قبل القطع",
  "counts.late.sub":
    "بيع أو مستند من ERPNext مؤرَّخ قبل قطع الجرد وصل بعده. لا تُنشأ حركة مخزون تلقائيًا، ولا إجراء لحل الملاحظة هنا.",
  "counts.late.caption": "ملاحظات الأحداث المتأخرة، الأقدم أولًا",
  "counts.late.col.product": "المنتج",
  "counts.late.col.assessment": "الأثر على الإتاحة",
  "counts.late.col.quantity": "الكمية",
  "counts.late.col.risk": "خطر البيع الزائد",
  "counts.late.col.event": "الحدث",
  "counts.late.col.detected": "اكتُشفت",
  "counts.late.understated": "الجرد يقلّل الإتاحة",
  "counts.late.overstated": "الجرد يبالغ في الإتاحة",
  "counts.late.oversell": "خطر بيع زائد",
  "counts.late.noOversell": "لا خطر",
  "counts.late.loadingNoun": "الملاحظات",
  "counts.late.loadFailed": "تعذّر تحميل ملاحظات الأحداث المتأخرة.",
  "counts.late.empty": "لا توجد ملاحظات.",
  "counts.late.loadMore": "تحميل ملاحظات أخرى",

  "counts.cut.devices": "أجهزة نقاط البيع التي تمنع القطع",
  "counts.cut.warehouses": "مستودعات ERPNext التي تمنع القطع",
  "counts.cut.device.no_heartbeat": "لم يرسل الجهاز أي تقرير صحة",
  "counts.cut.device.stale_heartbeat": "آخر تقرير للجهاز أقدم من طلب القطع",
  "counts.cut.device.queue_unknown": "لم يُبلغ الجهاز عن طابور مبيعاته",
  "counts.cut.device.queue_pending": "في طابور الجهاز مبيع معلّق أو متعثر أو محتجز",
  "counts.cut.warehouse.import_not_past_cut": "لم يكتمل استيراد مخزون بعد طلب القطع",
  "counts.error.ownerOnly": "صاحب المؤسسة وحده يقرأ هذا الإعداد أو يغيّره.",

  "counts.selfSetting.title": "الاعتماد الذاتي للمتجر الصغير",
  "counts.selfSetting.sub":
    "افتراضيًا يعتمد الجرد شخص غير من عدّه أو أرسله. إذا كنت وحدك أو معك قلة، يمكنك السماح بالاعتماد الذاتي مع تسجيل السبب. يُسجَّل كل تغيير في التدقيق، وتُوسَم الجلسات المعتمدة ذاتيًا في المراجعة. لا يوجد حد للفرق ولا تجاوز من خارج المؤسسة.",
  "counts.selfSetting.on": "الاعتماد الذاتي مسموح.",
  "counts.selfSetting.off": "الاعتماد الذاتي غير مسموح.",
  "counts.selfSetting.changed": "غيّره {who} في {when}.",
  "counts.selfSetting.enable": "السماح بالاعتماد الذاتي للجرد",
  "counts.selfSetting.reason": "سبب السماح",
  "counts.selfSetting.error.reason": "اكتب سبب السماح بالاعتماد الذاتي.",
  "counts.selfSetting.save": "حفظ الإعداد",
  "counts.selfSetting.saved": "حُفظ الإعداد.",
  "counts.selfSetting.failed": "لم يُحفظ الإعداد",
  "counts.selfSetting.loadingNoun": "الإعداد",
  "counts.selfSetting.loadFailed": "تعذّر تحميل الإعداد.",
  "counts.selfSetting.notAvailable": "هذا الإعداد غير متاح.",

  // --- Refusals (a typed code selects the message; the code stays visible) -----------------
  "counts.error.code": "الرمز: {code}",
  "counts.error.noAnswer":
    "لم يصل رد من الخادم، فلا نعرف إن نُفّذ الطلب. أعد المحاولة: الطلب نفسه لا يُنفَّذ مرتين.",
  "counts.error.notInState":
    "هذا الإجراء غير متاح في الحالة الحالية للجلسة. لم يتغير شيء. حدّث الصفحة.",
  "counts.error.trackedRefused":
    "منتج بدفعة أو رقم تسلسلي لا يمكن جرده بعد. لم تُفتح الجلسة. أزل هذا المنتج.",
  "counts.error.scopeInUse":
    "منتج واحد على الأقل داخل جلسة جرد أخرى مفتوحة في المتجر. لم تُفتح الجلسة.",
  "counts.error.cutBlocked":
    "قطع الجرد غير جاهز بعد: لم تُزامن كل أجهزة نقاط البيع في المتجر، أو لم يلحق استيراد ERPNext. لم يُسجَّل أي قطع. أعد المحاولة بعد المزامنة.",
  "counts.error.approverConflict":
    "لا يعتمد الجرد من شارك في عدّه أو إرساله، إلا باستثناء المتجر الصغير الذي يفعّله صاحب المؤسسة. لم يُعتمد الجرد. اطلب من شخص آخر اعتماده.",
  "counts.error.notAcknowledged":
    "هناك سطر منبَّه عليه لم يُراجَع. لم يُعتمد الجرد. راجع كل السطور المنبَّه عليها.",
  "counts.error.lineStale":
    "تغيّر سطر بعد مراجعته (إعادة عدّ أو حدث متأخر). لم يُعتمد الجرد. حُدّثت السطور: راجع من جديد.",
  "counts.error.keyConflict": "تعارض في مفتاح الطلب. لم يُنفَّذ شيء. أعد المحاولة.",
  "counts.error.conflict": "رفض الخادم الطلب لتعارضه مع حالة الجلسة. لم يتغير شيء.",
  "counts.error.validation": "رفض الخادم القيم المُدخلة. راجعها ثم أعد المحاولة.",
  "counts.error.session": "انتهت جلستك. سجّل الدخول مرة أخرى.",
  "counts.error.forbidden": "هذا الإجراء غير متاح لدورك أو لهذا المتجر.",
  "counts.error.notFound": "الجلسة أو المتجر غير متاح.",
  "counts.error.rateLimited": "طلبات كثيرة في وقت قصير. انتظر قليلًا ثم أعد المحاولة.",
  "counts.error.rateLimitedFor": {
    zero: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد {count} ثانية.",
    one: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد ثانية واحدة.",
    two: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد ثانيتين.",
    few: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد {count} ثوانٍ.",
    many: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد {count} ثانية.",
    other: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد {count} ثانية.",
  },
  "counts.error.generic": "تعذّر تنفيذ الطلب. لم يتأكد حدوث أي تغيير. حاول مرة أخرى.",
} satisfies Messages;
