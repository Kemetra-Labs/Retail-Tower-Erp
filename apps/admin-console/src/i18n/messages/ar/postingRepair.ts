import type { Messages } from "../types";

/**
 * Arabic copy for the sale detail's ERPNext posting-failure banner and its
 * repair (RT-1072, RT-977 §7). Order: What → Safety → Action → Evidence. Every
 * line traces to a contract field: the cause to `rejectionCategory`, the time
 * to `deadLetteredAt`, the message to `reason` (full disclosure only), the
 * action to `disclosure` and `repair`, the outcome to `RecordedRepair.outcome`.
 * No line claims a stock or ledger effect: no field states one.
 *
 * Glossary: posting → «الترحيل»; repair → «إصلاح»; send again → «إعادة الإرسال».
 */
export const postingRepair = {
  // --- Cause, by rejectionCategory (an open set: unknown or null → `other`) -----
  "postingRepair.cause.unmappedItem": "أحد أصناف هذه العملية ليس له ربط مؤكَّد بصنف في ERPNext.",
  "postingRepair.cause.unmappedStore": "هذا المتجر ليس له ربط فعّال بمستودع في ERPNext.",
  "postingRepair.cause.unmappedAccount": "أبلغ ERPNext عن ربط حساب غير موجود.",
  "postingRepair.cause.validation": "رفض ERPNext المستند لأنه غير صالح.",
  "postingRepair.cause.closedPeriod": "رفض ERPNext المستند لأن فترته المحاسبية مُقفلة.",
  "postingRepair.cause.retryBudgetExhausted": "توقّف الترحيل بعد إخفاقات مؤقتة متكررة.",
  "postingRepair.cause.reconciliationRequired":
    "يوجد في ERPNext مستند لهذه العملية لا يطابقها. أصلِحه في ERPNext؛ لن يُرحّلها Retail Tower مرة أخرى.",
  "postingRepair.cause.reconciliationRequiredWithDocument":
    "يوجد في ERPNext مستند لهذه العملية ({doctype} {name}) لا يطابقها. أصلِحه في ERPNext؛ لن يُرحّلها Retail Tower مرة أخرى.",
  "postingRepair.cause.other": "رفض ERPNext المستند.",

  // --- Safety ---------------------------------------------------------------------
  "postingRepair.safety": "تبقى العملية مسجّلة في Retail Tower، والإصلاح لا يغيّرها.",

  // --- Action ---------------------------------------------------------------------
  "postingRepair.action.categoryOnly": "يمكن للمالك أو لمسؤول المؤسسة إصلاح هذا الترحيل.",
  "postingRepair.action.send": "أعِد الإرسال إلى ERPNext",
  "postingRepair.action.mappingHint": "أصلِح الربط أولًا ثم أعِد الإرسال.",
  "postingRepair.changed": "تغيّرت حالة هذا الترحيل. حدّث الصفحة لرؤيتها.",

  // --- Evidence -------------------------------------------------------------------
  "postingRepair.evidence.stoppedAt": "توقّف في {time}.",
  "postingRepair.evidence.reason": "رسالة ERPNext: {reason}",

  // --- Confirmation ---------------------------------------------------------------
  "postingRepair.confirm.label": "تأكيد إعادة الإرسال إلى ERPNext",
  "postingRepair.confirm.sale":
    "إعادة إرسال هذه العملية إلى ERPNext؟ يتحقق Retail Tower من السبب مرة أخرى. إن كان قد أُصلح، تصل العملية إلى ERPNext مرة واحدة ولا تُرحَّل مرتين أبدًا.",
  "postingRepair.confirm.reversal":
    "إعادة إرسال عكس إلغاء هذه العملية إلى ERPNext؟ يتحقق Retail Tower من السبب مرة أخرى. إن كان قد أُصلح، يصل العكس إلى ERPNext مرة واحدة ولا يُرحَّل مرتين أبدًا.",
  "postingRepair.confirm.submit": "أعِد الإرسال",
  "postingRepair.sending": "جارٍ الإرسال…",

  // --- Outcome (keyed on RecordedRepair.outcome, never on 200 vs 201) -------------
  "postingRepair.outcome.eligibleAgain": "أُعيد الإرسال. الترحيل إلى ERPNext قيد الانتظار.",
  "postingRepair.outcome.stillFailing": "لم يُرسَل شيء. السبب ما زال قائمًا؛ أصلِحه ثم حاول مرة أخرى.",
  "postingRepair.outcome.alreadyPosted":
    "رُحِّلت بالفعل إلى ERPNext برقم {ref}. لم يُرسَل شيء مرة أخرى.",
  "postingRepair.outcome.alreadySent": "أُعيد إرسالها بالفعل وهي بانتظار ERPNext. لم يتغير شيء.",
  "postingRepair.outcome.notFound": "لم يعد إصلاح هذا الترحيل متاحًا هنا. حدّث صفحة العملية.",
  "postingRepair.outcome.keyConflict":
    "رفض الخادم الطلب لأنه لا يطابق طلبًا سابقًا بالمفتاح نفسه. لم يتغير شيء؛ يمكنك إعادة المحاولة.",
  "postingRepair.outcome.originRejected": "رُفض الطلب. أعِد تحميل الصفحة ثم حاول مرة أخرى.",
  "postingRepair.outcome.forbidden": "لا يسمح دورك بإصلاح هذا الترحيل. لم يتغير شيء.",
  "postingRepair.outcome.session": "انتهت جلستك. سجّل الدخول مرة أخرى.",
  "postingRepair.outcome.rejected": "رفض الخادم الطلب. لم يتغير شيء.",
  "postingRepair.outcome.rateLimited":
    "طلبات كثيرة في وقت قصير. لم يُرسَل شيء؛ انتظر ثم حاول مرة أخرى.",
  "postingRepair.outcome.unconfirmed": "تعذّر التأكد من النتيجة. حاول مرة أخرى.",
  "postingRepair.retry": "حاول مرة أخرى",
} satisfies Messages;
