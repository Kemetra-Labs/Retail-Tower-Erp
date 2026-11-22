import type {
  SaleVoidMismatchReason,
  SaleVoidRefusalReason,
  SaleVoidState,
} from '../../../shared/sale-void/types';
import type { ManagerApprovalRefusalReason } from '../../../shared/operator/manager-approval';
import { formatShiftTime } from '../shift/shift-format';

/**
 * RT-530 — sale void copy. Arabic, one message per outcome. Never an approver
 * identity, never a credential; the only person named is the operator who
 * requested a void (the one whose sign-in sends it).
 *
 * RT-1403 S2 — PROPOSED copy, pending the owner's copy review: every string about the cash of a
 * void (the revised `dialogBody`, `cashDue` … `exceptionApprovalUnavailable`, the `payout_*`
 * refusals and the mismatch flags). A request moves no cash; the cash is paid out only after
 * the server confirmed the void (RT-530 c12022, RT-1403 c18143).
 */
export const VOID_COPY = Object.freeze({
  title: 'إلغاء بيع',
  link: 'إلغاء بيع',
  loading: 'جارٍ التحميل…',
  lookupHeading: 'البحث عن بيع',
  numberLabel: 'رقم البيع',
  search: 'بحث',
  saleHeading: 'البيع',
  saleNumber: 'رقم البيع',
  soldAt: 'وقت البيع',
  seller: 'البائع',
  total: 'إجمالي البيع',
  cash: 'نقدي في الدرج',
  voidAction: 'إلغاء هذا البيع',
  sameDayHint: 'يمكن إلغاء البيع في يوم بيعه فقط، وبتأكيد مدير آخر غيرك وغير بائع الفاتورة.',
  dialogTitle: 'تأكيد إلغاء البيع',
  dialogBody:
    'يلزم مدير آخر، ليس أنت وليس بائع الفاتورة، ليؤكد الإلغاء برقمه السري. لا يخرج نقد من الدرج الآن: يُصرف النقد بعد أن يؤكد الخادم الإلغاء.',
  managerLegend: 'المدير المؤكِّد',
  pinLabel: 'الرقم السري للمدير',
  approve: 'تأكيد الإلغاء',
  back: 'رجوع',
  noManagers: 'لا يوجد مدير مفعّل لتأكيد الإلغاء على هذه الطرفية.',
  requested: 'سُجّل طلب الإلغاء. يُرسل تلقائيًا عند اتصال مُقدِّمه بالإنترنت.',
  historyTitle: 'طلبات الإلغاء',
  noHistory: 'لا توجد طلبات إلغاء.',
  requestedAt: 'وقت الطلب',
  acknowledge: 'تم الاطلاع',
  // RT-1403 S2 (PROPOSED): also a payout left unfinished, or cash never paid out in its window.
  attentionBanner:
    'يحتاج طلب إلغاء بيع إلى مراجعتك: رفض الخادم، أو صرف نقد لم يكتمل. افتح «إلغاء بيع».',
  attentionAction: 'عرض',
  unavailable: 'تعذّر تنفيذ الإجراء. حاول مرة أخرى.',
  // RT-1403 S2 (PROPOSED): the cash of a confirmed void.
  cashDue: 'النقد المستحق للعميل',
  payOut: 'صرف النقد',
  paidOut: 'تم صرف النقد',
  paidAt: 'وقت الصرف',
  claimed: 'بدأ صرف النقد ولم يكتمل',
  retryDrawer: 'إعادة فتح الدرج',
  manualComplete: 'تأكيد صرف النقد يدويًا',
  managerPays: 'يصرف النقد مدير.',
  drawerMayBeOpen: 'قد يكون الدرج مفتوحًا. لا تُسلِّم النقد للعميل قبل أن يؤكد المدير الصرف.',
  // RT-1403 c18188 (PROPOSED): a claim whose shift is gone or whose day passed. One coherent set:
  // it cannot be completed here; only another manager's exception settles it, after checking that the
  // customer was not already paid; and an earlier shift's drawer shows as an overage in this count.
  claimWindowClosed:
    'انتهت وردية هذا الصرف أو يومه، فلا يُكمَل بإعادة فتح الدرج ولا يدويًا. لا يُسجَّل إلا بإقرار مدير آخر في وردية مفتوحة، بعد التأكد من أن العميل لم يستلم نقده.',
  claimStaleOverage:
    'إن كان الدرج قد فُتح في وردية سابقة، فسيظهر في جرد هذه الوردية فائض مطابق لهذا المبلغ، وتبقى الوردية السابقة كما أُغلقت.',
  voidStateIs: 'حالة الإلغاء',
  // RT-1403 S2 (PROPOSED): cash that left the drawer outside the payout gate.
  exceptionAction: 'تسجيل نقد صُرف خارج الإجراء',
  exceptionTitle: 'تسجيل نقد صُرف خارج الإجراء',
  exceptionBody:
    'استخدمه فقط إذا خرج النقد من الدرج فعلًا دون أن يسمح به النظام. يلزم مدير آخر غيرك ليقرّ بذلك برقمه السري. يُسجَّل مرة واحدة، ويُنقص النقد المتوقع في الوردية المفتوحة، ويُعلَّم للمراجعة إن خالف حالة الإلغاء.',
  exceptionApprove: 'تأكيد التسجيل',
  exceptionRecorded: 'سُجّل النقد المصروف بإقرار المدير.',
  exceptionRecordedLabel: 'نقد مصروف بإقرار مدير',
  exceptionApprovalUnavailable:
    'تعذّر التأكيد: الرقم السري غير صحيح أو غير مفعّل، أو أن المؤكِّد هو أنت. يجب أن يؤكد مدير آخر.',
});

