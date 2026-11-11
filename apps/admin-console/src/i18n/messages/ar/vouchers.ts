import type { Messages } from "../types";

/**
 * Arabic copy for the vouchers page (RT-1109, RT-1098 slice I-4).
 *
 * Glossary: Voucher → «قسيمة» (pl. «قسائم»); voucher code → «رمز القسيمة»;
 * batch → «الدفعة»; issue → «إصدار»; Store → «المتجر» (never «الفرع»).
 * Statuses: active «سارية», redeemed «مستخدمة», cancelled «ملغاة»,
 * expired «منتهية». Verb jurisdiction (UX-12.7): «إصدار» creates, «إلغاء»
 * cancels a voucher, «تنزيل» saves the codes file.
 */
export const vouchers = {
  "vouchers.nav.label": "القسائم",

  // --- List -----------------------------------------------------------------
  "vouchers.list.title": "القسائم",
  "vouchers.list.subtitle": "قسائم ترويجية تُمنح مجانًا في متاجر {tenant}.",
  "vouchers.list.scopePrompt": "اختر مؤسسة لإدارة قسائمها.",
  "vouchers.list.issue": "إصدار قسائم",
  "vouchers.list.caption": "القسائم، الأحدث أولًا",
  "vouchers.list.loadingNoun": "القسائم",
  "vouchers.list.empty": "لا توجد قسائم في هذه المؤسسة بعد.",
  "vouchers.list.emptyFiltered": "لا توجد قسائم تطابق هذه الفلاتر.",
  "vouchers.list.emptyPage": "لا توجد قسائم في هذه الصفحة. حمّل المزيد لمتابعة البحث.",
  "vouchers.list.loadMore": "تحميل المزيد",
  "vouchers.list.loadFailed": "تعذّر تحميل القسائم.",
  "vouchers.list.col.value": "القيمة",
  "vouchers.list.col.status": "الحالة",
  "vouchers.list.col.validIn": "صالحة في",
  "vouchers.list.col.expires": "تنتهي في",
  "vouchers.list.col.issued": "أُصدرت في",
  "vouchers.list.col.actions": "الإجراءات",
  "vouchers.list.open": "فتح",
  "vouchers.list.openLabel": "فتح القسيمة بقيمة {amount} الصادرة في {issued}",
  "vouchers.list.noExpiry": "لا تنتهي",

  "vouchers.filters.label": "فلاتر القسائم",
  "vouchers.filters.status": "الحالة",
  "vouchers.filters.statusAny": "كل الحالات",
  "vouchers.filters.store": "صالحة في المتجر",
  "vouchers.filters.storeAny": "كل المتاجر",

  "vouchers.eligibility.all": "كل المتاجر",
  "vouchers.eligibility.unnamed": {
    zero: "لا متاجر أخرى",
    one: "متجر آخر",
    two: "متجران آخران",
    few: "{count} متاجر أخرى",
    many: "{count} متجرًا آخر",
    other: "{count} متجر آخر",
  },

  "vouchers.status.active": "سارية",
  "vouchers.status.redeemed": "مستخدمة",
  "vouchers.status.cancelled": "ملغاة",
  "vouchers.status.expired": "منتهية",
  "vouchers.status.unknown": "حالة غير معروفة",

  // --- Shared errors -------------------------------------------------------
  "vouchers.errors.session": "انتهت جلسة الدخول. سجّل الدخول مرة أخرى للمتابعة.",
  "vouchers.errors.forbidden": "لا تملك صلاحية إدارة القسائم في هذه المؤسسة.",
  "vouchers.errors.rateLimited": "طلبات كثيرة في وقت قصير. انتظر قليلًا ثم أعد المحاولة.",

  // --- Issue ----------------------------------------------------------------
  "vouchers.issue.title": "إصدار قسائم",
  "vouchers.issue.scopeLine": "إصدار قسائم في المؤسسة {tenant}.",
  "vouchers.issue.onceNote":
    "تظهر رموز القسائم مرة واحدة فقط بعد الإصدار، ولا يمكن عرضها مرة أخرى. جهّز مكانًا آمنًا لحفظها.",
  "vouchers.issue.count": "عدد القسائم",
  "vouchers.issue.countHint": "من 1 إلى {max} قسيمة في الدفعة الواحدة.",
  "vouchers.issue.amount": "قيمة القسيمة الواحدة (EGP)",
  "vouchers.issue.amountHint": "تُستخدم القسيمة مرة واحدة، ويضيع ما يتبقى من قيمتها.",
  "vouchers.issue.expiresAt": "تنتهي في (اختياري)",
  "vouchers.issue.expiresHint": "بتوقيت جهازك. اتركه فارغًا لقسيمة لا تنتهي.",
  "vouchers.issue.scope": "أين تصلح القسائم",
  "vouchers.issue.scopeAll": "كل المتاجر، ومنها المتاجر التي تُضاف لاحقًا",
  "vouchers.issue.scopeStores": "متاجر محددة فقط",
  "vouchers.issue.stores": "المتاجر",
  "vouchers.issue.noStores": "لا توجد متاجر متاحة لك لاختيارها.",
  "vouchers.issue.note": "ملاحظة داخلية (اختياري)",
  "vouchers.issue.noteHint": "لا تكتب بيانات شخصية في الملاحظة.",
  "vouchers.issue.submit": "إصدار القسائم",
  "vouchers.issue.errors.validation": "راجع بيانات القسائم ثم حاول مرة أخرى. لم تُصدر أي قسيمة.",
  "vouchers.issue.errors.generic": "تعذّر إصدار القسائم. لم تُصدر أي قسيمة. حاول مرة أخرى.",
  "vouchers.issue.errors.forbidden":
    "لا تملك صلاحية إصدار هذه القسائم. الإصدار لكل المتاجر يتطلب صلاحية على كل متاجر المؤسسة. لم تُصدر أي قسيمة.",
  "vouchers.issue.errors.storeUnavailable":
    "أحد المتاجر المختارة غير متاح. اختر متاجر أخرى. لم تُصدر أي قسيمة.",
  "vouchers.issue.errors.storeInactive":
    "أحد المتاجر المختارة غير نشط. اختر متاجر نشطة. لم تُصدر أي قسيمة.",
  "vouchers.issue.uncertain":
    "نتيجة الإصدار غير مؤكدة: ربما صدرت القسائم دون أن تصل رموزها. لا تكرر الإصدار الآن. افتح قائمة القسائم، وألغِ أحدث القسائم التي لا تملك رموزها، ثم أصدر من جديد.",
  "vouchers.issue.uncertainAction": "فتح قائمة القسائم",

  // --- Issued codes (shown once) ----------------------------------------------
  "vouchers.codes.title": "رموز القسائم الصادرة",
  "vouchers.codes.issued": {
    zero: "لم تصدر أي قسيمة.",
    one: "صدرت قسيمة واحدة.",
    two: "صدرت قسيمتان.",
    few: "صدرت {count} قسائم.",
    many: "صدرت {count} قسيمة.",
    other: "صدرت {count} قسيمة.",
  },
  "vouchers.codes.warning":
    "هذه الرموز تظهر الآن فقط. نزّل الملف أو انسخ الرموز قبل الإغلاق، فلا يمكن عرضها مرة أخرى. إذا فُقد رمز، ألغِ قسيمته وأصدر غيرها.",
  "vouchers.codes.caption": "رموز القسائم الصادرة في هذه الدفعة",
  "vouchers.codes.col.code": "الرمز",
  "vouchers.codes.col.value": "القيمة",
  "vouchers.codes.col.expires": "تنتهي في",
  "vouchers.codes.download": "تنزيل ملف الرموز",
  "vouchers.codes.copy": "نسخ كل الرموز",
  "vouchers.codes.copied": "نُسخت الرموز.",
  "vouchers.codes.copyFailed": "تعذّر النسخ. نزّل ملف الرموز بدلًا من ذلك.",
  "vouchers.codes.done": "حفظت الرموز، إغلاق",

  // --- Detail and cancel -------------------------------------------------------
  "vouchers.detail.title": "تفاصيل القسيمة",
  "vouchers.detail.loading": "تفاصيل القسيمة",
  "vouchers.detail.notFound": "هذه القسيمة غير موجودة أو ليست ضمن صلاحيتك.",
  "vouchers.detail.loadFailed": "تعذّر تحميل القسيمة.",
  "vouchers.detail.value": "القيمة",
  "vouchers.detail.status": "الحالة",
  "vouchers.detail.validIn": "صالحة في",
  "vouchers.detail.expires": "تنتهي في",
  "vouchers.detail.issued": "أُصدرت في",
  "vouchers.detail.cancelledAt": "أُلغيت في",
  "vouchers.detail.batch": "رقم الدفعة",
  "vouchers.detail.voucherId": "رقم القسيمة",
  "vouchers.detail.note": "الملاحظة",
  "vouchers.detail.noNote": "لا توجد ملاحظة",
  "vouchers.detail.redeemedAt": "استُخدمت في",
  "vouchers.detail.applied": "المبلغ المستخدم",
  "vouchers.detail.forfeited": "المبلغ الضائع",
  "vouchers.detail.codeNote": "لا يُعرض رمز القسيمة بعد إصدارها.",
  "vouchers.detail.cancel": "إلغاء القسيمة",
  "vouchers.detail.cancelPrompt":
    "إلغاء هذه القسيمة نهائي: لن تُقبل في أي متجر بعد الآن. لا تُرد أي أموال.",
  "vouchers.detail.cancelConfirm": "تأكيد إلغاء القسيمة",
  "vouchers.detail.cancelKeep": "إبقاء القسيمة",
  "vouchers.detail.cancelled": "أُلغيت القسيمة.",
  "vouchers.detail.alreadyCancelled": "كانت القسيمة ملغاة من قبل.",
  "vouchers.detail.cancelForbidden": "لا تملك صلاحية إلغاء هذه القسيمة.",
  "vouchers.detail.cancelRedeemed": "استُخدمت هذه القسيمة، فلا يمكن إلغاؤها.",
  "vouchers.detail.cancelInProgress":
    "طلب الإلغاء ما زال قيد التنفيذ. انتظر قليلًا ثم أكّد الإلغاء مرة أخرى.",
  "vouchers.detail.cancelFailed": "تعذّر إلغاء القسيمة. حاول مرة أخرى.",

  // --- Form validation -----------------------------------------------------------
  "vouchers.form.countInvalid": "أدخل عددًا صحيحًا من 1 إلى {max}.",
  "vouchers.form.amountRequired": "أدخل قيمة القسيمة.",
  "vouchers.form.amountInvalid": "أدخل قيمة أكبر من صفر.",
  "vouchers.form.amountPrecision": "القيمة تقبل {digits} منازل عشرية على الأكثر.",
  "vouchers.form.expiryInvalid": "أدخل تاريخًا ووقتًا صحيحين.",
  "vouchers.form.expiryPast": "اختر تاريخ انتهاء في المستقبل.",
  "vouchers.form.storesRequired": "اختر متجرًا واحدًا على الأقل.",
  "vouchers.form.storesTooMany": "اختر {max} متجر على الأكثر.",
  "vouchers.form.noteTooLong": "الملاحظة {max} حرف على الأكثر.",
} satisfies Messages;
