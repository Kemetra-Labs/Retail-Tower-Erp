/**
 * Arabic copy for the redistribution proposals screens (RT-1601, W9 slice A).
 *
 * Glossary: redistribution proposal → «مقترح إعادة التوزيع»; compute → «حساب مقترح»; shipment
 * Transfer → «تحويل» and its draft state → «مسودة» (as in `transfers`); Store → «المتجر», never
 * «الفرع»; product on a line → «المنتج» (owner decision, RT-1515 PR 2). A proposal is advice: no copy
 * may say stock moved, was reserved or was approved. Accept creates DRAFT transfers only, and each line
 * is re-checked, so the result is described line by line, never as "everything moved". The 404 while
 * the feature is off is non-disclosing: say "not available", never why.
 */
export const redistribution = {
  "redistribution.nav.label": "إعادة توزيع المخزون",
  "redistribution.title": "مقترحات إعادة توزيع المخزون",
  "redistribution.sub":
    "مقترحات لنقل كميات من متجر لديه فائض إلى متجر أقل من حد إعادة الطلب، الأحدث أولًا.",
  "redistribution.note.advice":
    "المقترح توصية فقط: لا يغيّر المخزون ولا يحجز شيئًا. القبول ينشئ تحويلات في حالة مسودة، واعتمادها وشحنها يتمّان من شاشة التحويلات.",
  "redistribution.scopePrompt": "اختر مؤسسة لعرض مقترحات إعادة التوزيع.",
  "redistribution.notAvailable": "مقترحات إعادة التوزيع غير متاحة لهذه المؤسسة.",
  "redistribution.back": "مقترحات إعادة التوزيع",

  "redistribution.compute.action": "حساب مقترح جديد",
  "redistribution.compute.nothing": "لا يحتاج أي متجر إلى نقل كميات الآن، ولم يُحفظ مقترح جديد.",
  "redistribution.compute.nothingReplaced":
    "لا يحتاج أي متجر إلى نقل كميات الآن. لم يُحفظ مقترح جديد، وانتهى المقترح المفتوح السابق لأن حسابًا أحدث حلّ محله.",

  "redistribution.list.caption": "مقترحات إعادة التوزيع",
  "redistribution.list.label": "المقترحات",
  "redistribution.list.col.created": "وقت الإنشاء",
  "redistribution.list.col.state": "الحالة",
  "redistribution.list.col.objective": "النقص والحجم",
  "redistribution.list.col.excluded": "متاجر مستبعدة",
  "redistribution.list.col.warnings": "تنبيهات",
  "redistribution.list.col.actions": "إجراءات",
  "redistribution.list.open": "فتح",
  "redistribution.list.openLabel": "فتح مقترح {time}",
  "redistribution.list.empty": "لا توجد مقترحات بعد.",
  "redistribution.list.emptyHint": "احسب مقترحًا ليقترح النظام كميات تُنقل بين المتاجر.",
  "redistribution.list.more": "عرض مقترحات أقدم",

  "redistribution.state.open": "مفتوح",
  "redistribution.state.reviewed": "قيد المراجعة",
  "redistribution.state.partially_accepted": "مقبول جزئيًا",
  "redistribution.state.accepted": "مقبول",
  "redistribution.state.rejected": "مرفوض",
  "redistribution.state.expired": "منتهي الصلاحية",
  "redistribution.state.superseded": "حلّ محله مقترح أحدث",
  "redistribution.state.unknown": "حالة غير معروفة",

  "redistribution.objective.before": "النقص قبل",
  "redistribution.objective.after": "النقص بعد",
  "redistribution.objective.pairs": "أزواج المتاجر",
  "redistribution.objective.lines": "السطور",

  "redistribution.detail.title": "مقترح إعادة التوزيع",
  "redistribution.detail.computedAt": "وقت الحساب",
  "redistribution.detail.expiresAt": "ينتهي في",
  "redistribution.detail.rejectReason": "سبب الرفض: {reason}",
  "redistribution.phase.shadow":
    "مرحلة التجربة: سجّل لكل سطر «سأقبله» أو «سأرفضه». لا يُنشأ أي تحويل في هذه المرحلة.",
  "redistribution.phase.live":
    "المرحلة الفعلية: السطور التي تقبلها تصبح تحويلات في حالة مسودة. لا يُعتمد أي تحويل ولا يُشحن من هنا.",

  "redistribution.lines.title": "السطور المقترحة",
  "redistribution.lines.caption": "السطور المقترحة",
  "redistribution.lines.col.select": "اختيار للقبول",
  "redistribution.lines.col.product": "المنتج",
  "redistribution.lines.col.route": "من ← إلى",
  "redistribution.lines.col.quantity": "الكمية",
  "redistribution.lines.col.warnings": "تنبيهات",
  "redistribution.lines.col.review": "المراجعة",
  "redistribution.lines.col.outcome": "نتيجة القبول",
  "redistribution.lines.route": "من {source} إلى {destination}",
  "redistribution.lines.rowLabel": "مراجعة سطر {product}",
  "redistribution.lines.select": "اختيار سطر {product} للقبول",

  "redistribution.review.wouldAccept": "سأقبله",
  "redistribution.review.wouldReject": "سأرفضه",
  "redistribution.review.none": "لم يُراجع",
  "redistribution.review.done": "تم تسجيل المراجعة.",

  "redistribution.outcome.created": "أُنشئ في مسودة",
  "redistribution.outcome.reduced": "أُنشئ بكمية أقل",
  "redistribution.outcome.dropped": "لم يُنشأ",
  "redistribution.outcome.unknown": "نتيجة غير معروفة",
  "redistribution.outcome.quantity": "الكمية في المسودة:",

  "redistribution.reason.source_not_fresh": "بيانات المتجر المصدر لم تعد حديثة.",
  "redistribution.reason.source_available_insufficient":
    "المتاح في المتجر المصدر لم يعد يكفي بعد التحويلات المفتوحة.",
  "redistribution.reason.destination_gap_closed": "المتجر المستلم لم يعد يحتاج هذه الكمية.",
  "redistribution.reason.product_not_sellable": "المنتج لم يعد قابلًا للبيع في أحد المتجرين.",
  "redistribution.reason.stocking_unit_changed": "تغيّرت وحدة التخزين المعتمدة للمنتج.",
  "redistribution.reason.transfer_rule_refused": "قاعدة من قواعد التحويل لا تسمح بهذا السطر.",
  "redistribution.reason.unknown": "سبب غير معروف.",

  "redistribution.stores.title": "المتاجر المقروءة",
  "redistribution.stores.caption": "المتاجر ووقت قراءة مخزونها",
  "redistribution.stores.col.store": "المتجر",
  "redistribution.stores.col.readAt": "وقت القراءة",
  "redistribution.stores.col.source": "يصلح مصدرًا",
  "redistribution.stores.eligible": "نعم",
  "redistribution.stores.notEligible": "لا",

  "redistribution.exclusion.pos_queue_unknown": "حالة مبيعات نقطة البيع غير معروفة",
  "redistribution.exclusion.pos_queue_dead_letter_or_held": "مبيعات عالقة أو موقوفة في نقطة البيع",
  "redistribution.exclusion.device_heartbeat_stale": "جهاز نقطة البيع لم يتصل منذ مدة",
  "redistribution.exclusion.inactive": "المتجر غير نشط",
  "redistribution.exclusion.unknown": "مستبعد لسبب غير معروف",

  "redistribution.warnings.title": "تنبيهات الحساب",
  "redistribution.warnings.none": "لا توجد تنبيهات.",
  "redistribution.warnings.count": {
    zero: "{count} منتج",
    one: "منتج واحد",
    two: "منتجان",
    few: "{count} منتجات",
    many: "{count} منتجًا",
    other: "{count} منتج",
  },
  "redistribution.warning.store_excluded_as_source": "متجر مستبعد كمصدر",
  "redistribution.warning.negative_available_to_sell": "رصيد متاح للبيع بالسالب",
  "redistribution.warning.reorder_level_missing": "حد إعادة الطلب غير محدد",
  "redistribution.warning.tracked_product_skipped": "منتج متتبَّع لم يُشمل",
  "redistribution.warning.stocking_unit_mismatch": "وحدة تخزين غير متطابقة",
  "redistribution.warning.source_near_reorder_level": "المصدر يقترب من حد إعادة الطلب",
  "redistribution.warning.unknown": "تنبيه غير معروف",

  "redistribution.accept.openNone": "قبول السطور المختارة",
  "redistribution.accept.open": {
    zero: "قبول السطور المختارة",
    one: "قبول السطر المختار",
    two: "قبول السطرين المختارين",
    few: "قبول {count} سطور مختارة",
    many: "قبول {count} سطرًا مختارًا",
    other: "قبول {count} سطر مختار",
  },
  "redistribution.accept.title": "قبول السطور في تحويلات مسودة",
  "redistribution.accept.consequence": {
    zero: "لم تختر أي سطر.",
    one: "سيصبح السطر المختار تحويلًا في حالة مسودة. لا يُعتمد ولا يُشحن ولا يُحجز أي مخزون.",
    two: "سيصبح السطران المختاران تحويلات في حالة مسودة. لا يُعتمد ولا يُشحن ولا يُحجز أي مخزون.",
    few: "ستصبح {count} سطور مختارة تحويلات في حالة مسودة. لا يُعتمد ولا يُشحن ولا يُحجز أي مخزون.",
    many: "سيصبح {count} سطرًا مختارًا تحويلات في حالة مسودة. لا يُعتمد ولا يُشحن ولا يُحجز أي مخزون.",
    other: "سيصبح {count} سطر مختار تحويلات في حالة مسودة. لا يُعتمد ولا يُشحن ولا يُحجز أي مخزون.",
  },
  "redistribution.accept.recheck":
    "يُعاد فحص كل سطر مقابل المخزون الحالي، فقد يُنشأ بكمية أقل أو لا يُنشأ، مع ذكر السبب.",
  "redistribution.accept.commit": {
    zero: "تأكيد القبول",
    one: "تأكيد قبول السطر",
    two: "تأكيد قبول السطرين",
    few: "تأكيد قبول {count} سطور",
    many: "تأكيد قبول {count} سطرًا",
    other: "تأكيد قبول {count} سطر",
  },
  "redistribution.accept.done": "تم إنشاء التحويلات في حالة مسودة.",
  "redistribution.accept.resultCounts":
    "أُنشئ كاملًا: {created} · أُنشئ بكمية أقل: {reduced} · لم يُنشأ: {dropped}",
  "redistribution.accept.resultTransfers":
    "التحويلات المنشأة في حالة مسودة (اعتمادها من شاشة التحويلات):",
  "redistribution.transfer.openLabel": "فتح شاشة التحويلات للتحويل {id}",

  "redistribution.reject.open": "رفض المقترح",
  "redistribution.reject.title": "رفض المقترح",
  "redistribution.reject.consequence":
    "سينتهي المقترح ولن يُقبل أي سطر آخر منه. السطور المقبولة سابقًا تبقى تحويلاتها في حالة مسودة كما هي.",
  "redistribution.reject.reason": "سبب الرفض",
  "redistribution.reject.reasonHint": "مطلوب، حتى {max} حرف.",
  "redistribution.reject.commit": "تأكيد رفض المقترح",
  "redistribution.reject.done": "تم رفض المقترح.",

  "redistribution.dialog.cancel": "إلغاء",
  "redistribution.dialog.done": "تم",

  "redistribution.error.validation": "رفض الخادم بيانات الطلب، ولم يُسجَّل شيء.",
  "redistribution.error.session": "انتهت جلستك. سجّل الدخول مرة أخرى.",
  "redistribution.error.origin":
    "رُفض الطلب لأنه لم يصدر من هذه الشاشة. أعد تحميل الصفحة ثم حاول مرة أخرى.",
  "redistribution.error.notAvailable": "هذا المقترح أو هذا الإجراء غير متاح.",
  "redistribution.error.superseded":
    "حلّ محل هذا المقترح مقترح أحدث، ولم يُسجَّل شيء. افتح أحدث مقترح.",
  "redistribution.error.expired": "انتهت صلاحية هذا المقترح، ولم يُسجَّل شيء. احسب مقترحًا جديدًا.",
  "redistribution.error.stateConflict": "اتُّخذ قرار نهائي في هذا المقترح، ولم يُسجَّل شيء.",
  "redistribution.error.lineDecided":
    "أحد السطور له نتيجة قبول من قبل، ولم يُسجَّل شيء. أعدنا قراءة المقترح.",
  "redistribution.error.stale":
    "لم يعد أي من السطور المختارة صالحًا مقابل المخزون الحالي، ولم يُنشأ أي تحويل. احسب مقترحًا جديدًا.",
  "redistribution.error.tooLarge":
    "عدد المتاجر أو المنتجات أكبر من حد المقترح الواحد، ولم يُحفظ شيء.",
  "redistribution.error.deadline":
    "استغرق الحساب وقتًا أطول من المسموح، ولم يُحفظ شيء. حاول مرة أخرى لاحقًا.",
  "redistribution.error.planInvalid":
    "رفض فحص التحقق الخطة المحسوبة، ولم يُحفظ شيء. راسل الدعم مع المرجع.",
  "redistribution.error.uncertain":
    "لم يصل رد واضح، وقد يكون الطلب سُجّل. أعد المحاولة الآن بالزر نفسه: يُعيد إرسال الطلب نفسه.",
  "redistribution.error.rateLimited":
    "طلبات كثيرة في وقت قصير، ولم يُنفَّذ شيء. انتظر قليلًا ثم أعد المحاولة.",
  "redistribution.error.generic": "تعذّر تنفيذ الطلب، ولم يُسجَّل شيء.",
  "redistribution.error.loadFailed": "تعذّر تحميل مقترحات إعادة التوزيع.",
  "redistribution.error.refreshFailed":
    "تعذّرت إعادة قراءة المقترح، فقد يكون المعروض قديمًا. أعد المحاولة قبل اتخاذ القرار.",
} as const;
