import type {
  ReturnCloseReadiness,
  ReturnDrawerFailure,
  ReturnState,
  ReturnStatusCause,
  ReturnUnknownCause,
  ReturnsReadStatusResponse,
  ReturnsRefusalReason,
} from '../../shared/returns/types.js';
import type { ReprintResult } from './payout-state.js';

/**
 * RT-15 S3 — the return flow's Arabic copy (AC10).
 *
 * One message per refusal reason, each saying what is true and what to do,
 * with no interpolated input. A reason main adds later without copy here
 * falls back to a generic line rather than rendering nothing.
 */
const REFUSAL_COPY: Readonly<Record<ReturnsRefusalReason, string>> = Object.freeze({
  // Backend-Core answers.
  over_return: 'الكمية المطلوبة تتجاوز ما بقي قابلًا للإرجاع على الخادم. لم يُسجَّل المرتجع.',
  already_reversed: 'هذا البيع أُلغي أو عُكس على الخادم، فلا يمكن إرجاعه.',
  conflict: 'رفض الخادم المرتجع لتعارضه مع عملية أخرى على البيع نفسه.',
  return_tender_mismatch: 'لم يطابق مبلغ الاسترداد النقدي إجمالي الخادم. لم يُسجَّل المرتجع.',
  validation_error: 'رفض الخادم بيانات المرتجع لأنها غير صالحة.',
  unauthorized: 'لم يقبل الخادم صلاحية هذه الجلسة. سجّل الدخول من جديد ثم حاول.',
  returns_unavailable: 'المرتجعات غير متاحة على الخادم لهذا البيع حاليًا.',
  // RT-196 S1 (OD-196-9): the sale has payer responsibilities (credit).
  credit_sale_reversal_restricted:
    'هذا البيع عليه مسؤولية دفع آجلة، فلا يُرجَع من هنا. لم يُسجَّل المرتجع ولم يُصرف أي نقد.',
  // RT-1339 (spec 048 OD-10 / OD-11): an automatic offer's discount. Backend-Core decides; nothing is recorded.
  // RT-1372: Backend-Core records reward-line returns since RT-1367 PR 2, so the OD-10 remedy is back: add the
  // reward units. The OD-11 interim code keeps the manager while an older Backend-Core can still return it.
  promotion_clawback_exceeds_refund:
    'خصم العرض الذي أخذه العميل أكبر من مبلغ الأصناف المختارة. لم يُسجَّل المرتجع ولم يُصرف أي نقد. ابدأ «مرتجع جديد» من البيع نفسه، واختر الأصناف نفسها، وأضف وحدات المكافأة إلى المرتجع.',
  promotion_return_requires_clawback:
    'هذا المرتجع يُلغي خصم عرض على الأصناف الباقية مع العميل، ولا يُسجَّل من هنا حاليًا. لم يُسجَّل المرتجع ولم يُصرف أي نقد. راجع المدير.',
  // Decided on the till.
  feature_disabled: 'المرتجعات غير مفعّلة على هذا الجهاز.',
  no_session: 'لا توجد جلسة تشغيل. سجّل الدخول للمتابعة.',
  role_denied: 'المرتجعات متاحة للمدير أو مسؤول النظام فقط.',
  invalid_input: 'بيانات الطلب غير صالحة. راجع رقم البيع والكميات.',
  sale_not_found: 'لا يوجد بيع بهذا الرقم على هذا الجهاز.',
  sale_not_synced: 'لم يُرسَل هذا البيع إلى الخادم بعد، فلا يمكن إرجاعه الآن.',
  card_tender_blocked: 'دُفع هذا البيع ببطاقة كليًا أو جزئيًا، والاسترداد هنا نقدي فقط.',
  sale_voided: 'هذا البيع ملغى، فلا يمكن إرجاعه.',
  nothing_returnable: 'أُرجعت كل أصناف هذا البيع من قبل.',
  line_not_returnable: 'أحد الأصناف المختارة لم يعد قابلًا للإرجاع. ابحث عن البيع من جديد.',
  quantity_out_of_range:
    'إحدى الكميات خارج المسموح الآن. ابحث عن البيع من جديد لرؤية الكميات الحالية.',
  amount_not_payable: 'لا يمكن صرف مبلغ هذه الأصناف نقدًا بدقة. اختر كميات أخرى.',
  unresolved_return_exists:
    'لهذا البيع مرتجع سابق لم تتأكد نتيجته بعد. تحقّق منه في سجل المرتجعات أولًا.',
  offline: 'تعذّر الوصول إلى الخادم. المرتجعات تحتاج اتصالًا مباشرًا.',
  tender_unknown: 'لا يثبت أن هذا البيع دُفع نقدًا بالكامل، فلا يُسترد نقدًا.',
  sale_mismatch: 'بيانات البيع على الخادم لا تطابق هذا الجهاز. لا يمكن إرجاعه من هنا.',
  session_changed: 'تغيّرت جلسة التشغيل أثناء الطلب، فلم تُعرض النتيجة.',
  // RT-196 S1 — a resend of a return that is no longer unresolved.
  already_resolved: 'حُسمت حالة هذا المرتجع من قبل. حدّث السجل.',
  // RT-1498 S4/S5 — PROPOSED copy (owner copy review pending): handing a return to support.
  never_sent: 'لم يُرسل هذا المرتجع إلى الخادم بعد. أعد إرساله أولًا، ثم حوّله إلى الدعم إن لزم.',
  approval_invalid:
    'انتهى تأكيد المدير أو لا يخص هذا المرتجع. اطلب التأكيد من جديد من مدير آخر غيرك.',
  approval_stale: 'تغيّرت حالة هذا المرتجع منذ التأكيد. حدّث السجل ثم اطلب التأكيد من جديد.',
  // RT-1498 close slice. `send_in_flight`, `close_needs_not_recorded` and `read_unauthorized` are the
  // RT-196 design §3.9 lines verbatim; the other two are PROPOSED copy (owner copy review pending).
  reconcile_too_soon:
    'أُرسل هذا المرتجع قبل قليل. لا يُغلق قبل مرور 15 دقيقة على آخر إرسال. انتظر ثم حدّث الحالة.',
  quiet_period_unproven:
    'تعذّر إثبات مرور 15 دقيقة على آخر إرسال على هذا الجهاز، لأن التطبيق أُعيد تشغيله أو تغيّر وقت الجهاز. أعد إرسال المرتجع، وانتظر 15 دقيقة ثم حدّث الحالة.',
  send_in_flight: 'يجري إرسال هذا المرتجع الآن. انتظر حتى ينتهي ثم حدّث الحالة.',
  close_needs_not_recorded:
    'لا يُغلق المرتجع إلا بعد أن يؤكد الخادم أنه لم يُسجَّل. حدّث الحالة أولًا.',
  read_unauthorized:
    'لا يملك هذا الجهاز أو هذه الجلسة صلاحية التحقق الآن. سجّل الدخول من جديد، وإن تكرر فتواصل مع الدعم.',
  // RT-15 S4 — payout and slip.
  return_not_found: 'لا يوجد هذا المرتجع على هذا الجهاز.',
  not_payable: 'لم يتأكد هذا المرتجع على الخادم، فلا يُصرف نقده.',
  already_paid_out: 'صُرف نقد هذا المرتجع من قبل. لا تصرفه مرة ثانية.',
  payout_started: 'بدأ صرف هذا المرتجع من قبل ولم يكتمل.',
  payout_not_started: 'لم يبدأ صرف هذا المرتجع بعد.',
  not_paid_out: 'لا يوجد إيصال لهذا المرتجع: لم يُصرف نقده بعد.',
  // RT-198: work in flight at stop may already have happened (a resolve
  // pass, a drawer kick): never "nothing was done".
  shutting_down: 'التطبيق يُغلق الآن. راجع سجل المرتجعات بعد إعادة تشغيله.',
  drawer_retry_unsafe:
    'ربما فُتح الدرج من قبل، فلن يُفتح مرة ثانية. عُدّ النقد، وإن سلّمت العميل المبلغ فسجّل الصرف يدويًا.',
  drawer_kick_in_progress:
    'يُفتح الدرج لهذا المرتجع الآن، ربما من نافذة أو جهاز آخر. انتظر بضع ثوانٍ ثم حدّث الحالة.',
  payout_step_in_progress:
    'تجري خطوة أخرى لصرف هذا المرتجع الآن، فلم يُنفَّذ طلبك. انتظر حتى تنتهي ثم حدّث الحالة.',
  another_payout_in_progress:
    'يجري صرف مرتجع آخر على هذا الجهاز الآن، فلم يُنفَّذ شيء. انتظر حتى ينتهي ثم حدّث الحالة.',
  slip_total_mismatch:
    'لا تطابق مبالغ الأصناف إجمالي الاسترداد، فلم يُطبع الإيصال. الصرف نفسه سليم.',
  // RT-1543 follow-up — PROPOSED copy (owner copy review pending): a NEW payout with no open shift;
  // main answers it only before any claim, kick or write, so no cash was paid.
  payout_no_open_shift:
    'لا توجد وردية مفتوحة على هذا الجهاز، فلم يُصرف أي نقد. افتح وردية أولًا ثم حدّث الحالة وأعد الصرف.',
});

