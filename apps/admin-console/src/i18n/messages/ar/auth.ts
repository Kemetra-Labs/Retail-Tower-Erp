import type { Messages } from "../types";

/**
 * Arabic copy for the auth surfaces: sign-in (SF-1), accept invitation
 * (SF5-4) and the no-access terminal state (S7). The product word mark
 * «Retail Tower OS» is a proper name and stays Latin in the markup, so it has
 * no key here.
 */
export const auth = {
  "auth.signIn.title": "تسجيل الدخول",
  "auth.signIn.subtitle": "لوحة إدارة المتاجر والكتالوج والمبيعات.",
  "auth.signIn.email.label": "البريد الإلكتروني",
  "auth.signIn.password.label": "كلمة المرور",
  "auth.signIn.submit": "تسجيل الدخول",
  "auth.signIn.submitting": "جارٍ تسجيل الدخول",
  "auth.signIn.retryIn": {
    zero: "حاول مرة أخرى بعد {count} ثانية",
    one: "حاول مرة أخرى بعد ثانية واحدة",
    two: "حاول مرة أخرى بعد ثانيتين",
    few: "حاول مرة أخرى بعد {count} ثوانٍ",
    many: "حاول مرة أخرى بعد {count} ثانية",
    other: "حاول مرة أخرى بعد {count} ثانية",
  },
  // 401 and 5xx share one message: it must never reveal whether the account
  // exists (FR-003-007).
  "auth.signIn.errors.failed":
    "تعذّر تسجيل الدخول. تحقّق من البريد الإلكتروني وكلمة المرور، ثم حاول مرة أخرى.",
  "auth.signIn.errors.rateLimited": {
    zero: "محاولات كثيرة جدًا. يمكنك المحاولة مرة أخرى بعد {count} ثانية.",
    one: "محاولات كثيرة جدًا. يمكنك المحاولة مرة أخرى بعد ثانية واحدة.",
    two: "محاولات كثيرة جدًا. يمكنك المحاولة مرة أخرى بعد ثانيتين.",
    few: "محاولات كثيرة جدًا. يمكنك المحاولة مرة أخرى بعد {count} ثوانٍ.",
    many: "محاولات كثيرة جدًا. يمكنك المحاولة مرة أخرى بعد {count} ثانية.",
    other: "محاولات كثيرة جدًا. يمكنك المحاولة مرة أخرى بعد {count} ثانية.",
  },
  "auth.signIn.footer": "منصة محمية · يخضع كل نشاط للتدقيق",
  "auth.signIn.invitesOnly": "تصل الدعوات بالبريد من مسؤول المؤسسة. لا يوجد تسجيل ذاتي.",

  // RT-971: the shared parts of the public screens (canvas «تسجيل الدخول»).
  "auth.password.show": "إظهار كلمة المرور",
  "auth.brand.flowTitle": "من الكاشير إلى الدفاتر",
  "auth.brand.flowPos": "نقاط البيع",
  "auth.brand.flowServer": "الخادم",
  "auth.brand.headline": "كل متاجرك في مكان واحد، بأرقام تثق فيها.",
  "auth.brand.body":
    "المبيعات والمخزون والأجهزة والترحيل المحاسبي، بنفس الحقيقة التي يراها الكاشير.",

  "auth.acceptInvitation.title": "قبول دعوتك",
  "auth.acceptInvitation.titleInvalid": "الدعوة",
  "auth.acceptInvitation.subtitle":
    "إن كنت جديدًا فاختر اسمًا معروضًا وكلمة مرور. إن كان لديك حساب فاترك الحقلين فارغين.",
  "auth.acceptInvitation.displayName.label": "الاسم المعروض",
  "auth.acceptInvitation.password.label": "كلمة المرور",
  "auth.acceptInvitation.password.hint": "مطلوبة عند إنشاء حساب جديد.",
  "auth.acceptInvitation.submit": "قبول الدعوة",
  "auth.acceptInvitation.submitting": "جارٍ قبول الدعوة",
  "auth.acceptInvitation.errors.invalidLink": "رابط الدعوة هذا غير صالح أو انتهت صلاحيته.",
  "auth.acceptInvitation.goToSignIn": "الانتقال إلى تسجيل الدخول",
  // {signIn} is the sign-in link, labelled by auth.acceptInvitation.signInLink.
  "auth.acceptInvitation.haveAccess": "لديك صلاحية وصول بالفعل؟ {signIn}",
  "auth.acceptInvitation.signInLink": "تسجيل الدخول",

  // RT-807 (PW-1, PW-4): the «حسابي» page and its change-password form.
  "auth.account.title": "حسابي",
  // {email} is the signed-in address, isolated LTR.
  "auth.account.subtitle": "للحساب {email}.",
  "auth.account.password.title": "تغيير كلمة المرور",
  "auth.account.current.label": "كلمة المرور الحالية",
  "auth.account.new.label": "كلمة المرور الجديدة",
  "auth.account.new.hint": "يحدد مزود الهوية شروط كلمة المرور.",
  "auth.account.confirm.label": "تأكيد كلمة المرور الجديدة",
  "auth.account.submit": "تغيير كلمة المرور",
  "auth.account.cancel": "إلغاء",
  "auth.account.errors.currentRequired": "أدخل كلمة المرور الحالية.",
  "auth.account.errors.newRequired": "أدخل كلمة المرور الجديدة.",
  "auth.account.errors.confirmRequired": "أعد إدخال كلمة المرور الجديدة.",
  "auth.account.errors.mismatch": "كلمتا المرور الجديدتان غير متطابقتين.",
  "auth.account.changed.title": "تغيّرت كلمة المرور.",
  "auth.account.changed.body": "سُجّل خروجك من جلساتك الأخرى. هذه الجلسة تبقى مفتوحة.",
  // 400 is one refusal: it must not say which password was wrong (RT-937).
  "auth.account.errors.refused.title": "تعذّر تغيير كلمة المرور.",
  "auth.account.errors.refused.body":
    "تحقّق من كلمة المرور الحالية، واختر كلمة جديدة تقبلها شروط مزود الهوية، ثم حاول مرة أخرى.",
  "auth.account.errors.noLink":
    "لا يمكن تغيير كلمة المرور من هنا. حسابك غير مرتبط بمزود الهوية بعد. اطلب المساعدة من مسؤول المؤسسة.",
  // 503 / 5xx: the provider may already have replaced it (UX-12.15).
  "auth.account.errors.notConfirmed":
    "تعذّر إكمال الطلب الآن، ولم يتأكد تغيير كلمة المرور. حاول بعد قليل.",
  "auth.account.errors.sessionExpired": "انتهت جلستك. سجّل الدخول مرة أخرى.",
  "auth.account.errors.failed":
    "تعذّر تغيير كلمة المرور، ولم تتغيّر. أعد تحميل الصفحة ثم حاول مرة أخرى.",
  "auth.account.aside.title": "ماذا يحدث بعد التغيير",
  "auth.account.aside.provider": "تُستبدل كلمة المرور لدى مزود الهوية، لا في لوحة التحكم.",
  "auth.account.aside.sessions": "يُسجَّل خروجك من جلساتك الأخرى. هذه الجلسة تبقى مفتوحة.",

  "auth.noAccess.title": "لا توجد صلاحية وصول مُسندة إليك",
  "auth.noAccess.body":
    "لقد سجّلت الدخول، لكن حسابك لا يملك بعدُ صلاحية وصول إلى أي مؤسسة أو متجر. تواصل مع المسؤول لديك لمنحك عضوية.",
  "auth.noAccess.signOut": "تسجيل الخروج",
} satisfies Messages;
