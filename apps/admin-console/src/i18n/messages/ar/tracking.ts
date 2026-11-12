/**
 * Arabic copy for the tracking holds screen and the batch or serial detail
 * (RT-455; boards `Tracking-holds*.dc.html`, `Inventory-item*.dc.html`).
 * Reads only.
 *
 * Glossary: batch → «دفعة»; serial → «رقم تسلسلي»; quality hold → «حجز
 * جودة»; recall hold → «حجز استدعاء»; recall → «استدعاء»; position (identity ×
 * store × unit) → «موضع». Traps: an unknown count is «—» with text, never «٠»;
 * «قريبة الانتهاء» is stopped, never «لا يوجد».
 */
export const tracking = {
  "tracking.nav.label": "الحجز والاستدعاء",
  "tracking.title": "الحجز والاستدعاء",
  "tracking.loadingNoun": "الحجز والاستدعاء",
  "tracking.sub.tenant": "الدفعات والأرقام التسلسلية المتتبَّعة في {tenant}، لكل المتاجر.",
  "tracking.sub.manager": "الدفعات والأرقام التسلسلية المتتبَّعة في متاجرك.",

  // --- Band (counts of the computed findings, the whole set) ---------------------
  "tracking.band.label": "نتائج سلامة التتبع",
  "tracking.band.activeHolds": "حجوزات نشطة",
  "tracking.band.expiredPositions": "مواضع منتهية ما زالت قابلة للبيع",
  "tracking.band.generatedAt": "آخر حساب",
  "tracking.band.unknown": "الأعداد في الشريط غير معروفة حتى تُقرأ النتائج.",

  // --- Findings read --------------------------------------------------------------
  "tracking.findings.loadingNoun": "نتائج سلامة التتبع",
  "tracking.findings.loadFailed": "تعذّر تحميل نتائج سلامة التتبع. العدد في الشريط غير معروف.",
  "tracking.findings.stale": "تعذّر تحديث نتائج سلامة التتبع. المعروض من آخر قراءة ناجحة.",
  "tracking.findings.unpaged":
    "القائمة غير مقسّمة إلى صفحات: هي كل ما حسبه الخادم في نطاقك. أسماء الأصناف والمتاجر تُقرأ من الكتالوج وقائمة المتاجر.",

  // --- Tabs -------------------------------------------------------------------------
  "tracking.tabs.label": "أقسام الحجز والاستدعاء",
  "tracking.tab.active": "الحجوزات النشطة",
  "tracking.tab.expired": "منتهية وقابلة للبيع",
  "tracking.tab.expiring": "قريبة الانتهاء",
  "tracking.tab.released": "الحجوزات المرفوعة",
  "tracking.tab.recalls": "الاستدعاءات",
  "tracking.tab.resolution": "قائمة الحل",
  "tracking.tab.saleLines": "نتائج أسطر البيع",

  // --- Columns ------------------------------------------------------------------------
  "tracking.col.status": "الحالة",
  "tracking.col.kind": "النوع",
  "tracking.col.product": "الصنف",
  "tracking.col.identity": "الدفعة أو الرقم",
  "tracking.col.code": "الرمز",
  "tracking.col.expiry": "تاريخ الانتهاء",
  "tracking.col.manufactured": "تاريخ التصنيع",
  "tracking.col.origin": "المصدر",
  "tracking.col.placedAt": "وُضع",
  "tracking.col.placedBy": "وضعه",
  "tracking.col.releasedAt": "رُفع",
  "tracking.col.releasedBy": "رفعه",
  "tracking.col.releaseNote": "ملاحظة الرفع",
  "tracking.col.stores": "متاجر بها مخزون",
  "tracking.col.store": "المتجر",
  "tracking.col.unit": "وحدة التخزين",
  "tracking.col.action": "إجراء",
  "tracking.col.reason": "السبب",
  "tracking.col.note": "الملاحظة",
  "tracking.col.recall": "الاستدعاء",
  "tracking.col.reference": "المرجع",
  "tracking.col.effectiveAt": "يسري من",
  "tracking.col.createdAt": "سُجّل",
  "tracking.col.createdBy": "سجّله",
  "tracking.col.activeHolds": "حجوزات نشطة",
  "tracking.col.expiredOn": "انتهت في",
  "tracking.col.businessDate": "يوم عمل المتجر",
  "tracking.col.sellable": "القابل للبيع",

  // --- Values -----------------------------------------------------------------------
  "tracking.action.open": "عرض",
  "tracking.value.none": "لا يوجد",
  "tracking.date.none": "غير مسجّل",
  "tracking.stores.none": "لا مخزون",
  "tracking.actor.unknown": "مستخدم ليس عضوًا الآن",
  "tracking.holdKind.quality_hold": "حجز جودة",
  "tracking.holdKind.recall_hold": "حجز استدعاء",
  "tracking.reason.supplier_notice": "إشعار من المورّد",
  "tracking.reason.authority_notice": "إشعار من جهة رسمية",
  "tracking.reason.label_misprint": "خطأ في طباعة الملصق",
  "tracking.reason.other": "أخرى",
  "tracking.check.identity_without_edge_map": "هوية بلا ربط في ERPNext",
  "tracking.check.untracked_effect_on_tracked_product": "حركة بلا هوية على صنف متتبَّع",
  "tracking.check.serial_position_out_of_range": "كمية رقم تسلسلي خارج المدى",
  "tracking.check.profile_erp_flag_mismatch": "ملف التتبع لا يطابق إعداد ERPNext",

  // --- Active holds -----------------------------------------------------------------
  "tracking.active.caption": "الحجوزات النشطة على الدفعات والأرقام التسلسلية",
  "tracking.active.empty": "لا توجد حجوزات نشطة.",
  "tracking.active.emptyHint": "لا توجد دفعة أو رقم تسلسلي عليه حجز جودة أو حجز استدعاء نشط الآن.",
  "tracking.active.openLabel": "عرض حجز {code}",

  // --- Expired, still sellable ---------------------------------------------------------
  "tracking.expired.caption": "دفعات منتهية ما زالت قابلة للبيع، لكل متجر ووحدة",
  "tracking.expired.empty": "لا توجد دفعة منتهية ما زالت قابلة للبيع.",
  "tracking.expired.move": "نقل إلى «منتهي الصلاحية»",
  "tracking.expired.note":
    "يفتح نقل الحالة في صفحة رصيد المنتج بالمتجر. الدفعة تُباع حتى نهاية يوم انتهائها.",

  // --- Expiring (stopped) ----------------------------------------------------------------
  "tracking.expiring.tag": "متوقف",
  "tracking.expiring.title": "تنبيه «قريب الانتهاء» غير مفعَّل.",
  "tracking.expiring.body":
    "لم تُعتمد بعد نافذة الأيام التي تسبق الانتهاء. لا يعني ذلك أنه لا توجد دفعات قريبة الانتهاء.",

  // --- Not built yet ----------------------------------------------------------------------
  "tracking.resolution.title": "قائمة الحل",
  "tracking.resolution.intro":
    "مبيعات سُجّلت دون هوية تتبع مؤكدة، تُربط بهوية موجودة عبر أمر محكوم مع سبب. لا أثر للبيع على المخزون ولا قيد في ERPNext قبل الربط.",
  "tracking.resolution.caption": "المبيعات بلا هوية تتبع مؤكدة، الأحدث تسجيلًا أولًا",
  "tracking.resolution.loadingNoun": "قائمة الحل",
  "tracking.resolution.loadFailed": "تعذّر تحميل قائمة الحل. العدد غير معروف.",
  "tracking.resolution.empty": "لا توجد مبيعات بانتظار الربط.",
  "tracking.resolution.statusLabel": "الحالة",
  "tracking.resolution.status.unresolved": "بانتظار الربط",
  "tracking.resolution.status.resolved": "تم الربط",
  "tracking.resolution.status.all": "الكل",
  "tracking.resolution.ownerOnly":
    "ربط الهوية حساس، ومتاح لمالك المؤسسة وحده. اطلب منه الربط إن لزم.",
  "tracking.resolution.col.sale": "البيع",
  "tracking.resolution.col.businessDate": "يوم العمل",
  "tracking.resolution.col.capturedAt": "وصل الخادم",
  "tracking.resolution.col.lines": "الأسطر",
  "tracking.resolution.col.resolution": "الربط المسجَّل",
  "tracking.resolution.lineReason.tracking_missing": "بلا بيانات تتبع",
  "tracking.resolution.lineReason.identity_unknown": "هوية غير معروفة",
  "tracking.resolution.lineReason.identity_other_product": "هوية صنف آخر",
  "tracking.resolution.bind": "ربط هوية",
  "tracking.resolution.drawer.title": "ربط هوية بأسطر البيع",
  "tracking.resolution.drawer.scope": "البيع {sale}",
  "tracking.resolution.drawer.sensitive":
    "إجراء حساس ومسجَّل. اختر هوية موجودة لكل سطر غير مؤكد، ثم اكتب السبب والملاحظة. الربط نهائي: يُسجَّل أثره على المخزون وقيده في ERPNext معًا.",
  "tracking.resolution.identityChoose": "اختر الدفعة",
  "tracking.resolution.serialNotBindable": "الأرقام التسلسلية لا تُربط هنا",
  "tracking.resolution.identitiesLoading": "جارٍ تحميل هويات الصنف",
  "tracking.resolution.identitiesFailed": "تعذّر تحميل هويات هذا الصنف.",
  "tracking.resolution.identitiesNone": "لا توجد هوية مسجَّلة لهذا الصنف.",
  "tracking.resolution.identitiesMore": "تحميل المزيد من هويات الصنف",
  "tracking.resolution.loadMore": "تحميل المزيد من المبيعات",
  "tracking.saleLines.loadMore": "تحميل المزيد من النتائج",
  "tracking.resolution.submit": "مراجعة الربط",
  "tracking.resolution.confirm": {
    zero: "ربط هوية بكل سطر؟ الربط نهائي ولا يُلغى.",
    one: "ربط هوية بالسطر؟ الربط نهائي ولا يُلغى.",
    two: "ربط هوية بالسطرين؟ الربط نهائي ولا يُلغى.",
    few: "ربط هوية بالأسطر الـ{count}؟ الربط نهائي ولا يُلغى.",
    many: "ربط هوية بالأسطر الـ{count}؟ الربط نهائي ولا يُلغى.",
    other: "ربط هوية بالأسطر الـ{count}؟ الربط نهائي ولا يُلغى.",
  },
  "tracking.resolution.confirmYes": "تأكيد الربط",
  "tracking.resolution.recorded": {
    zero: "سُجّل الربط.",
    one: "سُجّل الربط على سطر واحد.",
    two: "سُجّل الربط على سطرين.",
    few: "سُجّل الربط على {count} أسطر.",
    many: "سُجّل الربط على {count} سطرًا.",
    other: "سُجّل الربط على {count} سطر.",
  },
  "tracking.saleLines.title": "نتائج أسطر البيع",
  "tracking.saleLines.intro":
    "سجلات ثابتة لما حدث وقت البيع: بيع تحت حجز، وسطر متتبَّع بلا تحقق، وقيد ERPNext معلّق. لا تُحذف بعد إصلاح السبب، ولا تدخل في أعداد الشريط.",
  "tracking.saleLines.caption": "نتائج أسطر البيع، الأحدث تسجيلًا أولًا",
  "tracking.saleLines.loadingNoun": "نتائج أسطر البيع",
  "tracking.saleLines.loadFailed": "تعذّر تحميل نتائج أسطر البيع.",
  "tracking.saleLines.empty": "لا توجد نتائج مسجَّلة لأسطر البيع.",
  "tracking.saleLines.kindLabel": "النوع",
  "tracking.saleLines.kindAll": "كل الأنواع",
  "tracking.saleLines.col.kind": "النوع",
  "tracking.saleLines.col.cause": "السبب",
  "tracking.saleLines.col.recordedAt": "سُجّلت في",
  "tracking.saleLines.kind.unvalidated_tracked_line": "سطر متتبَّع بلا تحقق",
  "tracking.saleLines.kind.sold_under_hold": "بيع تحت حجز",
  "tracking.saleLines.kind.erp_intent_held": "قيد ERPNext معلّق",
  "tracking.saleLines.cause.validation_missing": "لا رقم تحقق",
  "tracking.saleLines.cause.validation_mismatch": "رقم التحقق لا يطابق الهوية",
  "tracking.saleLines.cause.quality_hold": "حجز جودة",
  "tracking.saleLines.cause.recall_hold": "حجز استدعاء",
  "tracking.saleLines.cause.expired": "الدفعة منتهية",
  "tracking.saleLines.cause.edge_map_missing": "لا ربط لها بدفعة ERPNext",
  "tracking.consistency.unavailable.title": "فحص اتساق التتبع غير متاح",
  "tracking.consistency.unavailable.body":
    "لا يُصدر الخادم نتائج هذا الفحص بعد، فلا يعني غيابها أن السجلات متّسقة.",
  "tracking.manager.readOnly":
    "تسجيل الاستدعاء ووضع الحجز متاحان لمالك المؤسسة ومسؤولها. الصفوف تعرض حقول النتيجة فقط.",
  "tracking.manager.queueCount": "المبيعات التي تنتظر ربط هوية في متاجرك:",
  "tracking.manager.queueCountFailed":
    "تعذّر تحميل عدد المبيعات التي تنتظر ربط هوية. العدد غير معروف.",

  // --- Consistency (critical) -------------------------------------------------------------
  "tracking.consistency.title": {
    zero: "نتائج فحص اتساق التتبع",
    one: "نتيجة واحدة لفحص اتساق التتبع",
    two: "نتيجتان لفحص اتساق التتبع",
    few: "{count} نتائج لفحص اتساق التتبع",
    many: "{count} نتيجة لفحص اتساق التتبع",
    other: "{count} نتيجة لفحص اتساق التتبع",
  },
  "tracking.consistency.body": "سجلات صنف متتبَّع أو هوية لا تتفق. يحسبها الخادم؛ تُعالَج من مصدرها.",

  // --- Released holds ---------------------------------------------------------------------
  "tracking.released.caption": "الحجوزات المرفوعة، الأحدث أولًا",
  "tracking.released.empty": "لا توجد حجوزات مرفوعة.",
  "tracking.released.loadingNoun": "الحجوزات المرفوعة",
  "tracking.released.loadFailed": "تعذّر تحميل الحجوزات المرفوعة.",
  "tracking.released.loadMore": "تحميل المزيد من الحجوزات",

  // --- Recalls -----------------------------------------------------------------------------
  "tracking.recalls.caption": "الاستدعاءات، الأحدث أولًا",
  "tracking.recalls.empty": "لا توجد استدعاءات.",
  "tracking.recalls.loadingNoun": "الاستدعاءات",
  "tracking.recalls.loadFailed": "تعذّر تحميل الاستدعاءات.",
  "tracking.recalls.loadMore": "تحميل المزيد من الاستدعاءات",
  "tracking.recalls.holdCount": "{active} من {total}",
  "tracking.recalls.openLabel": "عرض الاستدعاء {reference}",

  // --- Drawers ------------------------------------------------------------------------------
  "tracking.hold.title": "{kind} · {state}",
  "tracking.hold.titleLoading": "الحجز",
  "tracking.hold.scope": "يسري في كل المتاجر",
  "tracking.hold.active": "نشط",
  "tracking.hold.released": "مرفوع",
  "tracking.hold.loadingNoun": "الحجز",
  "tracking.hold.loadFailed": "تعذّر تحميل الحجز.",
  "tracking.hold.notFound": "هذا الحجز غير متاح.",
  "tracking.release.ownerNote":
    "رفع الحجز يعيد المخزون المحجوز إلى «قابل للبيع»، أو إلى «حجز استدعاء» إن كانت الدفعة قد استُدعيت من قبل. الرفع نهائي.",
  "tracking.release.ownerOnly": "رفع الحجز متاح لمالك المؤسسة فقط. اطلب منه رفعه إن لزم.",
  "tracking.recall.title": "استدعاء",
  "tracking.recall.scope": "يسري في كل المتاجر ولا يُخرج الصنف من الكتالوج",
  "tracking.recall.loadingNoun": "الاستدعاء",
  "tracking.recall.loadFailed": "تعذّر تحميل الاستدعاء.",
  "tracking.recall.notFound": "هذا الاستدعاء غير متاح.",
  "tracking.recall.holdsCaption": "حجوزات الاستدعاء",
  "tracking.recall.note": "رفع حجز الاستدعاء لا يعيد المخزون للبيع: يخرج عبر التصرف.",

  // --- Identity detail ---------------------------------------------------------------------
  "tracking.identity.back": "العودة",
  "tracking.identity.titleLoading": "الدفعة",
  "tracking.identity.sub": "{kind} · {product}",
  "tracking.identity.loadingNoun": "الدفعة",
  "tracking.identity.loadFailed": "تعذّر تحميل الدفعة.",
  "tracking.identity.notFound": "هذه الدفعة غير متاحة.",
  "tracking.identity.open": "فتح الدفعة",
  "tracking.identity.openLabel": "فتح الدفعة {id}",
  "tracking.identity.data": "بيانات الدفعة",
  "tracking.identity.originErp": "ERPNext · تُنشأ الدفعات هناك فقط ولا تُعدَّل من هنا.",
  "tracking.identity.holds": "الحجوزات",
  "tracking.identity.noActiveHold": "لا حجز نشط على هذه الدفعة.",
  "tracking.identity.heldSince": "{kind} نشط منذ",
  "tracking.identity.holdsCaption": "سجل حجوزات الدفعة، الأحدث أولًا",
  "tracking.identity.holdsNoun": "الحجوزات",
  "tracking.identity.holdsEmpty": "لم يوضع على هذه الدفعة حجز قط.",
  "tracking.identity.holdsFailed": "تعذّر تحميل حجوزات الدفعة. حالة الحجز غير معروفة.",
  "tracking.identity.holdsMore": "تحميل المزيد من الحجوزات",
  "tracking.identity.correctionsEmpty": "لا تصحيحات لتاريخ الانتهاء.",
  "tracking.identity.correctionsFailed": "تعذّر تحميل سجل التصحيحات.",

  // --- Positions ----------------------------------------------------------------------------
  "tracking.positions.title": "المخزون من هذه الدفعة في المتاجر",
  "tracking.positions.caption": "الكمية حسب المتجر والوحدة والحالة لهذه الدفعة",
  "tracking.positions.total": "الإجمالي",
  "tracking.positions.loadingNoun": "المخزون",
  "tracking.positions.loadFailed": "تعذّر تحميل مخزون الدفعة. الكميات غير معروفة.",
  "tracking.positions.empty": "لا حركة مخزون لهذه الدفعة بعد.",
  "tracking.positions.note":
    "مجموع مواقع التخزين في كل متجر: +5 في موقع و−5 في آخر تظهر 0. الكميات كما يرسلها الخادم.",

  // --- Expiry corrections --------------------------------------------------------------------
  "tracking.corrections.title": "تصحيح تاريخ الانتهاء",
  "tracking.corrections.note":
    "يُحفظ كل تصحيح في السجل: التاريخ القديم والجديد والسبب ومن صحّحه. يسري على الدفعة في كل المتاجر.",
  "tracking.corrections.caption": "سجل التصحيحات، الأحدث أولًا",
  "tracking.corrections.loadingNoun": "سجل التصحيحات",
  "tracking.corrections.loadMore": "تحميل المزيد من التصحيحات",
  "tracking.corrections.old": "التاريخ القديم",
  "tracking.corrections.new": "التاريخ الجديد",
  "tracking.corrections.by": "صحّحه",

  // --- No tracked products ------------------------------------------------------------------
  "tracking.notTracked.title": "لا توجد أصناف متتبَّعة في هذه المؤسسة.",
  "tracking.notTracked.body":
    "يظهر هذا القسم حين يكون لصنف واحد على الأقل ملف تتبع بالدفعة أو بالرقم التسلسلي.",
  // --- Commands (owner approval, RT-455 comment 15245) ------------------------------
  "tracking.write.reason": "السبب",
  "tracking.write.reasonChoose": "اختر السبب",
  "tracking.write.note": "ملاحظة",
  "tracking.write.noteOptional": "اختيارية، حتى 500 حرف. لا تكتب بيانات شخصية.",
  "tracking.write.noteRequired": "مطلوبة مع «أخرى»، حتى 500 حرف. لا تكتب بيانات شخصية.",
  "tracking.write.error.reason": "اختر سببًا من القائمة.",
  "tracking.write.error.noteRequired": "اكتب ملاحظة تشرح السبب «أخرى».",
  "tracking.write.error.noteLength": "الملاحظة أطول من 500 حرف.",
  "tracking.write.error.reference": "اكتب المرجع، من 1 إلى 200 حرف.",
  "tracking.write.error.identities": "اختر دفعة واحدة على الأقل.",
  "tracking.write.error.tooMany": "يمكن استدعاء 100 دفعة على الأكثر في المرة الواحدة.",
  "tracking.write.error.effectiveAt": "وقت السريان الآن أو وقت سابق، لا وقت لاحق.",
  "tracking.write.error.date": "اكتب التاريخ بالصيغة سنة-شهر-يوم.",
  "tracking.write.error.dateRequired": "اختر التاريخ الجديد، أو اختر مسح تاريخ الانتهاء.",
  "tracking.write.rejected": "لم يُسجَّل شيء",
  "tracking.write.noBody": "رفض الخادم الأمر (الحالة {status}) دون رسالة.",
  "tracking.write.code": "الرمز: {code}",
  "tracking.write.failed":
    "لم يصل أي رد، فلا يُعرف إن كان الأمر قد سُجّل. إعادة المحاولة بالأمر نفسه آمنة: لن يُسجَّل مرتين.",
  "tracking.write.hint.notFound":
    "الخادم لم يجد هذه الدفعة. أوامر التتبع لا تعمل قبل استيراد الدفعات من ERPNext.",
  "tracking.write.hint.forbidden": "هذا الأمر غير متاح لدورك.",
  "tracking.write.hint.bindNotFound":
    "لم يجد الخادم هذا البيع أو إحدى الهويات، أو لم يعد بانتظار الربط. لم يُسجَّل شيء.",
  "tracking.write.hint.resolutionMismatch": "إحدى الهويات ليست لصنف سطرها. لم يُسجَّل شيء.",
  "tracking.write.hint.resolutionHeld": "على إحدى الهويات حجز نشط الآن أو وقت البيع. لم يُسجَّل شيء.",
  "tracking.write.hint.resolutionExpired": "إحدى الهويات منتهية قبل يوم عمل البيع. لم يُسجَّل شيء.",
  "tracking.write.hint.resolutionResolved": "رُبط هذا البيع من قبل بأمر آخر. أعد قراءة القائمة.",
  "tracking.write.error.bindNote": "اكتب ملاحظة تشرح الربط، فهي مطلوبة.",
  "tracking.write.error.bindLines": "اختر هوية لكل سطر.",
  "tracking.write.hint.holdActive":
    "على هذه الدفعة حجز نشط من النوع نفسه، فلم يُسجَّل شيء. افتح الحجز القائم من قائمة الحجوزات النشطة.",
  "tracking.write.hint.expiryUnchanged": "هذا هو تاريخ الانتهاء الحالي، فلم يُسجَّل تصحيح.",
  "tracking.write.cancel": "إلغاء",
  "tracking.write.close": "إغلاق",
  "tracking.placeHold.open": "وضع حجز جودة",
  "tracking.placeHold.title": "وضع حجز جودة",
  "tracking.placeHold.scope": "{code} · كل المتاجر",
  "tracking.placeHold.effect":
    "يُنقل ما في «قابل للبيع» و«فحص مرتجع» من هذه الدفعة إلى «حجز جودة» في كل المتاجر، والدفعة المحجوزة لا تُباع. رفع الحجز لمالك المؤسسة فقط.",
  "tracking.placeHold.submit": "وضع الحجز",
  "tracking.placeHold.recorded": "وُضع حجز جودة على {code}. تُعاد قراءة الحجوزات والكميات من الخادم.",
  "tracking.release.submit": "رفع الحجز",
  "tracking.release.confirm":
    "رفع الحجز عن {code}؟ يعود مخزونها إلى «قابل للبيع»، أو إلى «حجز استدعاء» إن كانت قد استُدعيت من قبل.",
  "tracking.release.yes": "نعم، ارفع الحجز",
  "tracking.release.recorded": "رُفع الحجز عن {code}. تُعاد قراءة الحجوزات والكميات من الخادم.",
  "tracking.recallCreate.open": "تسجيل استدعاء",
  "tracking.recallCreate.title": "تسجيل استدعاء",
  "tracking.recallCreate.pickProduct": "اختر الصنف المستدعى، ثم دفعاته.",
  "tracking.recallCreate.changeProduct": "تغيير الصنف",
  "tracking.recallCreate.identities": "الدفعات المستدعاة",
  "tracking.recallCreate.identitiesHelp": {
    zero: "من 1 إلى {max} دفعة. لم تُختر أي دفعة.",
    one: "من 1 إلى {max} دفعة. اختيرت دفعة واحدة.",
    two: "من 1 إلى {max} دفعة. اختيرت دفعتان.",
    few: "من 1 إلى {max} دفعة. اختيرت {count} دفعات.",
    many: "من 1 إلى {max} دفعة. اختيرت {count} دفعة.",
    other: "من 1 إلى {max} دفعة. اختيرت {count} دفعة.",
  },
  "tracking.recallCreate.identitiesNoun": "الدفعات",
  "tracking.recallCreate.identitiesFailed": "تعذّر تحميل دفعات الصنف.",
  "tracking.recallCreate.identitiesEmpty": "لا توجد دفعات أو أرقام تسلسلية مسجّلة لهذا الصنف.",
  "tracking.recallCreate.identitiesMore": "تحميل المزيد من الدفعات",
  "tracking.recallCreate.referenceHelp": "رقم الإشعار الخارجي، مثل إشعار جهة رسمية. حتى 200 حرف.",
  "tracking.recallCreate.effectiveHelp": "اتركه فارغًا ليسري الآن، أو اختر وقتًا سابقًا.",
  "tracking.recallCreate.effect":
    "يُنقل ما في «قابل للبيع» و«فحص مرتجع» من هذه الدفعات إلى «حجز استدعاء» في كل المتاجر. رفع حجز الاستدعاء لاحقًا لا يعيده.",
  "tracking.recallCreate.submit": "تسجيل الاستدعاء",
  "tracking.recallCreate.recorded": {
    zero: "سُجّل الاستدعاء. تُعاد قراءة الحجوزات من الخادم.",
    one: "سُجّل الاستدعاء ووُضع حجز استدعاء على دفعة واحدة. تُعاد قراءة الحجوزات من الخادم.",
    two: "سُجّل الاستدعاء ووُضع حجز استدعاء على دفعتين. تُعاد قراءة الحجوزات من الخادم.",
    few: "سُجّل الاستدعاء ووُضع حجز استدعاء على {count} دفعات. تُعاد قراءة الحجوزات من الخادم.",
    many: "سُجّل الاستدعاء ووُضع حجز استدعاء على {count} دفعة. تُعاد قراءة الحجوزات من الخادم.",
    other: "سُجّل الاستدعاء ووُضع حجز استدعاء على {count} دفعة. تُعاد قراءة الحجوزات من الخادم.",
  },
  "tracking.identity.viewHold": "عرض الحجز",
  "tracking.expiry.newDate": "تاريخ الانتهاء الجديد",
  "tracking.expiry.current": "التاريخ الحالي: {date}.",
  "tracking.expiry.currentNone": "لا تاريخ انتهاء مسجّل الآن.",
  "tracking.expiry.clear": "مسح تاريخ الانتهاء (يرفضه الخادم إن كان ملف التتبع يتطلبه)",
  "tracking.expiry.submit": "تسجيل التصحيح",
  "tracking.expiry.recorded":
    "صُحّح تاريخ الانتهاء إلى {date}. حُفظ التصحيح في السجل مع التاريخ القديم والسبب.",
  "tracking.expiry.cleared": "مُسح تاريخ الانتهاء. حُفظ التصحيح في السجل مع التاريخ القديم والسبب.",
  "tracking.corrections.history": "سجل التصحيحات",
};