/**
 * RT-1339 (spec 048 §9): an automatic offer on a sold line. Marks only; Backend-Core decides the
 * refund and the clawback, and the till shows its answer.
 */
export const OFFER_ROLE_COPY = Object.freeze({
  reward: 'أخذت هذه الوحدة خصم عرض',
  participant: 'ضمن عرض',
  note: 'بعض الأصناف المختارة بيعت ضمن عرض. قد يُنقص الخادم مبلغ الاسترداد حسب العرض، وتظهر نتيجته هنا. إن رفض الخادم المرتجع لأن خصم العرض أكبر من مبلغ الأصناف المختارة، فأضف وحدات المكافأة من البيع نفسه إلى المرتجع.',
});

/** Non-refusal outcomes and notices; each distinct from every refusal line. */
export const OUTCOME_COPY = Object.freeze({
  confirmed: 'تم تسجيل المرتجع على الخادم.',
  replayed: 'هذا المرتجع مسجَّل من قبل على الخادم، ولم يُسجَّل مرة ثانية.',
  unconfirmed: 'النتيجة غير مؤكدة. لا تعتبر المرتجع مكتملًا حتى يتأكد.',
  stillUnconfirmed: 'ما زالت النتيجة غير مؤكدة. حاول التحقق مرة أخرى لاحقًا.',
  mayBeRecorded: 'قد يكون المرتجع سُجّل. راجع سجل المرتجعات أدناه قبل أي محاولة جديدة.',
  submitFailed: 'لم تُعرف نتيجة الطلب. راجع سجل المرتجعات أدناه قبل أي محاولة جديدة.',
  callFailed: 'تعذّر إكمال الطلب على هذا الجهاز. حاول مرة أخرى.',
  unknownReason: 'تعذّر تنفيذ الطلب.',
  bridgeMissing: 'المرتجعات غير متاحة في هذه النسخة من التطبيق.',
  historyEmpty: 'لا توجد مرتجعات مسجَّلة على هذا الجهاز.',
});