const MISMATCHES: Readonly<Record<SaleVoidMismatchReason, string>> = {
  void_refused: 'للمراجعة: خرج النقد رغم أن الخادم رفض الإلغاء.',
  void_unconfirmed: 'للمراجعة: خرج النقد قبل أن يؤكد الخادم الإلغاء.',
  payout_window_closed: 'للمراجعة: خرج النقد بعد انتهاء يوم الإلغاء أو وردية طلبه.',
};

/** Why a recorded cash exception is flagged for a manager to reconcile (PROPOSED copy). */
export function voidMismatchMessage(reason: SaleVoidMismatchReason): string {
  return MISMATCHES[reason];
}

const REFUSALS: Readonly<Record<SaleVoidRefusalReason | ManagerApprovalRefusalReason, string>> = {
  // Local refusals (nothing journaled).
  feature_disabled: 'إلغاء البيع غير مفعّل على هذه الطرفية.',
  no_session: 'سجّل الدخول للمتابعة.',
  session_locked: 'الجهاز مقفل.',
  invalid_input: 'البيانات غير صحيحة.',
  sale_not_found: 'لا يوجد بيع بهذا الرقم على هذه الطرفية.',
  // RT-741: a cashier asked for another operator's sale.
  role_denied: 'غير مسموح لك بعرض هذا البيع.',
  not_same_day: 'انتهى يوم هذا البيع، فلا يمكن إلغاؤه. استخدم المرتجعات.',
  already_voided: 'لهذا البيع طلب إلغاء بالفعل.',
  has_return: 'لهذا البيع مرتجع، فلا يمكن إلغاؤه.',
  no_operator_envelope: 'هذه الجلسة غير متصلة، فلا يمكن إرسال الإلغاء منها. سجّل الدخول متصلًا.',
  approval_invalid: 'انتهى التأكيد أو لا يخص هذا البيع. أكّد مرة أخرى.',
  approval_stale: 'تغيّر البيع منذ التأكيد. أعد البحث وأكّد مرة أخرى.',
  void_unavailable: 'تعذّر تنفيذ الإجراء. حاول مرة أخرى.',
  // RT-1403 S2 (PROPOSED): why no cash is paid out.
  payout_void_not_confirmed: 'لم يؤكد الخادم الإلغاء بعد، فلا يُصرف النقد الآن.',
  payout_void_refused: 'رفض الخادم الإلغاء، فلا يُصرف نقد.',
  payout_no_cash: 'لا نقد يُصرف لهذا البيع.',
  payout_no_open_shift: 'لا توجد وردية مفتوحة. افتح وردية ليُصرف النقد فيها.',
  // Owner decision (RT-1403, delegated 2026-11-22): after the window a late payout is only the
  // manager-attested cash exception (current open shift, another manager's PIN, once, flagged).
  payout_wrong_day: 'انتهت مهلة صرف النقد (يوم الإلغاء). يلزم إقرار مدير آخر لصرف النقد المتأخر.',
  payout_other_shift:
    'انتهت مهلة صرف النقد (وردية الإلغاء). يلزم إقرار مدير آخر لصرف النقد المتأخر.',
  payout_already_recorded: 'سُجّل صرف النقد لهذا البيع من قبل.',
  payout_drawer_failed: 'تعذّر التأكد من فتح الدرج، ولم يُسجَّل صرف.',
  payout_started: 'بدأ صرف النقد لهذا الإلغاء من قبل. يكمله المدير.',
  payout_not_started: 'لم يبدأ صرف النقد لهذا الإلغاء.',
  payout_drawer_retry_unsafe:
    'قد يكون الدرج قد فُتح، فلا تُعاد المحاولة. يؤكد المدير الصرف يدويًا.',
  payout_drawer_in_progress: 'فتح الدرج قيد التنفيذ. انتظر ثوانٍ ثم حاول.',
  another_payout_in_progress: 'عملية صرف أخرى جارية على هذه الطرفية. انتظر حتى تنتهي.',
  payout_in_progress: 'صرف النقد قيد التنفيذ.',
  // The approval itself: never says which part failed (RT-114 C3), but names
  // the four-eyes rule so the cashier knows another manager is needed.
  approval_unavailable:
    'تعذّر التأكيد: الرقم السري غير صحيح أو غير مفعّل، أو أن المؤكِّد هو طالب الإلغاء أو بائع الفاتورة. يجب أن يؤكد مدير آخر.',
  // RT-1326: three wrong approver PINs on this request.
  approval_attempts_exhausted:
    'أُدخل رقم سري خاطئ ثلاث مرات لهذا الطلب. انتظر خمس دقائق ثم اطلب الموافقة من جديد.',
  not_applicable: 'لا يحتاج هذا الإجراء إلى تأكيد.',
  // Backend-Core refusals (terminal, shown on the queued void).
  void_outside_business_day:
    'انتهى يوم البيع قبل إرسال الإلغاء، فرفضه الخادم. استخدم المرتجعات بدلًا منه.',
  void_approval_required: 'رفض الخادم الإلغاء: لا يوجد تأكيد مدير.',
  void_approval_invalid: 'رفض الخادم الإلغاء: التأكيد لا يطابق هذا البيع أو مبلغه.',
  void_requester_mismatch: 'رفض الخادم الإلغاء: طالب الإلغاء ليس المستخدم المسجّل لإرساله.',
  void_requester_not_eligible: 'رفض الخادم الإلغاء: طالب الإلغاء ليس من موظفي هذا الفرع.',
  void_self_approval:
    'رفض الخادم الإلغاء: المؤكِّد هو طالب الإلغاء أو بائع الفاتورة. يلزم مدير آخر.',
  void_approver_not_eligible: 'رفض الخادم الإلغاء: المؤكِّد ليس مديرًا مؤهلًا لهذا الفرع.',
  already_reversed: 'رفض الخادم الإلغاء: البيع ملغى أو له مرتجع بالفعل.',
  conflict: 'رفض الخادم الإلغاء: تعارض مع طلب سابق.',
  validation_error: 'رفض الخادم الإلغاء: بيانات غير صالحة.',
};

