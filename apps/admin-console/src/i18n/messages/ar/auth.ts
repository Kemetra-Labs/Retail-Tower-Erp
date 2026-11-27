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
  // Above the title on the sign-in screen only: a new invitee is not "back".
  "auth.signIn.welcome": "مرحبًا بعودتك",
  "auth.signIn.forgotPassword": "نسيت كلمة المرور؟",

  // RT-1497: public password-reset request (/forgot-password) and confirm (/reset-password).
  "auth.forgotPassword.title": "استعادة كلمة المرور",
  "auth.forgotPassword.subtitle":
    "أدخل بريدك الإلكتروني وسنرسل لك رابطًا لإعادة تعيين كلمة المرور إذا كان الحساب مسجلًا.",
  "auth.forgotPassword.submit": "إرسال رابط الاستعادة",
  "auth.forgotPassword.submitting": "جارٍ الإرسال",
  "auth.forgotPassword.sent.title": "تحقّق من بريدك الإلكتروني.",
  // Opaque result: identical for registered and unregistered addresses (no enumeration).
  "auth.forgotPassword.sent.body":
    "إذا كان هذا البريد الإلكتروني مرتبطًا بحساب لديك، فسيصلك رابط لإعادة تعيين كلمة المرور خلال دقائق. إن لم تجده فتحقّق من مجلد الرسائل غير المرغوب فيها.",
  "auth.forgotPassword.tryAnother": "إرسال إلى بريد إلكتروني آخر",
  "auth.forgotPassword.backToSignIn": "العودة إلى تسجيل الدخول",
  "auth.forgotPassword.errors.emailRequired": "أدخل البريد الإلكتروني.",
  "auth.forgotPassword.errors.invalidEmail": "أدخل بريدًا إلكترونيًا صالحًا.",
  "auth.forgotPassword.errors.unavailable": "الخدمة غير متاحة مؤقتًا الآن. حاول مرة أخرى بعد قليل.",
  "auth.forgotPassword.errors.failed": "تعذّر إرسال الطلب الآن. حاول مرة أخرى بعد قليل.",

  "auth.resetPassword.title": "تعيين كلمة مرور جديدة",
  "auth.resetPassword.titleInvalid": "رابط غير صالح",
  "auth.resetPassword.subtitle": "اختر كلمة مرور جديدة لحسابك.",
  "auth.resetPassword.submit": "حفظ كلمة المرور الجديدة",
  "auth.resetPassword.submitting": "جارٍ الحفظ",
  "auth.resetPassword.done.title": "تم تحديث كلمة المرور.",
  "auth.resetPassword.done.body":
    "سُجّل خروجك من جلساتك السابقة. يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.",
  "auth.resetPassword.requestNewLink": "طلب رابط جديد",
  "auth.resetPassword.errors.missingLink":
    "رابط إعادة التعيين غير صالح أو غير مكتمل. اطلب رابطًا جديدًا.",
  "auth.resetPassword.errors.invalidOrRefused":
    "تعذّر تعيين كلمة المرور. قد يكون الرابط غير صالح أو منتهي الصلاحية، أو أن كلمة المرور لا تستوفي شروط مزود الهوية.",
  "auth.resetPassword.errors.unavailable": "الخدمة غير متاحة مؤقتًا الآن. حاول مرة أخرى بعد قليل.",
  "auth.resetPassword.errors.failed": "تعذّر تحديث كلمة المرور الآن. حاول مرة أخرى بعد قليل.",

  // RT-971: the shared parts of the public screens (canvas «تسجيل الدخول»).
  "auth.password.show": "إظهار كلمة المرور",
  // The line under the form (owner-approved board B, 2026-11-08). Owner wording;
  // note UX-12 says a store is «المتجر», and this line says «الفروع».
  "auth.brand.tagline": "كل الفروع تحت عينك",

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
