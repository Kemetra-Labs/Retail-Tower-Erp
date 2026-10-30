import type { Messages } from "../types";

/** Shell chrome and shared components (topbar, nav, scope, dialogs, banners). */
export const shell = {
  "shell.nav.label": "التنقل الرئيسي",
  // RT-969: the sidebar landmark (brand, scope switcher, navigation).
  "shell.sidebar.label": "النطاق والتنقل",
  "shell.nav.overview": "نظرة عامة",
  "shell.nav.section.management": "الإدارة",
  "shell.nav.tenants": "المؤسسات",
  "shell.nav.stores": "المتاجر",
  "shell.nav.operators": "المستخدمون",
  "shell.nav.audit": "سجل التدقيق",
  "shell.nav.stockDiscrepancies": "فروقات المخزون",
  "shell.nav.shiftCloses": "إقفالات الورديات",
  "shell.nav.unknownItems": "أصناف غير معروفة",
  "shell.signOut": "تسجيل الخروج",
  // RT-825: the compact-shell menu button and the navigation drawer it opens.
  "shell.menu": "القائمة",

  "shell.overview.title": "نظرة عامة",
  "shell.overview.scope": "{tenant} · {store}",

  "shell.scope.menuGroup": "المتجر · {tenant}",
  "shell.scope.allStores": "كل المتاجر",
  "shell.scope.loading": "جارٍ تحميل المتاجر…",
  "shell.scope.loadFailed": "تعذّر تحميل المتاجر.",
  "shell.scope.noStores": "لا توجد متاجر يمكنك فتحها في هذه المؤسسة.",
  "shell.scope.announce": "تعمل الآن في {tenant}، {store}.",
  // RT-969: read between the store and its tenant in the switcher's name.
  "shell.scope.in": " في ",

  // RT-969: the Ctrl K navigator (pages and the stores in scope, client-side).
  "shell.navigator.open": "انتقل إلى صفحة أو متجر",
  "shell.navigator.title": "انتقل إلى",
  "shell.navigator.input": "اسم الصفحة أو المتجر",
  "shell.navigator.pages": "الصفحات",
  "shell.navigator.stores": "المتاجر",
  "shell.navigator.current": "(الحالي)",
  "shell.navigator.empty": "لا توجد صفحة أو متجر يطابق «{query}».",
  // RT-969: the user menu holds the language and theme switches.
  "shell.userMenu.prefs": "التفضيلات",

  "shell.gate.title": "اختر نطاق العمل",
  "shell.gate.sub": "اختر مؤسسة للمتابعة.",
  "shell.gate.searchPlaceholder": "ابحث في المؤسسات…",
  "shell.gate.searchLabel": "ابحث في المؤسسات",
  "shell.gate.listLabel": "المؤسسات المتاحة",

  "shell.mismatch.label": "النطاق",
  "shell.mismatch.message": "هذا الرابط لمتجر آخر. أنت تعمل في {store}، ولم يتغيّر نطاقك.",
  "shell.mismatch.switch": "الانتقال إلى هذا المتجر",
  "shell.mismatch.stay": "البقاء في {store}",

  "shell.leave.title": "المغادرة دون حفظ؟",
  "shell.leave.desc": "في هذه الصفحة تغييرات غير محفوظة. إذا غادرت فستفقدها.",
  "shell.leave.stay": "البقاء في هذه الصفحة",
  "shell.leave.discard": "تجاهل التغييرات",

  "components.banner.requestRef": "المرجع: {id}",
  "components.list.loading": "جارٍ تحميل {label}…",
  "components.list.loadingDefault": "العناصر",
  "components.confirmDelete.label": "تأكيد: {action}",
  "components.confirmDelete.prompt": "{action} {name}؟ يمكن لمسؤول التراجع عن ذلك لاحقًا.",
  "components.errorSummary.title": {
    zero: "لا توجد أخطاء",
    one: "خطأ واحد يحتاج إلى إصلاح",
    two: "خطآن يحتاجان إلى إصلاح",
    few: "{count} أخطاء تحتاج إلى إصلاح",
    many: "{count} خطأً يحتاج إلى إصلاح",
    other: "{count} خطأ يحتاج إلى إصلاح",
  },

  "platform.label": "المنصة",
  "platform.nav.label": "المنصة",
  "platform.nav.tenants": "المؤسسات",
  "platform.tenants.emptyTitle": "لا توجد مؤسسات",
  "platform.tenants.emptyBody": "لا توجد مؤسسات على المنصة لعرضها حاليًا.",
  "platform.noAccess.title": "غير متاح",
  "platform.noAccess.body": "هذه الصفحة غير متاحة لحسابك.",
  "platform.noAccess.home": "العودة إلى الرئيسية",
} satisfies Messages;