/**
 * RT-15 S4 — the payout panel's copy. Paid only when main recorded it;
 * everything else says what is true and what is safe to do next.
 */
export const PAYOUT_COPY = Object.freeze({
  heading: 'صرف النقد',
  amountLabel: 'المبلغ المستحق للعميل',
  ready: 'يُفتح الدرج، ثم يُسجَّل الصرف ويُطبع إيصال المرتجع.',
  start: 'افتح الدرج واصرف النقد',
  opening: 'جارٍ فتح الدرج…',
  paid: 'سُجّل صرف المبلغ نقدًا.',
  paidDrawer: 'الدرج مفتوح: سلّم العميل المبلغ.',
  paidManual: 'سُجّل أنك سلّمت العميل المبلغ يدويًا.',
  // RT-531: no cash drawer on this terminal; nothing to attest, nothing was opened.
  paidNoDrawer: 'لا يوجد درج نقود موصول بهذا الجهاز: سلّم العميل المبلغ.',
  paidEarlier: 'صُرف نقد هذا المرتجع من قبل.',
  slipPrinted: 'طُبع إيصال المرتجع.',
  slipFailed: 'لم يُطبع إيصال المرتجع. الصرف مسجَّل، ويمكنك طباعة نسخة.',
  reprint: 'طباعة نسخة من الإيصال',
  reprinted: 'طُبعت نسخة من إيصال المرتجع.',
  reprintFailed: 'لم تُطبع النسخة. تحقّق من الطابعة ثم حاول مجددًا.',
  reprintUnknown: 'لم تُعرف نتيجة طباعة النسخة. انظر هل خرجت من الطابعة قبل إعادة المحاولة.',
  drawerFailed: 'لم يُفتح الدرج، ولم يُسجَّل أي صرف.',
  drawerUnknown:
    'لا يُعرف هل فُتح الدرج، ولم يُسجَّل أي صرف. عُدّ النقد في الدرج، وإن سلّمت العميل المبلغ فسجّل الصرف يدويًا.',
  retryDrawer: 'حاول فتح الدرج مجددًا',
  manual: 'صرفتُ المبلغ يدويًا',
  confirmManual:
    'هل سلّمت العميل المبلغ نقدًا من درج فتحته يدويًا؟ سيُسجَّل الصرف باسمك ولا يمكن التراجع عنه.',
  confirmManualYes: 'نعم، سجّل الصرف',
  cancel: 'إلغاء',
  interrupted: 'بدأ صرف هذا المرتجع ولم يكتمل.',
  interruptedCheck:
    'ربما فُتح الدرج من قبل. تأكّد هل استلم العميل المبلغ قبل المتابعة، ولا تصرفه مرتين.',
  interruptedRetry: 'لم يستلمه: افتح الدرج واصرف',
  interruptedManual: 'استلمه العميل: سجّل الصرف',
  unknown: 'لم تُعرف نتيجة الصرف. حدّث حالة المرتجع قبل أي محاولة جديدة.',
  refresh: 'تحديث الحالة',
  historyAction: 'إجراء',
  historyPay: 'صرف',
  historyComplete: 'إكمال الصرف',
  historyReprint: 'طباعة نسخة',
});

