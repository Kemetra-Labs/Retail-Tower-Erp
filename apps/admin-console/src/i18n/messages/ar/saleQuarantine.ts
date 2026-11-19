import type { Messages } from "../types";

/**
 * Arabic copy for the sale quarantine queue (RT-1312 Phase 3(b) slice B): sales a device (the
 * till) could not get the server to accept, the item page and the write-off.
 *
 * Glossary: the queue is «مبيعات تعذّر إرسالها من الجهاز» (as in the device screens, «المبيعات التي
 * لم تُرسل من الجهاز»). It is NOT the ERP sync queue of `saleSync` («مبيعات تحتاج إلى إصلاح», whose
 * items are «عنصر مزامنة معزول»): a sale here has no record in the system at all. So this copy
 * never says «معزول» or «عُزل», and it never says a sale is «مُرحَّل» or «مفقود»: a written-off
 * sale created no sale, no posting and no stock effect, and is handled outside Retail Tower.
 * Write-off → «إغلاق دون تسجيل» (the item closes, the sale is not recorded).
 */
export const saleQuarantine = {
  // --- Navigation (under the Integration section, owner / tenant_admin) ----------
  "saleQuarantine.nav.label": "مبيعات تعذّر إرسالها من الجهاز",

  // --- List ------------------------------------------------------------------------
  "saleQuarantine.list.title": "مبيعات تعذّر إرسالها من الجهاز",
  "saleQuarantine.list.bandSub": "مبيعات لم يسجّلها الخادم بعد · {tenant}",
  "saleQuarantine.list.sub":
    "مبيعات أرسلها جهاز البيع في {tenant} بعد أن رفض الخادم تسجيلها نهائيًا أو احتفظ بها الجهاز عقب إعادة الربط، الأحدث أولًا. هذه المبيعات غير مسجّلة في النظام حتى يُتخذ فيها إجراء.",
  "saleQuarantine.list.note":
    "هذه القائمة مستقلة عن قائمة «مبيعات تحتاج إلى إصلاح»، وهي لمبيعات سُجّلت فعلًا وتعثّرت مزامنتها. ظهور البيع هنا لا يعني أنه رُحِّل إلى ERPNext، وغيابه لا يعني أنه رُحِّل.",
  "saleQuarantine.list.otherQueue": "مبيعات تحتاج إلى إصلاح (مزامنة ERPNext)",
  "saleQuarantine.list.scopePrompt": "اختر مؤسسة لعرض المبيعات التي تعذّر إرسالها من الجهاز.",
  "saleQuarantine.list.refresh": "تحديث",
  "saleQuarantine.list.loadMore": "تحميل المزيد",
  "saleQuarantine.list.asOf": "آخر قراءة: {time}",
  "saleQuarantine.list.caption": "مبيعات تعذّر إرسالها من الجهاز، الأحدث أولًا",
  "saleQuarantine.list.loadingNoun": "المبيعات التي تعذّر إرسالها",
  "saleQuarantine.list.loadFailed": "تعذّر تحميل المبيعات التي تعذّر إرسالها من الجهاز.",
  "saleQuarantine.list.empty": "لا توجد مبيعات مفتوحة تعذّر إرسالها من الجهاز.",
  "saleQuarantine.list.emptyState": "لا توجد عناصر بهذه الحالة.",
  "saleQuarantine.list.emptyStore": "لا توجد عناصر في هذا المتجر بالحالة المختارة.",
  "saleQuarantine.list.emptyHint":
    "القائمة الفارغة لا تعني أن كل مبيعات الأجهزة سُجّلت؛ تُظهر أعداد المبيعات غير المرسلة في شاشة الأجهزة.",
  "saleQuarantine.list.storeNotFound": "هذا المتجر غير متاح لك.",
  "saleQuarantine.list.stateNotFound": "هذه الحالة غير معروفة.",
  "saleQuarantine.list.unknownStore": "متجر غير معروف",
  "saleQuarantine.list.openItem": "فتح العنصر {ref}",
  "saleQuarantine.filter.label": "تصفية المبيعات التي تعذّر إرسالها",
  "saleQuarantine.filter.store": "المتجر",
  "saleQuarantine.filter.allStores": "كل المتاجر",
  "saleQuarantine.filter.state": "الحالة",
  "saleQuarantine.col.externalId": "المرجع في المصدر",
  "saleQuarantine.col.store": "المتجر",
  "saleQuarantine.col.reason": "سبب التعثّر",
  "saleQuarantine.col.total": "الإجمالي على الجهاز",
  "saleQuarantine.col.state": "الحالة",
  "saleQuarantine.col.receivedAt": "وصل إلى الخادم",

  // --- State and the till's reason ----------------------------------------------------
  "saleQuarantine.state.open": "مفتوح",
  "saleQuarantine.state.captured": "سُجّل بعد إصلاح",
  "saleQuarantine.state.alreadyCaptured": "سُجّل من قبل",
  "saleQuarantine.state.writtenOff": "أُغلق دون تسجيل",
  "saleQuarantine.state.unknown": "حالة غير معروفة",
  "saleQuarantine.meaning.open":
    "البيع غير مسجّل في النظام وينتظر إجراءً. يمكن إغلاقه دون تسجيل إن عولج خارج Retail Tower.",
  "saleQuarantine.meaning.captured": "سجّل الخادم هذا البيع بإصلاح. خرج العنصر من القائمة المفتوحة.",
  "saleQuarantine.meaning.alreadyCaptured":
    "وجد الخادم أن البيع مسجّل من قبل بالبيانات نفسها. خرج العنصر من القائمة المفتوحة.",
  "saleQuarantine.meaning.writtenOff":
    "أُغلق العنصر دون تسجيل البيع. لم يُنشأ بيع ولا ترحيل ولا أثر على المخزون، والبيع يُعالج خارج Retail Tower.",
  "saleQuarantine.meaning.unknown":
    "أرسل الخادم حالة لا يعرفها هذا الإصدار. لا تُعامل كحالة مفتوحة ولا كحالة مغلقة.",
  "saleQuarantine.reason.refused": "رفض الخادم البيع نهائيًا",
  "saleQuarantine.reason.payloadDivergence": "بيانات مختلفة لمرجع البيع نفسه",
  "saleQuarantine.reason.cashierClaimRefused": "رُفض ادّعاء الكاشير",
  "saleQuarantine.reason.heldPreviousPairing": "محجوز من ربط سابق",
  "saleQuarantine.reason.unknown": "سبب غير معروف",

  // --- Item page ------------------------------------------------------------------------
  "saleQuarantine.detail.back": "العودة إلى المبيعات التي تعذّر إرسالها",
  "saleQuarantine.detail.title": "بيع تعذّر إرساله {ref}",
  "saleQuarantine.detail.scopePrompt": "اختر مؤسسة لعرض هذا العنصر.",
  "saleQuarantine.detail.loadingNoun": "العنصر",
  "saleQuarantine.detail.loadFailed": "تعذّر تحميل هذا العنصر.",
  "saleQuarantine.detail.notFound": "هذا العنصر غير موجود أو غير متاح لك.",
  "saleQuarantine.detail.uploadConflict": {
    zero: "رفع الجهاز بيعًا بالمرجع نفسه ببيانات مختلفة {count} مرة. الجهاز يحتفظ ببيع مختلف لهذا المرجع، ولا يُحفظ منه شيء هنا. تحقق منه على الجهاز قبل أي إجراء.",
    one: "رفع الجهاز مرة أخرى بيعًا بالمرجع نفسه ببيانات مختلفة. الجهاز يحتفظ ببيع مختلف لهذا المرجع، ولا يُحفظ منه شيء هنا. تحقق منه على الجهاز قبل أي إجراء.",
    two: "رفع الجهاز مرتين بيعًا بالمرجع نفسه ببيانات مختلفة. الجهاز يحتفظ ببيع مختلف لهذا المرجع، ولا يُحفظ منه شيء هنا. تحقق منه على الجهاز قبل أي إجراء.",
    few: "رفع الجهاز {count} مرات بيعًا بالمرجع نفسه ببيانات مختلفة. الجهاز يحتفظ ببيع مختلف لهذا المرجع، ولا يُحفظ منه شيء هنا. تحقق منه على الجهاز قبل أي إجراء.",
    many: "رفع الجهاز {count} مرة بيعًا بالمرجع نفسه ببيانات مختلفة. الجهاز يحتفظ ببيع مختلف لهذا المرجع، ولا يُحفظ منه شيء هنا. تحقق منه على الجهاز قبل أي إجراء.",
    other:
      "رفع الجهاز {count} مرة بيعًا بالمرجع نفسه ببيانات مختلفة. الجهاز يحتفظ ببيع مختلف لهذا المرجع، ولا يُحفظ منه شيء هنا. تحقق منه على الجهاز قبل أي إجراء.",
  },
  "saleQuarantine.section.item": "العنصر",
  "saleQuarantine.section.till": "ما سجّله الجهاز",
  "saleQuarantine.section.sale": "البيع كما سجّله الجهاز",
  "saleQuarantine.section.handling": "المعالجة",
  "saleQuarantine.field.state": "الحالة",
  "saleQuarantine.field.store": "المتجر",
  "saleQuarantine.field.device": "الجهاز الذي رفعه",
  "saleQuarantine.field.source": "نظام المصدر",
  "saleQuarantine.field.externalId": "المرجع في المصدر",
  "saleQuarantine.field.receivedAt": "وصل إلى الخادم",
  "saleQuarantine.field.reason": "سبب التعثّر (كما ادّعى الجهاز)",
  "saleQuarantine.field.tillStatus": "رمز الرفض عند الجهاز",
  "saleQuarantine.field.tillCode": "رمز الخطأ عند الجهاز",
  "saleQuarantine.field.tillRecordedAt": "وقت التسجيل على الجهاز (ساعة الجهاز)",
  "saleQuarantine.field.previousTerminal": "الجهاز في الربط السابق",
  "saleQuarantine.field.occurredAt": "وقت البيع",
  "saleQuarantine.field.total": "الإجمالي على الجهاز",
  "saleQuarantine.field.lineCount": "عدد البنود",
  "saleQuarantine.field.repairCount": "مرات الإصلاح",
  "saleQuarantine.field.lastRepair": "آخر محاولة إصلاح",
  "saleQuarantine.field.sale": "البيع المسجّل",
  "saleQuarantine.field.writtenOffAt": "وقت الإغلاق",
  "saleQuarantine.field.writeOffNote": "ملاحظة الإغلاق",
  "saleQuarantine.value.notRecorded": "غير مسجّل",
  "saleQuarantine.value.openSale": "فتح البيع",
  "saleQuarantine.lastRepair": "{at}: {outcome}",
  "saleQuarantine.lastRepair.captured": "سُجّل بيع جديد",
  "saleQuarantine.lastRepair.alreadyCaptured": "كان مسجّلًا من قبل",
  "saleQuarantine.lastRepair.refused": "رُفض مرة أخرى",
  "saleQuarantine.lastRepair.unknown": "نتيجة غير معروفة",
  "saleQuarantine.summary.hint":
    "ملخص مقروء من بيانات البيع المحفوظة. لا يُعرض نص البيع ولا بنوده. كل حقل يظهر «غير مسجّل» إن لم تحمله البيانات بصيغة صالحة.",
  "saleQuarantine.handling.repairLater":
    "إعادة تسجيل البيع من هنا غير متاحة بعد. إن عولج هذا البيع خارج Retail Tower يمكنك إغلاق العنصر دون تسجيل.",
  "saleQuarantine.handling.closed": "هذا العنصر لم يعد مفتوحًا، فلا إجراء متاح عليه.",
  "saleQuarantine.handling.unknownState":
    "حالة هذا العنصر غير معروفة لهذا الإصدار، فلا يُعرض عليه إجراء.",

  // --- Write-off (the one write) -----------------------------------------------------------
  "saleQuarantine.writeOff.title": "إغلاق العنصر دون تسجيل",
  "saleQuarantine.writeOff.explain":
    "يُغلق العنصر نهائيًا دون تسجيل البيع: لا يُنشأ بيع ولا ترحيل ولا أثر على المخزون، ولا يمكن التراجع. استخدمه لبيع عولج خارج Retail Tower. يُحفظ نص البيع مع سجل المراجعة.",
  "saleQuarantine.writeOff.action": "إغلاق دون تسجيل",
  "saleQuarantine.writeOff.dialogTitle": "إغلاق العنصر دون تسجيل البيع",
  "saleQuarantine.writeOff.consequence":
    "سيُغلق البيع {ref} نهائيًا دون تسجيله. لن يظهر في مبيعات المتجر ولن يُرحَّل إلى ERPNext، ولن يتغيّر المخزون. هذا الإجراء لا يُتراجع عنه.",
  "saleQuarantine.writeOff.note.label": "سبب الإغلاق",
  "saleQuarantine.writeOff.note.help":
    "مطلوب، حتى 500 حرف. مثال: «أُعيد المبلغ نقدًا خارج Retail Tower». لا تُدخل بيانات بطاقة.",
  "saleQuarantine.writeOff.note.required": "اكتب سبب الإغلاق.",
  "saleQuarantine.writeOff.note.tooLong": "سبب الإغلاق أطول من 500 حرف.",
  "saleQuarantine.writeOff.needNote": "أدخل سبب الإغلاق لتفعيل الإغلاق.",
  "saleQuarantine.writeOff.commit": "إغلاق دون تسجيل",
  "saleQuarantine.writeOff.committing": "جارٍ الإغلاق…",
  "saleQuarantine.writeOff.cancel": "إلغاء",
  "saleQuarantine.writeOff.done": "تم",
  "saleQuarantine.writeOff.success":
    "أُغلق العنصر دون تسجيل البيع. لم يُنشأ بيع ولا ترحيل ولا أثر على المخزون.",
  "saleQuarantine.writeOff.error.conflict":
    "العنصر لم يعد مفتوحًا، ولم يتغيّر شيء بهذا الطلب. حُدّثت حالة العنصر.",
  "saleQuarantine.writeOff.error.keyConflict":
    "رفض الخادم الطلب لأنه لا يطابق طلبًا سابقًا بالمفتاح نفسه. لم يتغيّر شيء، ويمكنك الإغلاق من جديد.",
  "saleQuarantine.writeOff.error.notFound": "هذا العنصر غير موجود أو غير متاح لك. لم يتغيّر شيء.",
  "saleQuarantine.writeOff.error.forbidden": "دورك لا يسمح بإغلاق العنصر. لم يتغيّر شيء.",
  "saleQuarantine.writeOff.error.originRejected":
    "رفض الخادم مصدر هذا الطلب، ولم يتغيّر شيء. أبلغ فريق الدعم برقم الطلب.",
  "saleQuarantine.writeOff.error.rejected": "رفض الخادم الطلب. لم يتغيّر شيء.",
  "saleQuarantine.writeOff.error.rateLimited": "طلبات كثيرة في وقت قصير. لم يُغلق العنصر.",
  "saleQuarantine.writeOff.error.rateLimitedFor": {
    zero: "طلبات كثيرة في وقت قصير. لم يُغلق العنصر؛ يمكنك الطلب بعد {count} ثانية.",
    one: "طلبات كثيرة في وقت قصير. لم يُغلق العنصر؛ يمكنك الطلب بعد ثانية واحدة.",
    two: "طلبات كثيرة في وقت قصير. لم يُغلق العنصر؛ يمكنك الطلب بعد ثانيتين.",
    few: "طلبات كثيرة في وقت قصير. لم يُغلق العنصر؛ يمكنك الطلب بعد {count} ثوانٍ.",
    many: "طلبات كثيرة في وقت قصير. لم يُغلق العنصر؛ يمكنك الطلب بعد {count} ثانية.",
    other: "طلبات كثيرة في وقت قصير. لم يُغلق العنصر؛ يمكنك الطلب بعد {count} ثانية.",
  },
  "saleQuarantine.writeOff.error.unconfirmed":
    "لم يؤكد الخادم نتيجة الطلب، وربما نفّذه. حدّث الصفحة وراجع حالة العنصر قبل الطلب مرة أخرى؛ الطلب التالي بالسبب نفسه يُرسل بالمفتاح نفسه فلا يُطبَّق الإغلاق مرتين.",
} satisfies Messages;
