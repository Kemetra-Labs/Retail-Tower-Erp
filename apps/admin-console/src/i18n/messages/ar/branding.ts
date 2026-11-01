/**
 * RT-474 — هوية المؤسسة: رفع شعار المؤسسة واستبداله وإزالته مع معاينة الشاشة والإيصال.
 * النصوص من الموجز المعتمد من المالك في 2026-10-29 (docs/design/rt474-tenant-logo §5).
 * كل رمز رفض وكل تحذير من عقد الخادم المغلق له مفتاح رسالة هنا؛ رسالة الخادم لا تظهر أبدًا.
 */
export const branding = {
  // --- Page and entry ---------------------------------------------------------
  "branding.title": "هوية المؤسسة",
  "branding.back": "العودة إلى صفحة المؤسسة",
  "branding.loadingNoun": "شعار المؤسسة",
  "branding.loadFailed": "تعذّر تحميل شعار المؤسسة.",
  "branding.sessionExpired": "انتهت جلستك. سجّل الدخول مرة أخرى.",
  "branding.retry": "إعادة المحاولة",

  // --- Current logo (section 1) -----------------------------------------------
  "branding.current.title": "الشعار الحالي",
  "branding.current.empty": "لا يوجد شعار للمؤسسة. تعرض أجهزة الكاشير اسم المؤسسة نصًا في مكانه.",
  "branding.current.updatedAt": "آخر تحديث",
  "branding.current.alt": "الشعار الحالي للمؤسسة",
  "branding.replace": "استبدال الشعار",
  "branding.remove": "إزالة الشعار",
  "branding.remove.confirm":
    "إزالة شعار المؤسسة؟ ستعرض أجهزة الكاشير والإيصالات اسم المؤسسة نصًا بدل الشعار.",

  // --- Upload field (section 2) -----------------------------------------------
  "branding.upload.titleEmpty": "رفع شعار",
  "branding.upload.titleNew": "شعار جديد",
  "branding.upload.label": "ملف الشعار",
  "branding.upload.choose": "رفع شعار",
  "branding.upload.chooseAnother": "اختيار ملف آخر",
  "branding.upload.requirements":
    "PNG أو SVG، حتى 1 ميجابايت. 512×512 بكسل على الأقل للشعار المربع، أو ارتفاع 256 بكسل للشعار العرضي.",
  "branding.upload.fileSize": "{size} KB",

  // --- Refusals (brief §5.1) --------------------------------------------------
  "branding.refusal.file_type_not_allowed": "نوع الملف غير مدعوم. ارفع صورة PNG أو SVG.",
  "branding.refusal.image_malformed":
    "تعذّرت قراءة الصورة، وقد يكون الملف تالفًا. احفظ الشعار من جديد في برنامج التصميم ثم ارفعه.",
  "branding.refusal.image_dimensions_too_large":
    "أبعاد الصورة كبيرة جدًا. الحد الأقصى 4000 بكسل لكل ضلع.",
  "branding.refusal.image_too_small":
    "الصورة صغيرة. المطلوب 512×512 بكسل على الأقل للشعار المربع، أو ارتفاع 256 بكسل للشعار العرضي.",
  "branding.refusal.aspect_ratio_out_of_range":
    "شكل الشعار غير مناسب. يجب أن تكون نسبة العرض إلى الارتفاع بين 1:1 و4:1.",
  "branding.refusal.image_empty": "الصورة لا تحتوي على شعار ظاهر.",
  "branding.refusal.svg_unsafe_content":
    "يحتوي ملف SVG على عناصر غير مسموح بها لأسباب أمنية. صدّر الشعار بصيغة PNG وارفعه.",
  "branding.refusal.svg_unsupported": "تعذّرت معالجة ملف SVG هذا. صدّر الشعار بصيغة PNG وارفعه.",
  "branding.refusal.file_too_large": "حجم الملف أكبر من 1 ميجابايت.",
  "branding.refusal.logo_preview_mismatch":
    "الملف لا يطابق المعاينة المعروضة. اختر الملف مرة أخرى لعرض معاينة جديدة، ثم احفظ.",
  // A 422 code outside the closed set (a newer server): never the server's text.
  "branding.refusal.unknown": "تعذّر قبول هذا الملف شعارًا.",
  "branding.refusal.unchanged": "لم يتغيّر الشعار الحالي.",

  // --- Warnings (brief §5.2), never blocking ---------------------------------
  "branding.warning.low_contrast":
    "الشعار فاتح على الخلفية البيضاء، لذلك سيظهر داخل بطاقة بيضاء بإطار على أجهزة الكاشير. يمكنك حفظه كما هو.",
  "branding.warning.receipt_high_black_coverage":
    "مساحة السواد كبيرة في نسخة الإيصال، فقد يظهر الشعار كتلة داكنة وتصبح الطباعة أبطأ. شعار بخلفية فاتحة يعطي نتيجة أوضح.",
  "branding.warning.receipt_thin_strokes":
    "بعض خطوط الشعار رفيعة جدًا وقد تختفي في الطباعة الحرارية. شعار بخطوط أعرض يعطي نتيجة أوضح.",

  // --- Previews (sections 3 and 4) ------------------------------------------
  "branding.screen.title": "كما سيظهر على أجهزة الكاشير",
  "branding.slot.boot": "شاشة التشغيل",
  "branding.slot.pairing": "شاشة ربط الجهاز",
  "branding.slot.sign_in": "شريط تسجيل الدخول",
  "branding.slot.lock": "شاشة القفل",
  "branding.poweredBy": "بدعم من {name}",
  "branding.receipt.title": "كما سيُطبع على الإيصال",
  "branding.receipt.alt": "نسخة الإيصال من الشعار",
  "branding.receipt.size": "المقاس المطبوع: {width} × {height} مم",
  "branding.receipt.approx": "مقاس تقريبي على الشاشة",
  "branding.preview.loading": "جارٍ عرض المعاينة",
  "branding.preview.retry": "إعادة عرض المعاينة",

  // --- Actions and outcomes ---------------------------------------------------
  "branding.save": "حفظ الشعار",
  "branding.saved": "تم حفظ الشعار. ستعرضه أجهزة الكاشير بعد تحديث بياناتها.",
  "branding.removed": "تمت إزالة الشعار. ستعرض أجهزة الكاشير اسم المؤسسة نصًا بعد تحديث بياناتها.",
  "branding.conflict":
    "تغيّر شعار المؤسسة بعد فتحك لهذه الصفحة. حدّث الصفحة لترى الشعار الحالي، ثم أعد المحاولة.",
  "branding.conflict.reload": "تحديث الصفحة",
};