const DRAWER_FAILURE_COPY: Readonly<Record<ReturnDrawerFailure, string>> = Object.freeze({
  no_drawer_configured: 'لا يوجد درج نقود موصول بهذا الجهاز.',
  printer_dk_failure: 'لم تستطع الطابعة فتح الدرج.',
  os_error: 'حدث خطأ في الجهاز أثناء فتح الدرج.',
  timeout: 'لم يردّ الدرج في الوقت المحدد.',
});

export function drawerFailureMessage(reason: ReturnDrawerFailure): string {
  return reason in DRAWER_FAILURE_COPY ? DRAWER_FAILURE_COPY[reason] : OUTCOME_COPY.unknownReason;
}

/** RT-15 S4 — a reprint's result, each in its own words (only print_failed blames the printer). */
export function reprintMessage(result: ReprintResult): string {
  switch (result.kind) {
    case 'printed':
      return PAYOUT_COPY.reprinted;
    case 'print_failed':
      return PAYOUT_COPY.reprintFailed;
    case 'refused':
      return refusalMessage(result.reason);
    case 'unknown':
      return PAYOUT_COPY.reprintUnknown;
  }
}

export function refusalMessage(reason: ReturnsRefusalReason): string {
  return reason in REFUSAL_COPY ? REFUSAL_COPY[reason] : OUTCOME_COPY.unknownReason;
}

const STATE_LABELS: Readonly<Record<ReturnState, string>> = Object.freeze({
  pending: 'قيد الإرسال',
  confirmed: 'مسجَّل على الخادم',
  paid_out: 'صُرف نقدًا',
  refused: 'مرفوض',
  unknown: 'غير مؤكد',
});

export function stateLabel(state: ReturnState): string {
  return STATE_LABELS[state];
}

