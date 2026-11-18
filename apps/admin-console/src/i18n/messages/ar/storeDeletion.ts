import type { Messages } from "../types";

/**
 * Arabic copy for the owner's store deletion (RT-1437 A2, RT-1441 U2). Arabic is the primary
 * authored language (UX-12.2); the sentences marked "A2" are the owner-approved copy of the decision
 * record (Confluence 80084994), verbatim. Verb jurisdiction (UX-12.7): «حذف» is the action on the
 * store, «تأكيد» crosses the consequence boundary, «إلغاء» cancels the workflow, «إيقاف» is the
 * reversible alternative. Times and counts render through components or `{count}` plurals, never
 * baked into prose. The server's words never show: every refusal is one of these keys.
 */
export const storeDeletion = {
  // --- The danger zone on the store page -------------------------------------
  "storeDeletion.zone.title": "حذف المتجر",
  // A2, verbatim.
  "storeDeletion.zone.suspendInstead": "إيقاف المتجر بدلًا من حذفه يمكن التراجع عنه.",
  "storeDeletion.zone.alreadySuspended":
    "هذا المتجر موقوف بالفعل. الإيقاف يمكن التراجع عنه، أما الحذف فلا.",
  "storeDeletion.zone.suspendConfirm":
    "إيقاف {name}؟ يمكنك إعادة تفعيله لاحقًا من صفحة تعديل المتجر.",
  "storeDeletion.zone.suspendFailed": "تعذّر إيقاف المتجر. لم يتغير شيء.",
  "storeDeletion.zone.suspendUnclear":
    "تعذّر التأكد من إيقاف المتجر. أعد تحميل الصفحة للتحقق من حالته.",
  // A2, verbatim.
  "storeDeletion.zone.delete": "حذف المتجر…",

  // --- The dialog ------------------------------------------------------------
  "storeDeletion.title": "حذف المتجر",
  // A2, verbatim.
  "storeDeletion.consequence":
    "سيختفي هذا المتجر من القوائم، وستتوقف كل أجهزته عن الاتصال فورًا. المبيعات والورديات والمستندات السابقة تبقى كما هي. لا توجد طريقة مدعومة لاستعادة المتجر.",
  "storeDeletion.irreversible": "الحذف نهائي ولا يمكن التراجع عنه.",
  "storeDeletion.suspendHint":
    "إن أردت إيقاف العمل مؤقتًا فقط، أغلق هذه النافذة وأوقف المتجر؛ يمكن إعادة تفعيله لاحقًا.",
  "storeDeletion.loading": "جارٍ فحص أثر الحذف…",
  "storeDeletion.previewFailed": "تعذّر فحص أثر الحذف. لم يتغير شيء.",
  "storeDeletion.error.previewNotAvailable":
    "هذا الإجراء غير متاح لصلاحياتك، أو أن المتجر غير موجود.",
  "storeDeletion.error.previewOwnerOnly": "حذف المتجر متاح لصاحب الحساب فقط.",
  "storeDeletion.retry": "إعادة المحاولة",
  "storeDeletion.snapshot": "حتى {time}. هذه لقطة لا حجز: يقرّر الخادم مرة أخرى عند التأكيد.",

  // --- What the preview shows ------------------------------------------------
  "storeDeletion.fact.store": "المتجر",
  "storeDeletion.fact.code": "الرمز",
  "storeDeletion.fact.state": "الحالة",
  "storeDeletion.fact.openShifts": "ورديات مفتوحة",
  "storeDeletion.fact.devices": "الأجهزة",
  "storeDeletion.fact.openCounts": "جلسات جرد مفتوحة",
  "storeDeletion.fact.warehouses": "ربط مستودعات نظام المحاسبة (يبقى)",
  "storeDeletion.fact.members": "أعضاء لا يملكون غير هذا المتجر",
  "storeDeletion.fact.offers": "عروض تُعاد بناء حزمتها",
  "storeDeletion.devices.heading": "أجهزة المتجر",
  "storeDeletion.device.noLabel": "جهاز بلا تسمية",
  "storeDeletion.device.lastSeen": "آخر ظهور: {time}",
  "storeDeletion.device.neverSeen": "لم يتصل قط",
  "storeDeletion.device.queueUnknown": "المبيعات غير المرسلة: غير معروفة",
  "storeDeletion.device.queue": "غير مرسلة {pending} · متعثرة {deadLetter} · محجوزة {held}",
  "storeDeletion.heading.willChange": "ما سيتغير",
  "storeDeletion.heading.willNotChange": "ما لن يتغير",
  "storeDeletion.effect.willChange.store_hidden_from_lists": "يختفي المتجر من القوائم.",
  "storeDeletion.effect.willChange.devices_refused_immediately": "تُرفض كل أجهزة المتجر فورًا.",
  "storeDeletion.effect.willChange.offer_packs_rebuilt": "تُعاد بناء حزم العروض التي يشملها المتجر.",
  "storeDeletion.effect.willChange.single_store_members_lose_access":
    "يفقد كل عضو لا يملك غير هذا المتجر وصوله إلى المتاجر.",
  "storeDeletion.effect.willChange.count_readiness_excludes_store":
    "لا يُحتسب المتجر بعد الآن في جاهزية الجرد.",
  "storeDeletion.effect.willChange.inventory_activation_excludes_store":
    "لا يُحتسب المتجر بعد الآن في تفعيل أثر المخزون.",
  "storeDeletion.effect.willNotChange.sales_unchanged": "المبيعات المسجلة تبقى كما هي.",
  "storeDeletion.effect.willNotChange.shifts_unchanged": "الورديات المسجلة تبقى كما هي.",
  "storeDeletion.effect.willNotChange.stock_movements_unchanged": "حركات المخزون تبقى كما هي.",
  "storeDeletion.effect.willNotChange.erp_documents_unchanged":
    "لا يُنشأ ولا يُعدَّل أي مستند في نظام المحاسبة.",
  "storeDeletion.effect.willNotChange.warehouse_mapping_kept":
    "ربط المستودعات بنظام المحاسبة يبقى محفوظًا.",
  "storeDeletion.effect.unknown": "تغييرات أخرى يذكرها الخادم ولا تعرضها هذه الواجهة بعد.",
  "storeDeletion.caveat.offline_facts_not_visible":
    "لا يرى الخادم ما لم يزامنه الجهاز بعد: قد توجد مبيعات أو حركات غير مرسلة.",
  "storeDeletion.caveat.queue_as_of_last_heartbeat":
    "أعداد المبيعات غير المرسلة حتى آخر إشارة أرسلها كل جهاز، وليست لحظية.",
  "storeDeletion.caveat.unknown": "لا يرى الخادم كل ما يعرفه الجهاز.",

  // --- The blockers, each with the link to its fix ---------------------------
  "storeDeletion.blockedIntro": "لا يمكن حذف المتجر الآن:",
  "storeDeletion.blocker.store_has_open_shift": {
    zero: "في المتجر ورديات مفتوحة. أغلقها أولًا.",
    one: "في المتجر وردية مفتوحة واحدة. أغلقها أولًا.",
    two: "في المتجر ورديتان مفتوحتان. أغلقهما أولًا.",
    few: "في المتجر {count} ورديات مفتوحة. أغلقها أولًا.",
    many: "في المتجر {count} وردية مفتوحة. أغلقها أولًا.",
    other: "في المتجر {count} وردية مفتوحة. أغلقها أولًا.",
  },
  "storeDeletion.blocker.store_has_unretired_device": {
    zero: "في المتجر أجهزة ما زالت في الخدمة. أخرِجها من الخدمة أولًا.",
    one: "في المتجر جهاز واحد ما زال في الخدمة. أخرِجه من الخدمة أولًا.",
    two: "في المتجر جهازان ما زالا في الخدمة. أخرِجهما من الخدمة أولًا.",
    few: "في المتجر {count} أجهزة ما زالت في الخدمة. أخرِجها من الخدمة أولًا.",
    many: "في المتجر {count} جهازًا ما زالت في الخدمة. أخرِجها من الخدمة أولًا.",
    other: "في المتجر {count} جهاز ما زالت في الخدمة. أخرِجها من الخدمة أولًا.",
  },
  "storeDeletion.blocker.store_device_queue_unsynced": {
    zero: "على أجهزة المتجر مبيعات لم تُرسل بعد، أو لا يُعرف عددها. افتح الجهاز لمراجعته.",
    one: "على جهاز واحد مبيعات لم تُرسل بعد، أو لا يُعرف عددها. افتح الجهاز لمراجعته.",
    two: "على جهازين مبيعات لم تُرسل بعد، أو لا يُعرف عددها. افتح الجهازين لمراجعتهما.",
    few: "على {count} أجهزة مبيعات لم تُرسل بعد، أو لا يُعرف عددها. افتحها لمراجعتها.",
    many: "على {count} جهازًا مبيعات لم تُرسل بعد، أو لا يُعرف عددها. افتحها لمراجعتها.",
    other: "على {count} جهاز مبيعات لم تُرسل بعد، أو لا يُعرف عددها. افتحها لمراجعتها.",
  },
  "storeDeletion.blocker.store_has_open_count_session": {
    zero: "في المتجر جلسات جرد مفتوحة. أنهِها أولًا.",
    one: "في المتجر جلسة جرد مفتوحة واحدة. أنهِها أولًا.",
    two: "في المتجر جلستا جرد مفتوحتان. أنهِهما أولًا.",
    few: "في المتجر {count} جلسات جرد مفتوحة. أنهِها أولًا.",
    many: "في المتجر {count} جلسة جرد مفتوحة. أنهِها أولًا.",
    other: "في المتجر {count} جلسة جرد مفتوحة. أنهِها أولًا.",
  },
  "storeDeletion.blocker.unknown": "لا يمكن حذف هذا المتجر الآن.",
  "storeDeletion.link.device": "افتح الجهاز {label}",
  "storeDeletion.link.countSession": "افتح جلسة الجرد {index}",

  // --- The confirm step ------------------------------------------------------
  "storeDeletion.reason.label": "سبب الحذف (إلزامي)",
  "storeDeletion.reason.help": "حتى 200 حرف. لا تكتب بيانات شخصية.",
  "storeDeletion.reason.required": "اكتب سبب الحذف.",
  "storeDeletion.reason.tooLong": "السبب أطول من 200 حرف.",
  "storeDeletion.password.label": "كلمة المرور الحالية",
  "storeDeletion.password.help": "لتأكيد أنك صاحب الحساب. لا تُحفظ كلمة المرور.",
  "storeDeletion.needInputs": "اكتب السبب وكلمة المرور لتفعيل التأكيد.",
  "storeDeletion.cancel": "إلغاء",
  // A2, verbatim.
  "storeDeletion.commit": "تأكيد حذف المتجر",
  "storeDeletion.committing": "جارٍ حذف المتجر…",
  "storeDeletion.backToList": "العودة إلى المتاجر",

  // --- Answers ---------------------------------------------------------------
  "storeDeletion.success": "حُذف المتجر.",
  "storeDeletion.successReplay": "هذا المتجر محذوف بالفعل. لم يتغير شيء.",
  "storeDeletion.stale": "تغيّرت حالة المتجر منذ الفحص. راجع الفحص الجديد ثم أكّد من جديد.",
  "storeDeletion.reauthRequired": "انتهت صلاحية تأكيد كلمة المرور. أعد كتابتها ثم أكّد.",
  "storeDeletion.retryable": "لم نتأكد من تسجيل الحذف. أعد المحاولة بالطلب نفسه؛ لن يُنفَّذ حذف ثانٍ.",
  "storeDeletion.session": "انتهت جلسة الدخول. سجّل الدخول مرة أخرى للمتابعة.",
  "storeDeletion.reauth.failed": "تعذّر التحقق من هويتك. راجع كلمة المرور وحاول مرة أخرى.",
  "storeDeletion.reauth.rateLimited": "محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.",
  "storeDeletion.reauth.unavailable": "تعذّر التحقق من كلمة المرور الآن. لم يُحذف شيء. حاول لاحقًا.",
  "storeDeletion.error.generic": "تعذّر حذف المتجر. لم يُحذف شيء.",
  "storeDeletion.error.readOnlySession": "جلسة الدعم للقراءة فقط: لا يمكن الحذف منها.",
  "storeDeletion.error.ownerOnly": "حذف المتجر متاح لصاحب الحساب فقط.",
  "storeDeletion.error.forbidden": "لا تملك صلاحية حذف هذا المتجر.",
  "storeDeletion.error.notAvailable": "هذا الإجراء غير متاح لصلاحياتك، أو أن المتجر غير موجود.",
  "storeDeletion.error.capReached":
    "بلغت المؤسسة الحد الأقصى لهذه الإجراءات في الساعة. حاول لاحقًا.",
  "storeDeletion.error.rateLimited": "طلبات كثيرة. انتظر قليلًا ثم أعد المحاولة.",
  "storeDeletion.error.validation": "القيم المدخلة غير مقبولة. راجع السبب وأعد المحاولة.",
} as const satisfies Messages;
