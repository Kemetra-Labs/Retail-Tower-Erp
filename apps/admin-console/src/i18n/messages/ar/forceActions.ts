import type { Messages } from "../types";

/**
 * Arabic copy for the owner's force actions on a shift (RT-1437 A1, RT-1440 U1). Arabic is the
 * primary authored language (UX-12.2); the sentences marked "A1" are the owner-approved copy of
 * the decision record (Confluence 80084994), verbatim. Verb jurisdiction (UX-12.7): «إغلاق» is the
 * action on the shift, «تأكيد» crosses the consequence boundary, «إلغاء» cancels the workflow.
 * Times and counts render through components, never inside a template's prose.
 */
export const forceActions = {
  // --- Open shifts of a store ------------------------------------------------
  "forceActions.openShifts.title": "ورديات مفتوحة",
  "forceActions.openShifts.sub": "الورديات المفتوحة الآن في {store}، مع حكم الخادم على كل وردية.",
  "forceActions.openShifts.caption": "الورديات المفتوحة في المتجر",
  "forceActions.openShifts.col.terminal": "الجهاز",
  "forceActions.openShifts.col.cashier": "الكاشير",
  "forceActions.openShifts.col.opened": "فُتحت",
  "forceActions.openShifts.col.verdict": "الحكم",
  "forceActions.openShifts.terminal.none": "جهاز بلا تسمية",
  "forceActions.openShifts.cashier.none": "كاشير بلا اسم",
  "forceActions.openShifts.lastSeen": "آخر ظهور: {time}",
  "forceActions.openShifts.neverSeen": "لم يتصل قط",
  "forceActions.openShifts.age": {
    zero: "العمر: أقل من دقيقة",
    one: "العمر: دقيقة",
    two: "العمر: دقيقتان",
    few: "العمر: {count} دقائق",
    many: "العمر: {count} دقيقة",
    other: "العمر: {count} دقيقة",
  },
  "forceActions.openShifts.verdict.eligible": "يمكن إغلاقها دون عدّ الآن.",
  "forceActions.openShifts.verdict.blocked": "لا يمكن إغلاقها من هنا الآن:",
  "forceActions.openShifts.empty": "لا توجد ورديات مفتوحة في هذا المتجر.",
  "forceActions.openShifts.loading": "جارٍ تحميل الورديات المفتوحة…",
  "forceActions.openShifts.loadFailed": "تعذّر تحميل الورديات المفتوحة.",
  "forceActions.openShifts.retry": "إعادة المحاولة",
  "forceActions.openShifts.notAvailable": "هذه الصفحة غير متاحة لصلاحياتك، أو أن المتجر غير موجود.",
  "forceActions.openShifts.snapshot":
    "حتى {time}. هذه لقطة لا حجز: يقرّر الخادم مرة أخرى عند التأكيد.",
  "forceActions.openShifts.open": "إغلاق الوردية دون عدّ…",
  "forceActions.openShifts.openLabel": "إغلاق وردية {terminal} دون عدّ…",

  // --- The device page: the next step for a blocked retire -------------------
  "forceActions.deviceLink": "عرض الورديات المفتوحة في المتجر لإغلاقها دون عدّ",
  "forceActions.storeLink": "الورديات المفتوحة في هذا المتجر",

  // --- The close-without-a-count dialog --------------------------------------
  "forceActions.close.title": "إغلاق الوردية دون عدّ",
  "forceActions.close.consequence":
    "ستُغلق هذه الوردية دون عدّ الدرج. لن يُسجَّل مبلغ معدود ولا فرق. المبيعات والحركات النقدية المسجلة تبقى كما هي. لا يمكن التراجع عن هذا الإجراء.",
  "forceActions.close.drawerUnaccounted": "يبقى نقد الدرج الفعلي غير محسوب في النظام.",
  "forceActions.close.loading": "جارٍ فحص الوردية…",
  "forceActions.close.previewFailed": "تعذّر فحص الوردية. لم يتغير شيء.",
  "forceActions.close.retry": "إعادة المحاولة",
  "forceActions.close.snapshot": "حتى {time}. هذه لقطة لا حجز: يقرّر الخادم مرة أخرى عند التأكيد.",
  "forceActions.close.fact.opened": "فُتحت",
  "forceActions.close.fact.cashier": "الكاشير",
  "forceActions.close.fact.terminal": "الجهاز",
  "forceActions.close.fact.float": "الرصيد الافتتاحي المسجل",
  "forceActions.close.fact.movements": "الحركات النقدية المسجلة",
  "forceActions.close.fact.lastMovement": "آخر حركة وصلت",
  "forceActions.close.fact.sales": "مبيعات مسجلة من هذا الجهاز منذ فتح الوردية",
  "forceActions.close.fact.refunds": "عمليات استرداد مسجلة من هذا الجهاز منذ فتح الوردية",
  "forceActions.close.fact.unknown": "غير معروف",
  "forceActions.close.fact.none": "لا شيء",
  "forceActions.close.heading.willChange": "ما سيتغير",
  "forceActions.close.heading.willNotChange": "ما لن يتغير",
  "forceActions.close.effect.willChange.shift_closed_not_counted": "تُغلق الوردية دون عدّ الدرج.",
  "forceActions.close.effect.willChange.no_cash_up_recorded": "لا يُسجَّل إقفال نقدي ولا فرق.",
  "forceActions.close.effect.willChange.terminal_may_open_new_shift":
    "يمكن للجهاز أن يفتح وردية جديدة.",
  "forceActions.close.effect.willChange.device_retire_replace_move_unblocked":
    "يصبح سحب الجهاز واستبداله ونقله ممكنًا.",
  "forceActions.close.effect.willChange.timezone_change_unblocked":
    "لا تمنع هذه الوردية تغيير المنطقة الزمنية للمتجر.",
  "forceActions.close.effect.willNotChange.sales_unchanged": "المبيعات المسجلة تبقى كما هي.",
  "forceActions.close.effect.willNotChange.refunds_unchanged":
    "عمليات الاسترداد المسجلة تبقى كما هي.",
  "forceActions.close.effect.willNotChange.cash_movements_unchanged":
    "الحركات النقدية المسجلة تبقى كما هي.",
  "forceActions.close.effect.willNotChange.stock_unchanged": "سجلات المخزون تبقى كما هي.",
  "forceActions.close.effect.willNotChange.erp_documents_unchanged":
    "لا يُنشأ ولا يُعدَّل أي مستند في نظام المحاسبة.",
  "forceActions.close.caveat.offline_facts_not_visible":
    "لا يرى الخادم ما لم يزامنه الجهاز بعد: قد توجد مبيعات أو حركات غير مرسلة.",
  "forceActions.close.caveat.terminal_not_notified":
    "لا يُبلَّغ الجهاز بالإغلاق؛ يعلم به عندما يُرفض طلبه لإغلاق الوردية.",
  "forceActions.close.caveat.unknown": "لا يرى الخادم كل ما يعرفه الجهاز.",
  "forceActions.close.effect.unknown": "تغييرات أخرى يذكرها الخادم ولا تعرضها هذه الواجهة بعد.",
  "forceActions.close.blockedIntro": "لا يمكن الإغلاق من هنا الآن:",
  "forceActions.close.blocker.shift_not_open": "الوردية لم تعد مفتوحة.",
  "forceActions.close.blocker.not_stale": "فُتحت الوردية منذ وقت قصير.",
  "forceActions.close.blocker.live_operator_session":
    "الجهاز ما زال يعمل (جلسة كاشير نشطة). أغلق الوردية من الجهاز نفسه.",
  "forceActions.close.blocker.live_cashier_admission":
    "الجهاز ما زال يعمل (دخول كاشير نشط). أغلق الوردية من الجهاز نفسه.",
  "forceActions.close.blocker.unknown": "لا يمكن إغلاق هذه الوردية من هنا الآن.",
  "forceActions.close.reason.label": "سبب الإغلاق (إلزامي)",
  "forceActions.close.reason.help": "حتى 200 حرف. لا تكتب بيانات شخصية.",
  "forceActions.close.reason.required": "اكتب سبب الإغلاق.",
  "forceActions.close.reason.tooLong": "السبب أطول من 200 حرف.",
  "forceActions.close.acknowledge": "أفهم أن نقد هذا الدرج لن يُعدّ في النظام.",
  "forceActions.close.needInputs": "اكتب السبب وأكّد الفهم لتفعيل التأكيد.",
  "forceActions.close.cancel": "إلغاء",
  "forceActions.close.commit": "تأكيد إغلاق الوردية دون عدّ",
  "forceActions.close.committing": "جارٍ إغلاق الوردية…",
  "forceActions.close.done": "تم",
  "forceActions.close.stale": "تغيّرت حالة الوردية منذ الفحص. راجع الفحص الجديد ثم أكّد.",
  "forceActions.close.settled.force_close": "أُغلقت هذه الوردية دون عدّ من قبل. لم يتغير شيء.",
  "forceActions.close.settled.cash_up":
    "أُغلقت هذه الوردية بعدّ الدرج من الجهاز نفسه. لا حاجة لإغلاقها دون عدّ.",
  "forceActions.close.retryable":
    "لم نتأكد من تسجيل الإغلاق. أعد المحاولة بالطلب نفسه؛ لن يُسجَّل إغلاق ثانٍ.",
  "forceActions.close.session": "انتهت جلسة الدخول. سجّل الدخول مرة أخرى للمتابعة.",
  "forceActions.close.success": "أُغلقت الوردية دون عدّ. لم يُسجَّل مبلغ معدود ولا فرق.",
  "forceActions.close.successReplay": "هذه الوردية مغلقة دون عدّ بالفعل. لم يتغير شيء.",
  "forceActions.close.error.generic": "تعذّر إغلاق الوردية. لم يُسجَّل شيء.",
  "forceActions.close.error.readOnlySession": "جلسة الدعم للقراءة فقط: لا يمكن الإغلاق منها.",
  "forceActions.close.error.forbidden": "لا تملك صلاحية إغلاق هذه الوردية.",
  "forceActions.close.error.notAvailable":
    "هذا الإجراء غير متاح لصلاحياتك، أو أن الوردية غير موجودة.",
  "forceActions.close.error.capReached":
    "بلغت المؤسسة الحد الأقصى لهذه الإجراءات في الساعة. حاول لاحقًا.",
  "forceActions.close.error.rateLimited": "طلبات كثيرة. انتظر قليلًا ثم أعد المحاولة.",
  "forceActions.close.error.validation": "القيم المدخلة غير مقبولة. راجع السبب وأعد المحاولة.",
  // --- Shifts closed without a count (A4, from the audit search) -------------
  "forceActions.closed.title": "ورديات أُغلقت دون عدّ",
  "forceActions.closed.sub":
    "من سجل التدقيق، آخر 30 يومًا: متى أُغلقت الوردية ومن أغلقها وفي أي متجر. سبب الإغلاق محفوظ مع السجل ولا يظهر هنا.",
  "forceActions.closed.caption": "الورديات التي أُغلقت دون عدّ",
  "forceActions.closed.col.when": "الوقت",
  "forceActions.closed.col.by": "أغلقها",
  "forceActions.closed.col.channel": "القناة",
  "forceActions.closed.col.store": "المتجر",
  "forceActions.closed.col.shift": "الوردية",
  "forceActions.closed.col.age": "عمر الوردية",
  "forceActions.closed.channel.pos": "جهاز نقطة البيع",
  "forceActions.closed.channel.console": "لوحة التحكم",
  "forceActions.closed.channel.unknown": "غير معروفة",
  "forceActions.closed.minutes": {
    zero: "أقل من دقيقة",
    one: "دقيقة",
    two: "دقيقتان",
    few: "{count} دقائق",
    many: "{count} دقيقة",
    other: "{count} دقيقة",
  },
  "forceActions.closed.unknown": "غير معروف",
  "forceActions.closed.empty": "لا توجد ورديات أُغلقت دون عدّ.",
  "forceActions.closed.loading": "جارٍ تحميل الإغلاقات…",
  "forceActions.closed.loadFailed": "تعذّر تحميل الإغلاقات دون عدّ.",
  "forceActions.closed.retry": "إعادة المحاولة",
  "forceActions.closed.loadMore": "تحميل المزيد",
  "forceActions.closed.notAvailable": "هذه الصفحة غير متاحة لصلاحياتك.",
} as const satisfies Messages;