const UNKNOWN_CAUSE_COPY: Readonly<Record<ReturnUnknownCause, string>> = Object.freeze({
  timeout: 'انتهت مهلة الانتظار قبل وصول رد الخادم.',
  network: 'انقطع الاتصال بالخادم أثناء الإرسال، ولا يُعرف هل وصل الطلب.',
  server_5xx: 'أعاد الخادم خطأً من جهته.',
  rate_limited: 'طلب الخادم التمهّل قبل إعادة المحاولة.',
  pre_replay_401:
    'لم يتعرّف الخادم على هذه الجلسة أو هذا الجهاز عند إعادة الإرسال (401). قد يكون الإرسال السابق سُجّل.',
  pre_replay_403:
    'لا يملك هذا الجهاز أو هذه الجلسة صلاحية الإرسال عند إعادة الإرسال (403). قد يكون الإرسال السابق سُجّل.',
  pre_replay_404:
    'تعذّر على الخادم إيجاد البيع، أو أن المرتجعات غير مفعّلة عليه (404). قد يكون الإرسال السابق سُجّل.',
  confirmation_mismatch: 'رد الخادم لا يطابق المرتجع المحفوظ على هذا الجهاز.',
  unreadable_body: 'لم يُفهم رد الخادم.',
  local_commit_failed: 'تعذّر حفظ رد الخادم على هذا الجهاز.',
  no_credential: 'لا توجد بيانات دخول صالحة للإرسال في الجلسة الحالية. سجّل الدخول من جديد.',
  unexpected_status: 'رد الخادم برمز حالة غير متوقع.',
});

/**
 * RT-1498 (RT-196 S1 remainder + the history-only part of S6) — the unresolved
 * return's row detail and its per-row resend. PROPOSED copy: the RT-196 plan
 * (§3.1, §3.9) fixes the action name «إعادة الإرسال» and the do-not-pay line;
 * the cause wording is new and awaits owner copy review. Each line says only
 * what the local audit proves (the closed cause code), and none says declined.
 */
export const UNRESOLVED_COPY = Object.freeze({
  resend: 'إعادة الإرسال',
  attemptsLabel: 'محاولات الإرسال',
  attempts: (count: number): string => `محاولات الإرسال: ${String(count)}`,
  lastAttemptLabel: 'آخر محاولة',
  neverSent: 'لم يُرسل هذا المرتجع إلى الخادم بعد.',
  doNotPay: 'النتيجة غير مؤكدة. لا تصرف أي نقد حتى تتأكد الحالة.',
  codeLabel: 'الرمز',
  /** The wording of a cause code; empty for a code the renderer was not taught. */
  cause: (cause: ReturnUnknownCause): string =>
    cause in UNKNOWN_CAUSE_COPY ? UNKNOWN_CAUSE_COPY[cause] : '',
});

/**
 * RT-1498 S4/S5 — handing an unresolved return to support. PROPOSED copy, pending owner review,
 * except the three lines the RT-196 design §3.9 fixes verbatim (`action`, `raised`, and the two
 * disposition labels). One locale, no English; the verbs stay within what the evidence proves:
 * «حُوّل» only once main recorded the disposition. A return handed to support is still unresolved:
 * the do-not-pay line stays.
 */
export const ESCALATE_COPY = Object.freeze({
  /** RT-196 §3.9 `action.support`. */
  action: 'تحويل إلى الدعم',
  title: 'تحويل المرتجع إلى الدعم',
  body: 'يلزم مدير آخر، ليس أنت، ليؤكد التحويل برقمه السري. لا يُعاد إرسال المرتجع تلقائيًا بعد ذلك، ويبقى هذا البيع موقوفًا عن المرتجعات حتى يُحسم. لم يُصرف أي نقد.',
  approve: 'تأكيد التحويل',
  /** RT-196 §3.9 `supportRaised`. */
  raised: 'حُوّل المرتجع إلى الدعم. يبقى هذا البيع موقوفًا عن المرتجعات حتى يُحسم.',
  approvalUnavailable:
    'تعذّر التأكيد: الرقم السري غير صحيح أو غير مفعّل، أو أن المؤكِّد هو من طلب التحويل. يجب أن يؤكد مدير آخر غيرك.',
  /** RT-1326: three wrong approver PINs on this request. PROPOSED. */
  attemptsExhausted:
    'أُدخل رقم سري خاطئ ثلاث مرات لهذا التحويل. انتظر خمس دقائق ثم اطلب التأكيد من جديد.',
  /** Any other refused approval (no session, locked, not applicable…): a returns line, never the void's. PROPOSED. */
  approvalFailed: 'تعذّر تأكيد التحويل الآن. أعد المحاولة، وإن تكرر فراجع المدير.',
});

