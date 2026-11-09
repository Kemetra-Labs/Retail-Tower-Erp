import type { Messages } from "../types";

/**
 * Arabic copy for the pilot Download POS page (RT-1304, spec RT-1302 §6, §8, §9).
 * Machine data (version, file name, SHA-256, publisher, the PowerShell command) is not
 * in the catalog: it is isolated LTR in the page. Nothing here says a device is trusted,
 * a download started, or that the installer is a production release.
 */
export const downloadPos = {
  "devices.download.title": "تنزيل نقطة البيع",
  "devices.download.badge": "تجريبي",
  "devices.download.sub": "مثبّت تجريبي لنقطة البيع، متاح للمؤسسات المشاركة في التجربة فقط.",
  "devices.download.multiTenant":
    "إن كنت تعمل مع أكثر من مؤسسة، اختر المؤسسة المشاركة في التجربة أولًا.",

  "devices.download.panel.download": "التنزيل",
  "devices.download.field.product": "المنتج",
  "devices.download.field.platform": "النظام",
  "devices.download.field.version": "الإصدار",
  "devices.download.field.fileName": "اسم الملف",
  "devices.download.field.size": "الحجم",
  "devices.download.field.sha256": "SHA-256",
  "devices.download.field.publisher": "الناشر المتوقع",
  "devices.download.action": "تنزيل نقطة البيع",
  "devices.download.actionHelp": "ينشئ كل ضغط رابطًا جديدًا صالحًا لدقائق.",
  "devices.download.busy": "جارٍ تجهيز الرابط…",
  "devices.download.copy": "نسخ SHA-256",
  "devices.download.copied": "تم النسخ",
  "devices.download.copyManual": "حُدّدت القيمة. انسخها يدويًا.",

  "devices.download.issued":
    "تم تجهيز رابط التنزيل. يبدأ التنزيل عادةً في متصفحك خلال لحظات. إن لم يبدأ أو انتهت صلاحية الرابط، اضغط «تنزيل نقطة البيع» مرة أخرى للحصول على رابط جديد.",
  "devices.download.unavailable":
    "لا يتوفر تنزيل لنقطة البيع لمؤسستك الآن. إن كانت مؤسستك مشاركة في التجربة، تواصل مع دعم Kemetra.",
  "devices.download.notAllowed": "تنزيل نقطة البيع غير متاح لك.",
  "devices.download.failed":
    "تعذّر تجهيز رابط التنزيل. لم يُنشأ أي رابط. حاول مرة أخرى. إن تكرر الخطأ، أرسل رقم الطلب إلى الدعم.",
  "devices.download.notStarted":
    "تعذّر بدء التنزيل. اضغط «تنزيل نقطة البيع» مرة أخرى للحصول على رابط جديد. إن تكرر ذلك، تواصل مع الدعم.",
  "devices.download.network": "تعذّر الوصول إلى الخادم. تحقّق من اتصالك ثم حاول مرة أخرى.",
  "devices.download.retry": "طلب رابط جديد",

  "devices.download.panel.before": "قبل التثبيت",
  "devices.download.before.signed":
    "هذا المثبّت موقّع بشهادة تجريبية خاصة، وليست شهادة موثوقة للعموم.",
  "devices.download.before.trust":
    "لا يثق Windows به إلا على جهاز اعتُمدت الشهادة عليه. اعتماد الجهاز خطوة منفصلة يوافق عليها فريق Kemetra، والتنزيل لا يمنحها.",
  "devices.download.before.warning": "قد يعرض Windows تحذيرًا. لا يحدّث هذا الإصدار نفسه تلقائيًا.",

  "devices.download.panel.verify": "تحقّق من الملف",
  "devices.download.verify.step":
    "بعد انتهاء التنزيل، افتح PowerShell في مجلد التنزيل ونفّذ الأمر التالي، ثم قارن الناتج بقيمة SHA-256 المعروضة أعلاه.",
  "devices.download.verify.mismatch": "إن اختلف، لا تشغّل الملف. احذفه وتواصل مع الدعم.",

  "devices.download.panel.install": "التثبيت والربط",
  "devices.download.install.step":
    "ثبّت المثبّت على جهاز اعتُمدت الشهادة عليه فقط، وفق دليل تجهيز الأجهزة، ثم اربط الجهاز من {pairing}.",
  "devices.download.support": "للمساعدة في التنزيل أو التثبيت، تواصل مع دعم Kemetra.",
} satisfies Messages;