export function voidRefusalMessage(reason: string): string {
  return (REFUSALS as Record<string, string | undefined>)[reason] ?? VOID_COPY.unavailable;
}

const STATE_LABELS: Readonly<Record<SaleVoidState, string>> = {
  pending: 'طلب الإلغاء بانتظار الإرسال',
  unknown: 'تعذّر تأكيد الإرسال، وستُعاد المحاولة تلقائيًا',
  confirmed: 'تم الإلغاء',
  refused: 'رُفض الإلغاء',
};

export function voidStateLabel(state: SaleVoidState): string {
  return STATE_LABELS[state];
}

/**
 * RT-1403 c18188 (PROPOSED): a stale claim whose drawer opened on `claimedAt` (the claim and its
 * kick are one step): check the customer was not already paid before paying again.
 */
export function voidClaimOpenedWarning(claimedAt: string): string {
  return `فُتح الدرج بتاريخ ${formatShiftTime(claimedAt)}. تأكد أن العميل لم يستلم نقده من قبل قبل أن تصرف له مرة أخرى.`;
}

/** What a queued void is waiting for, in words; the requester is named, nobody else. */
export function voidWaitingMessage(
  waitingFor: 'sale_sync' | 'requester_sign_in',
  requesterName: string,
): string {
  return waitingFor === 'sale_sync'
    ? 'بانتظار مزامنة البيع مع الخادم'
    : `بانتظار تسجيل دخول ${requesterName} متصلًا لإرسال الإلغاء`;
}