/** RT-1498 S4: how a return with a recorded disposition reads in the journal. */
export const DISPOSITION_COPY = Object.freeze({
  /** RT-196 §3.9 `status.needs_support` and `status.not_recorded_closed`. */
  label: Object.freeze({
    needs_support: 'بانتظار الدعم',
    closed: 'لم يُسجَّل — مغلق',
  }),
  supportDetail:
    'لا يُعاد إرسال هذا المرتجع تلقائيًا، ويبقى هذا البيع موقوفًا عن المرتجعات. إعادة الإرسال متاحة بيدك.',
  /** RT-196 §3.9 `closed`. */
  closedDetail: 'أُغلق المرتجع كغير مسجَّل. يمكن الآن إرجاع هذا البيع من جديد.',
});

/**
 * The message of a refused manager approval of an escalation (never says which part failed, C3).
 * Every reason has a RETURNS line: it never falls back to the sale void's copy (RT-1498 review LOW-5).
 */
export function escalateApprovalMessage(reason: string): string {
  switch (reason) {
    case 'approval_unavailable':
      return ESCALATE_COPY.approvalUnavailable;
    case 'approval_attempts_exhausted':
      return ESCALATE_COPY.attemptsExhausted;
    case 'approval_invalid':
    case 'approval_stale':
      return refusalMessage(reason);
    default:
      return ESCALATE_COPY.approvalFailed;
  }
}

/**
 * RT-1498 close slice — reading the server's verdict on an unresolved return («تحديث الحالة») and closing
 * it as "not recorded". PROPOSED copy, pending owner review, except the lines the RT-196 design §3.9 fixes
 * verbatim (`STATUS_COPY.action`, `STATUS_COPY.readNotRecordedReady`, `CLOSE_COPY.action`). One locale,
 * no English. The verbs stay within what the server proved: «يؤكد الخادم» only for an affirmative verdict;
 * an unanswered read says nothing changed. A return is never called paid.
 */
export const STATUS_COPY = Object.freeze({
  /** RT-196 §3.9 `action.read`: a server read; it never sends the return. */
  action: 'تحديث الحالة',
  /** RT-196 §3.9 `readNotRecorded`: the server affirms, the quiet period is over. */
  readNotRecordedReady:
    'يؤكد الخادم أن هذا المرتجع لم يُسجَّل، ولم يُصرف له أي نقد. أعد إرساله، أو أغلقه بموافقة مدير ثم أنشئ مرتجعًا جديدًا.',
  /** The server affirms, but 15 minutes have not passed since the last send. */
  readNotRecordedWait: (time: string): string =>
    `يؤكد الخادم أن هذا المرتجع لم يُسجَّل حتى الآن. لا يُغلق قبل ${time}، ولا تصرف أي نقد.`,
  readNotRecordedClosed: 'لم يُسجَّل هذا المرتجع على الخادم حتى الآن، وهو مغلق ولن يُرسل.',
  /**
   * Appended to every affirmative `not_recorded` of an open return: main wrote a hold, so the
   * background and bar resends stopped (RT-1498 review MEDIUM-1). Only the manager's own resend voids it.
   */
  readHeldNote: 'لن يُعاد إرسال هذا المرتجع تلقائيًا بعد الآن، إلا بإعادة إرسال منك.',
  /** RT-196 §3.9 `readConfirmed` (verbatim): the read matched this return and confirmed it. */
  readConfirmed: 'أكّد الخادم أن هذا المرتجع مسجَّل. يمكنك الآن صرف النقد للعميل.',
  readRecordedResend:
    'سجّل الخادم هذا المرتجع. أعد إرساله ليتأكد على هذا الجهاز، ولا تصرف أي نقد قبل ذلك.',
  readRecordedSupport:
    'سجّل الخادم مرتجعًا بهذا الرقم لكنه لا يطابق ما على هذا الجهاز. لا تصرف أي نقد. حُوّل المرتجع إلى الدعم.',
  readLateCommit:
    'سجّل الخادم هذا المرتجع بعد إغلاقه. لا تصرف أي نقد، وأبلغ الدعم فورًا بهذا البيع.',
  /** No verdict from the server (a fault, not a refusal): nothing changed. */
  readNoVerdict: 'لم يردّ الخادم بجواب مفهوم الآن، ولم يتغيّر شيء. حاول مرة أخرى بعد قليل.',
});

