/**
 * Arabic copy for the tenant's tracked-selling switch (RT-455 part 1; RT-451
 * OD-T1..OD-T7) and for the tracking pages while it is off.
 *
 * Glossary (as `tracking.ts`): batch → «دفعة»; tracked → «متتبَّع». The
 * switch is «البيع بالدفعة»: on → «مُشغَّل», off → «متوقف». Verbs (UX-12.7):
 * تشغيل / إيقاف name the action; تأكيد crosses the consequence boundary.
 * Preconditions are named as the condition, under a heading that says they
 * are not met; one the server cannot confirm is listed as unmet (fail closed).
 */
export const trackedSelling = {
  "trackedSelling.title": "البيع بالدفعة",
  "trackedSelling.sub.manage":
    "يحدد إن كانت نقاط البيع في كل متاجر المؤسسة تطلب الدفعة للأصناف المتتبَّعة. الإيقاف متاح دائمًا، والتشغيل يتطلب استيفاء الشروط.",
  "trackedSelling.sub.status": "للعرض فقط. يغيّره مالك المؤسسة أو مديرها.",
  "trackedSelling.loadingNoun": "إعداد البيع بالدفعة",
  "trackedSelling.loadFailed": "تعذّر تحميل إعداد البيع بالدفعة.",
  "trackedSelling.sessionExpired": "انتهت جلستك. سجّل الدخول مرة أخرى.",
  "trackedSelling.retry": "إعادة المحاولة",

  // --- Fields ------------------------------------------------------------------------
  "trackedSelling.field.state": "الحالة",
  "trackedSelling.field.changed": "آخر تغيير",
  "trackedSelling.state.on": "مُشغَّل",
  "trackedSelling.state.off": "متوقف",
  "trackedSelling.changed.never": "لم يُغيَّر منذ إنشاء المؤسسة.",
  "trackedSelling.changed.at": "{at}، بواسطة",

  // --- Preconditions -------------------------------------------------------------------
  "trackedSelling.preconditions.title": "شروط التشغيل",
  "trackedSelling.preconditions.unmet": "شروط غير مستوفاة الآن:",
  "trackedSelling.preconditions.allMet": "كل شروط التشغيل مستوفاة الآن.",
  "trackedSelling.preconditions.failClosed":
    "الشرط الذي لا يستطيع الخادم التأكد منه يُعدّ غير مستوفى.",
  "trackedSelling.precondition.sale_effects_active":
    "أثر البيع والإلغاء والإرجاع على المخزون مفعّل للمؤسسة.",
  "trackedSelling.precondition.status_moves_available":
    "نقل المخزون بين الحالات وفحص المرتجعات متاحان.",
  "trackedSelling.precondition.erp_tracking_import":
    "استيراد المخزون من ERPNext مع الدفعات يعمل، فتُسجَّل الدفعات الجديدة.",
  "trackedSelling.precondition.erp_batch_posting_verified":
    "ترحيل أسطر الدفعات إلى ERPNext مع رقم الدفعة مُتحقَّق منه.",
  "trackedSelling.precondition.identity_anchor": "رصيد البداية لكل دفعة مثبَّت.",
  "trackedSelling.precondition.tracking_grain_reconciliation":
    "مطابقة المخزون على مستوى الدفعة متاحة.",
  "trackedSelling.precondition.unknown": "شرط غير معروف:",

  // --- OD-T7 warning ---------------------------------------------------------------------
  "trackedSelling.warning.title": "البيع بالدفعة مُشغَّل، لكن شرطًا أو أكثر لم يعد مستوفى.",
  "trackedSelling.warning.body":
    "يبقى مُشغَّلًا ولا يتوقف من تلقاء نفسه. راجع الشروط أدناه، أو أوقفه إن لزم.",

  // --- Actions -------------------------------------------------------------------------------
  "trackedSelling.turnOn": "تشغيل البيع بالدفعة",
  "trackedSelling.turnOff": "إيقاف البيع بالدفعة",
  "trackedSelling.confirm.label": "تأكيد إيقاف البيع بالدفعة",
  "trackedSelling.confirm.body":
    "إيقاف البيع بالدفعة في كل متاجر المؤسسة؟ لن تطلب نقاط البيع الدفعة، ويُخفى قسم الحجز والاستدعاء. لا يُحذف شيء: الحجوزات والاستدعاءات والتتبع المسجّل تبقى. إعادة التشغيل تتطلب استيفاء الشروط من جديد.",
  "trackedSelling.confirm.yes": "تأكيد الإيقاف",
  "trackedSelling.confirm.cancel": "إلغاء",

  // --- Outcomes --------------------------------------------------------------------------
  "trackedSelling.saved.on": "شُغِّل البيع بالدفعة.",
  "trackedSelling.saved.off": "أُوقف البيع بالدفعة.",
  "trackedSelling.unmet":
    "لم يُشغَّل البيع بالدفعة: شرط واحد على الأقل غير مستوفى الآن. لم يُسجَّل شيء، وقائمة الشروط أدناه مقروءة من الخادم من جديد.",
  "trackedSelling.unavailable": "إعداد البيع بالدفعة غير متاح الآن. لم يُسجَّل شيء.",
  "trackedSelling.forbidden": "تغيير هذا الإعداد غير متاح لدورك. لم يُسجَّل شيء.",
  "trackedSelling.rateLimited": "طلبات كثيرة في وقت قصير. انتظر قليلًا ثم أعد المحاولة.",
  "trackedSelling.rateLimitedFor": {
    zero: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد {count} ثانية.",
    one: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد ثانية واحدة.",
    two: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد ثانيتين.",
    few: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد {count} ثوانٍ.",
    many: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد {count} ثانية.",
    other: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد {count} ثانية.",
  },
  "trackedSelling.rejected": "رفض الخادم الأمر (الحالة {status}). لم يُسجَّل شيء.",
  "trackedSelling.code": "الرمز: {code}",
  "trackedSelling.failed":
    "لم يصل أي رد، فلا يُعرف إن كان الإعداد قد تغيّر. الحالة أدناه مقروءة من الخادم من جديد، وتكرار الأمر آمن.",

  // --- Tracking pages while off (OD-T4) ------------------------------------------------------
  "trackedSelling.pagesOff.title": "قسم الحجز والاستدعاء غير متاح لهذه المؤسسة الآن.",
  "trackedSelling.pagesOff.body": "يظهر حين يكون البيع بالدفعة مُشغَّلًا للمؤسسة.",
  "trackedSelling.pagesFailed":
    "تعذّر التأكد من أن البيع بالدفعة مُشغَّل، فلا يُعرض قسم الحجز والاستدعاء.",
};