export const CLOSE_COPY = Object.freeze({
  /** RT-196 §3.9 `action.close`. */
  action: 'إغلاق كمرتجع غير مسجَّل',
  title: 'إغلاق المرتجع كغير مسجَّل',
  body: 'أكّد الخادم أن هذا المرتجع لم يُسجَّل، وانقضت 15 دقيقة على آخر إرسال. يلزم مدير آخر، ليس أنت، ليؤكد الإغلاق برقمه السري. بعد الإغلاق يمكن إرجاع هذا البيع من جديد، ولا يُرسل هذا المرتجع بعدها أبدًا. لم يُصرف أي نقد.',
  approve: 'تأكيد الإغلاق',
  approvalUnavailable:
    'تعذّر التأكيد: الرقم السري غير صحيح أو غير مفعّل، أو أن المؤكِّد هو من طلب الإغلاق. يجب أن يؤكد مدير آخر غيرك.',
  attemptsExhausted:
    'أُدخل رقم سري خاطئ ثلاث مرات لهذا الإغلاق. انتظر خمس دقائق ثم اطلب التأكيد من جديد.',
  approvalFailed: 'تعذّر تأكيد الإغلاق الآن. أعد المحاولة، وإن تكرر فراجع المدير.',
});

/** The message of a refused manager approval of a close (never says which part failed, C3). */
export function closeApprovalMessage(reason: string): string {
  switch (reason) {
    case 'approval_unavailable':
      return CLOSE_COPY.approvalUnavailable;
    case 'approval_attempts_exhausted':
      return CLOSE_COPY.attemptsExhausted;
    case 'approval_invalid':
    case 'approval_stale':
      return refusalMessage(reason);
    default:
      return CLOSE_COPY.approvalFailed;
  }
}

/** Why a status read gave no verdict: the refusal line that says so, or null for the generic one. */
const NO_VERDICT_REASON: Readonly<Record<ReturnStatusCause, ReturnsRefusalReason | null>> = {
  offline: 'offline',
  unauthorized: 'read_unauthorized',
  unavailable: 'returns_unavailable',
  server: null,
  unreadable: null,
};

function notRecordedBase(close: ReturnCloseReadiness, formatTime: (iso: string) => string): string {
  if (close.ready) return STATUS_COPY.readNotRecordedReady;
  switch (close.reason) {
    case 'too_soon':
      return STATUS_COPY.readNotRecordedWait(formatTime(close.notBefore));
    case 'unproven':
      return refusalMessage('quiet_period_unproven');
    case 'closed':
      return STATUS_COPY.readNotRecordedClosed;
  }
}

/** An open return's `not_recorded` also says automatic resends stopped; a closed one is never sent. */
function notRecordedMessage(
  close: ReturnCloseReadiness,
  formatTime: (iso: string) => string,
): string {
  const base = notRecordedBase(close, formatTime);
  const closed = !close.ready && close.reason === 'closed';
  return closed ? base : `${base} ${STATUS_COPY.readHeldNote}`;
}

/** The line for one answer of `returns.readStatus` (`formatTime` shows when a running period ends). */
export function statusReadMessage(
  res: ReturnsReadStatusResponse,
  formatTime: (iso: string) => string,
): string {
  switch (res.kind) {
    case 'refused':
      return refusalMessage(res.reason);
    case 'inconclusive': {
      const reason = NO_VERDICT_REASON[res.cause];
      return reason === null ? STATUS_COPY.readNoVerdict : refusalMessage(reason);
    }
    case 'recorded':
      return {
        confirmed: STATUS_COPY.readConfirmed,
        resend: STATUS_COPY.readRecordedResend,
        support: STATUS_COPY.readRecordedSupport,
        late_commit: STATUS_COPY.readLateCommit,
      }[res.outcome];
    case 'not_recorded':
      return notRecordedMessage(res.close, formatTime);
  }
}
