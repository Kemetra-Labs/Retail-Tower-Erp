import type { Messages } from "../types";

/**
 * Arabic copy of the product import workspace (RT-1509, spec 049 S7). Arabic is the authored language
 * (UX-12.2); the sentences are the owner-approved design (RT-1509 comment 18017), written per
 * `rtl-arabic-copy.md`: What, Safety, Action, Evidence. Verb jurisdiction (UX-12.7): «إلغاء الاستيراد»
 * cancels the workflow, «إزالة القرار» removes one decision (never «تراجع»: no undo exists), «نشر»
 * crosses the consequence boundary. Counted prose is noun first («صفوف بلا قرار: {count}», UX-12.26).
 * Machine values (file names, SKU, barcodes, batch ids) are placed by components inside `<bdi dir=ltr>`.
 */
export const catalogImport = {
  // --- Entry and page ----------------------------------------------------------
  "catalogImport.nav.link": "استيراد المنتجات",
  "catalogImport.title": "استيراد المنتجات",
  "catalogImport.crumb": "الكتالوج › استيراد المنتجات",
  "catalogImport.cancel.action": "إلغاء الاستيراد",
  "catalogImport.cancel.actionRestart": "إلغاء الاستيراد وبدء استيراد جديد",
  "catalogImport.back": "العودة إلى رفع ملف",
  "catalogImport.loading": "جارٍ تحميل الاستيراد…",
  "catalogImport.reload": "إعادة التحميل",
  "catalogImport.loadFailed.title": "تعذّر تحميل الاستيراد",
  "catalogImport.loadFailed.body": "لم يتغيّر شيء.",
  "catalogImport.closed.title": "أُغلق هذا الاستيراد",
  "catalogImport.closed.body": "نُشر أو أُلغي أو انتهت مدته. ابدأ استيرادًا جديدًا.",

  // --- Stepper -----------------------------------------------------------------
  "catalogImport.stepper.label": "خطوات الاستيراد",
  "catalogImport.stepper.announce": "الخطوة {n} من 7: {name}",
  "catalogImport.step.upload": "رفع الملف",
  "catalogImport.step.map": "ربط الأعمدة",
  "catalogImport.step.validate": "التحقق",
  "catalogImport.step.review": "المراجعة",
  "catalogImport.step.preview": "المعاينة",
  "catalogImport.step.publish": "النشر",
  "catalogImport.step.result": "النتيجة",
  "catalogImport.stepFact.done": "مكتمل",
  "catalogImport.stepFact.current": "الخطوة الحالية",
  "catalogImport.stepFact.notStarted": "لم تبدأ",
  "catalogImport.stepFact.notStartedM": "لم يبدأ",
  "catalogImport.stepFact.needsValidation": "يلزم تحقق جديد",
  "catalogImport.stepFact.rows": "الصفوف: {count}",
  "catalogImport.stepFact.columns": "الأعمدة: {count}",
  "catalogImport.stepFact.undecided": "صفوف بلا قرار: {count}",

  // --- Step 1: Upload ------------------------------------------------------------
  "catalogImport.upload.intro":
    "ارفع ملف CSV أو XLSX لإضافة المنتجات أو تحديثها دفعة واحدة. لا يتغيّر الكتالوج قبل أن تؤكد النشر.",
  "catalogImport.upload.mode.legend": "طريقة الاستيراد",
  "catalogImport.upload.mode.required": "(مطلوب)",
  "catalogImport.upload.mode.upsert": "إضافة وتحديث",
  "catalogImport.upload.mode.upsertHint": "يُنشئ ما لا يوجد ويحدّث ما يوجد.",
  "catalogImport.upload.mode.create": "إضافة فقط",
  "catalogImport.upload.mode.createHint": "يُنشئ منتجات جديدة. أي صف يطابق منتجًا موجودًا يُعدّ خطأ.",
  "catalogImport.upload.mode.update": "تحديث فقط",
  "catalogImport.upload.mode.updateHint": "يحدّث منتجات موجودة. أي صف لا يطابق منتجًا يُعدّ خطأ.",
  "catalogImport.upload.file.legend": "الملف",
  "catalogImport.upload.file.choose": "اختر ملفًا",
  "catalogImport.upload.file.chooseAnother": "اختيار ملف آخر",
  "catalogImport.upload.file.none": "لم يُختر ملف",
  "catalogImport.upload.file.size": "{size} KB",
  "catalogImport.upload.file.requirements":
    "CSV (UTF-8) أو XLSX · حتى 5 ميغابايت · حتى 5,000 صف و50 عمودًا · تُقرأ الورقة الأولى فقط.",
  "catalogImport.upload.template.link": "تنزيل القالب",
  "catalogImport.upload.template.ar": "عناوين عربية",
  "catalogImport.upload.template.en": "عناوين إنجليزية",
  "catalogImport.upload.template.failed": "تعذّر تنزيل القالب. حاول مرة أخرى.",
  "catalogImport.upload.advanced": "خيارات متقدمة",
  "catalogImport.upload.sheet.label": "اسم الورقة (اختياري)",
  "catalogImport.upload.sheet.placeholder": "الورقة الأولى",
  "catalogImport.upload.sheet.hint":
    "اتركه فارغًا لقراءة الورقة الأولى. الاسم يجب أن يطابق الملف حرفيًا.",
  "catalogImport.upload.delimiter.label": "الفاصل (CSV فقط)",
  "catalogImport.upload.delimiter.auto": "كشف تلقائي",
  "catalogImport.upload.delimiter.comma": "فاصلة",
  "catalogImport.upload.delimiter.semicolon": "فاصلة منقوطة",
  "catalogImport.upload.delimiter.tab": "Tab",
  "catalogImport.upload.delimiter.xlsxHint": "غير متاح لملفات XLSX.",
  "catalogImport.upload.submit": "رفع الملف",
  "catalogImport.upload.submitting": "جارٍ الرفع…",
  "catalogImport.upload.blocked.both": "اختر طريقة الاستيراد وملفًا أولًا.",
  "catalogImport.upload.blocked.mode": "اختر طريقة الاستيراد.",
  "catalogImport.upload.blocked.file": "اختر ملفًا.",
  "catalogImport.upload.busy.title": "جارٍ رفع الملف وقراءته…",
  "catalogImport.upload.busy.body": "قد يستغرق ذلك بضع ثوانٍ. لا تغلق الصفحة.",
  "catalogImport.upload.unclear.title": "لم يصل رد الخادم",
  "catalogImport.upload.unclear.body":
    "لا نعرف إن كان الملف قد وصل. أعد الإرسال بالملف نفسه؛ لن تُنشأ دفعة مكررة.",
  "catalogImport.upload.unclear.resend": "إعادة الإرسال",
  "catalogImport.upload.unchanged": "لم يُنشأ أي استيراد.",

  // --- Open batch (409 import_batch_open) ------------------------------------------
  "catalogImport.open.title": "لديك استيراد مفتوح",
  "catalogImport.open.body": "لا يمكن رفع ملف جديد قبل إنهاء الاستيراد المفتوح أو إلغائه.",
  "catalogImport.open.file": "الملف",
  "catalogImport.open.state": "الحالة",
  "catalogImport.open.updated": "آخر تعديل",
  "catalogImport.open.expires": "ينتهي",
  "catalogImport.open.resume": "متابعة الاستيراد",
  "catalogImport.open.loadFailed": "تعذّر تحميل تفاصيل الاستيراد المفتوح.",
  "catalogImport.state.draft": "مسودة",
  "catalogImport.state.validated": "تم التحقق",
  "catalogImport.state.published": "منشور",
  "catalogImport.state.cancelled": "ملغى",
  "catalogImport.state.expired": "منتهي",

  // --- Cancel dialog --------------------------------------------------------------
  "catalogImport.cancelDialog.title": "إلغاء الاستيراد المفتوح؟",
  "catalogImport.cancelDialog.body": "يُحذف الربط والقرارات المسجلة، ولا يتغيّر الكتالوج.",
  "catalogImport.cancelDialog.keep": "إبقاء الاستيراد",
  "catalogImport.cancelDialog.confirm": "إلغاء الاستيراد",
  "catalogImport.cancelDialog.busy": "جارٍ الإلغاء…",

  // --- Step 2: Map -------------------------------------------------------------------
  "catalogImport.map.intro":
    "الاقتراح مبني على عناوين الأعمدة وعلى التخصيص المحفوظ. راجعه ثم أكّده.",
  "catalogImport.map.sheetRead": "الورقة المقروءة (XLSX): {sheet}",
  "catalogImport.map.delimiterRead": "الفاصل المكتشف (CSV): {delimiter}",
  "catalogImport.map.caption": "الأعمدة ({count})",
  "catalogImport.map.col.file": "عمود الملف",
  "catalogImport.map.col.samples": "أمثلة من الصفوف الأولى",
  "catalogImport.map.col.target": "يُربط بـ",
  "catalogImport.map.col.note": "ملاحظة",
  "catalogImport.map.header.empty": "(بلا عنوان)",
  "catalogImport.map.select": "ربط عمود {header}",
  "catalogImport.map.note.suggested": "اقتراح",
  "catalogImport.map.note.ignored": "سيتم تجاهله",
  "catalogImport.map.note.notImported": "غير مستورد",
  "catalogImport.map.note.confirmed": "مؤكّد",
  "catalogImport.map.previouslyPublished.title": "نُشر ملف مطابق من قبل",
  "catalogImport.map.previouslyPublished.body":
    "نُشر ملف بالمحتوى نفسه في استيراد سابق بتاريخ {date}. يمكنك المتابعة.",
  "catalogImport.map.ignored.title": "أعمدة سيتم تجاهلها: {count}",
  "catalogImport.map.ignored.body": "{names}. راجعها قبل المتابعة؛ لن يُستورد منها شيء.",
  "catalogImport.map.priceNotice":
    "لن يُكتب السعر. تُنشأ المنتجات الجديدة بلا سعر ولا تظهر على الكاشير حتى تُسعَّر.",
  "catalogImport.map.save.label": "احفظ هذا الربط لاستخدامه مرة أخرى",
  "catalogImport.map.save.name": "اسم التخصيص",
  "catalogImport.map.submit": "تحقق",
  "catalogImport.map.submitting": "جارٍ حفظ الربط…",
  "catalogImport.map.duplicate":
    "الحقل «{field}» مربوط بأكثر من عمود. اختر عمودًا واحدًا (الباركود وحده يقبل حتى 5 أعمدة).",
  "catalogImport.map.requiredMissing":
    "يجب ربط «الاسم» و«فئة الضريبة» في وضعي «إضافة فقط» و«إضافة وتحديث».",
  "catalogImport.map.blocked": "راجع الأعمدة المعلَّمة قبل التحقق.",
  "catalogImport.map.refused.title": "الربط غير مكتمل أو متعارض",
  "catalogImport.map.replace.title": "استبدال الملف",
  "catalogImport.map.replace.action": "استبدال الملف",
  "catalogImport.map.replace.busy": "جارٍ استبدال الملف…",
  "catalogImport.map.replace.hint":
    "ارفع ملفك بعد إصلاحه، لا تقرير الأخطاء. يُحذف الربط وقرارات المراجعة.",
  "catalogImport.map.replaced.title": "استُبدل الملف وأُعيد الربط",
  "catalogImport.map.replaced.body":
    "اقترحنا الأعمدة التي بقيت بعناوينها. أكّد الربط من جديد قبل التحقق. حُذفت قرارات المراجعة السابقة.",

  // --- Field labels (mapping targets and issues) --------------------------------
  "catalogImport.field.sku": "رمز SKU",
  "catalogImport.field.barcode": "الباركود",
  "catalogImport.field.plu": "رمز PLU",
  "catalogImport.field.name": "الاسم",
  "catalogImport.field.description": "الوصف",
  "catalogImport.field.category": "الفئة",
  "catalogImport.field.brand": "العلامة التجارية",
  "catalogImport.field.tax_category": "فئة الضريبة",
  "catalogImport.field.is_active": "مفعّل",
  "catalogImport.field.price": "السعر",
  "catalogImport.field.currency": "العملة",
  "catalogImport.target.barcode": "الباركود (حتى 5 أعمدة)",
  "catalogImport.target.name": "الاسم (مطلوب)",
  "catalogImport.target.tax_category": "فئة الضريبة (مطلوب)",
  "catalogImport.target.price": "السعر — غير مستورد بعد",
  "catalogImport.target.currency": "العملة — غير مستورد بعد",
  "catalogImport.target.ignore": "سيتم تجاهله",

  // --- Step 3: Validate -------------------------------------------------------------
  "catalogImport.validate.rows": "الصفوف: {count}",
  "catalogImport.validate.band": "تصفية الصفوف حسب الحالة",
  "catalogImport.validate.all": "كل الصفوف",
  "catalogImport.validate.filterActive": "تصفية فعّالة: {status}",
  "catalogImport.validate.showAll": "إظهار كل الصفوف",
  "catalogImport.validate.caption": "صفوف بحالة «{status}» ({count})",
  "catalogImport.validate.captionAll": "كل الصفوف ({count})",
  "catalogImport.validate.col.row": "الصف",
  "catalogImport.validate.col.status": "الحالة",
  "catalogImport.validate.col.product": "الصنف في الملف",
  "catalogImport.validate.col.issues": "المشكلات",
  "catalogImport.validate.noIssues": "لا مشكلات.",
  "catalogImport.validate.errorReport": "تقرير الأخطاء (CSV)",
  "catalogImport.validate.errorReportHint":
    "ملف للقراءة فقط: أصلح الملف الأصلي وارفعه من جديد، لا ترفع التقرير.",
  "catalogImport.validate.errorReportFailed": "تعذّر تنزيل تقرير الأخطاء. حاول مرة أخرى.",
  "catalogImport.validate.loadMore": "تحميل المزيد",
  "catalogImport.validate.loadMoreFailed.title": "تعذّر تحميل المزيد من الصفوف",
  "catalogImport.validate.loadMoreFailed.body": "تبقى الصفوف المعروضة أعلاه كما هي.",
  "catalogImport.validate.loading": "جارٍ تحميل الصفوف…",
  "catalogImport.validate.busy.title": "جارٍ التحقق من صفوف الملف ({count})…",
  "catalogImport.validate.busy.body": "قد يستغرق ذلك حتى عشر ثوانٍ. لن يتغيّر الكتالوج.",
  "catalogImport.validate.busy.button": "جارٍ التحقق…",
  "catalogImport.validate.empty": "لا صفوف بهذه الحالة.",
  "catalogImport.validate.rowsFailed.title": "تعذّر تحميل نتيجة التحقق",
  "catalogImport.validate.rowsFailed.body": "لم يتغيّر الاستيراد.",
  "catalogImport.validate.needed.title": "يلزم التحقق",
  "catalogImport.validate.needed.body": "الربط محفوظ. تحقق من الصفوف قبل المتابعة.",
  "catalogImport.validate.again": "تحقق من جديد",
  "catalogImport.validate.stale.title": "تغيّر الكتالوج منذ آخر تحقق",
  "catalogImport.validate.stale.body":
    "لم يُنشر شيء. أُعيد الاستيراد إلى التحقق وبقي الربط كما هو. تحقق من جديد وراجع المعاينة. تُحفظ قراراتك ما دامت الصفوف كما هي.",
  "catalogImport.validate.toReview": "المتابعة إلى المراجعة",
  "catalogImport.validate.toPreview": "المتابعة إلى المعاينة",
  "catalogImport.validate.nextReason":
    "صفوف بها أخطاء: {errors} · صفوف تحتاج قرارًا: {review}. الأخطاء تُصلَح في الملف أو تُستبعد في المراجعة.",
  "catalogImport.status.ready_create": "جاهز للإضافة",
  "catalogImport.status.ready_update": "جاهز للتحديث",
  "catalogImport.status.unchanged": "بلا تغيير",
  "catalogImport.status.needs_review": "يحتاج مراجعة",
  "catalogImport.status.error": "خطأ",
  "catalogImport.status.excluded": "مستبعد",
  "catalogImport.severity.error": "خطأ",
  "catalogImport.severity.review": "يحتاج قرارًا",
  "catalogImport.severity.warning": "تنبيه",
  "catalogImport.severity.notice": "ملاحظة",

  // --- Step 4: Review ----------------------------------------------------------------
  "catalogImport.review.title": "مراجعة الصفوف · صفوف بلا قرار: {count}",
  "catalogImport.review.breakdown": "تحتاج مراجعة: {review} · بها أخطاء: {errors}",
  "catalogImport.review.caption": "صفوف تحتاج قرارًا",
  "catalogImport.review.col.row": "الصف",
  "catalogImport.review.col.reason": "السبب",
  "catalogImport.review.col.decision": "القرار",
  "catalogImport.review.col.action": "إجراء",
  "catalogImport.review.open": "فتح التفاصيل",
  "catalogImport.review.openRow": "فتح تفاصيل الصف {row}",
  "catalogImport.review.apply": "تطبيق القرار",
  "catalogImport.review.applying": "جارٍ تسجيل القرار…",
  "catalogImport.review.remove": "إزالة القرار",
  "catalogImport.review.removing": "جارٍ إزالة القرار…",
  "catalogImport.review.empty": "لا صفوف تحتاج قرارًا.",
  "catalogImport.review.emptyHint": "يمكنك المتابعة إلى المعاينة.",
  "catalogImport.review.loading": "جارٍ تحميل الصفوف…",
  "catalogImport.review.drawerTitle": "الصف {row} · {reason}",
  "catalogImport.review.inFile": "في الملف: {name}",
  "catalogImport.review.decisions": "القرار",
  "catalogImport.review.createNew": "إنشاء منتج جديد",
  "catalogImport.review.updateProduct": "تحديث هذا المنتج",
  "catalogImport.review.exclude": "استبعاد الصف",
  "catalogImport.review.excludeHint": "لا يُستورد هذا الصف.",
  "catalogImport.review.createNotOffered":
    "«إنشاء منتج جديد» غير معروض: أحد معرّفات الصف مستخدم لمنتج آخر ولا يُنقل.",
  "catalogImport.review.errorHint": "الأخطاء تُصلَح في الملف الأصلي، أو يُستبعد الصف.",
  "catalogImport.review.pickOne": "اختر قرارًا.",
  "catalogImport.review.reason.ambiguous": "مطابقة غامضة",
  "catalogImport.review.reason.no_identifier": "بلا معرّف",
  "catalogImport.review.reason.sku_mismatch": "اختلاف رمز SKU",
  "catalogImport.review.reason.store_scoped_conflict": "تعارض مع معرّف متجر",
  "catalogImport.review.reason.possible_duplicate": "تكرار محتمل",
  "catalogImport.review.reason.error": "خطأ",
  "catalogImport.review.decided.none": "بلا قرار",
  "catalogImport.review.decided.create": "سيُنشأ جديدًا",
  "catalogImport.review.decided.update": "سيُحدَّث «{name}»",
  "catalogImport.review.decided.exclude": "مستبعد",
  "catalogImport.review.recorded": "سُجّل القرار للصف {row}: {outcome}",
  "catalogImport.review.cleared": "أُزيل القرار للصف {row}.",
  "catalogImport.review.notAdded": "لن يُضاف هذا المعرّف: {ids} ({reason}).",
  "catalogImport.review.notAdded.sku": "للمنتج رمز SKU آخر ولا يُضاف رمز ثانٍ",
  "catalogImport.review.notAdded.store": "مستخدم لمنتج آخر على مستوى متجر",
  "catalogImport.review.notAdded.other": "لا يُضاف",
  "catalogImport.review.undecided": "صفوف بلا قرار: {count}",
  "catalogImport.review.toPreview": "المتابعة إلى المعاينة",
  "catalogImport.review.loadMore": "تحميل المزيد",
  "catalogImport.review.loadMoreFailed":
    "تعذّر تحميل المزيد من الصفوف. تبقى الصفوف المعروضة أعلاه كما هي.",
  "catalogImport.review.rowsFailed": "تعذّر تحميل الصفوف. لم يتغيّر الاستيراد.",
  "catalogImport.review.versionConflict.title": "تغيّر هذا الاستيراد منذ فتحته",
  "catalogImport.review.versionConflict.body":
    "ربما في تبويب آخر. أُعيد تحميله؛ راجعه وحاول مرة أخرى.",
  "catalogImport.review.notAllowed.title": "هذا القرار غير متاح لهذا الصف",
  "catalogImport.review.notAllowed.body": "أُعيد تحميل خيارات الصف.",

  // --- Step 5: Preview ---------------------------------------------------------------
  "catalogImport.preview.title": "ماذا سيحدث عند النشر",
  "catalogImport.preview.loading": "جارٍ تحميل المعاينة…",
  "catalogImport.preview.failed.title": "تعذّر تحميل المعاينة",
  "catalogImport.preview.failed.body": "لم يتغيّر الكتالوج.",
  "catalogImport.preview.count.create": "منتجات ستُنشأ",
  "catalogImport.preview.count.update": "منتجات ستُحدَّث",
  "catalogImport.preview.count.identifiers": "معرّفات ستُضاف",
  "catalogImport.preview.count.brands": "علامات تجارية ستُنشأ",
  "catalogImport.preview.count.unchanged": "صفوف بلا تغيير",
  "catalogImport.preview.count.excluded": "صفوف مستبعدة",
  "catalogImport.preview.deactivations": "منتجات ستُوقف عن البيع: {count}",
  "catalogImport.preview.deactivationsBody": "لن تظهر على أي كاشير بعد النشر.",
  "catalogImport.preview.deactivationRow": "الصف {row}",
  "catalogImport.preview.unpriced": "منتجات جديدة بلا سعر: {count}",
  "catalogImport.preview.unpricedBody":
    "لن تظهر على أي كاشير حتى تُسعَّر. السعر في الملف لم يُستورد (صفوف بها سعر: {rows}).",
  "catalogImport.preview.brands": "علامات تجارية ستُنشأ",
  "catalogImport.preview.changes": "عرض التغييرات",
  "catalogImport.preview.snapshot":
    "المعاينة محسوبة {time}، وهي لقطة وليست حجزًا: قد يتغيّر الكتالوج قبل النشر، فيُعاد التحقق عندها.",
  "catalogImport.preview.publish": "نشر الاستيراد",
  "catalogImport.preview.nothing": "لن يتغيّر شيء",
  "catalogImport.preview.nothingHint": "كل الصفوف بلا تغيير أو مستبعدة.",
  "catalogImport.preview.blockedConflict": "النشر غير متاح: توجد صفوف متعارضة.",
  "catalogImport.preview.blockedUndecided": "النشر غير متاح: بقيت صفوف بلا قرار.",
  "catalogImport.preview.blockedNotPublishable":
    "النشر غير متاح: الخادم لا يقبل نشر هذا الاستيراد الآن.",
  "catalogImport.preview.changed.title": "تغيّرت المعاينة منذ عرضتها",
  "catalogImport.preview.changed.body":
    "لم يُنشر شيء. هذه هي المعاينة الجديدة؛ راجعها ثم انشر إن أردت.",
  "catalogImport.preview.notPublishable.title": "لا يمكن نشر هذا الاستيراد",
  "catalogImport.preview.notPublishable.body":
    "صفوف ما زالت بلا قرار أو بها أخطاء، أو صفوف متعارضة. لم يُنشر شيء.",
  "catalogImport.preview.conflict.title": "لا يمكن نشر هذا الاستيراد",
  "catalogImport.preview.conflict.body":
    "صفوف تغيّر المنتج نفسه بطريقتين مختلفتين. لم يُنشر شيء، ولن يقبل الخادم النشر ما دامت هذه الصفوف كما هي.",
  "catalogImport.preview.conflict.caption": "الصفوف المتعارضة · منتجات: {count}",
  "catalogImport.preview.conflict.product": "المنتج",
  "catalogImport.preview.conflict.rows": "الصفوف",
  "catalogImport.preview.conflict.reason": "السبب",
  "catalogImport.preview.conflict.field": "قيمتان مختلفتان للحقل «{field}»",
  "catalogImport.preview.conflict.secondSku": "سيصبح للمنتج رمز SKU ثانٍ",
  "catalogImport.preview.conflict.more":
    "يُعرض أول {shown} من {total} منتجًا متعارضًا. أصلح هذه الصفوف ثم ارفع الملف من جديد لترى الباقي.",
  "catalogImport.preview.conflict.fix":
    "أصلح الملف الأصلي بحيث يبقى صف واحد لكل منتج، ثم ارفعه من جديد.",
  "catalogImport.changes.title": "تغييرات الحقول",
  "catalogImport.changes.empty": "لا تغييرات حقول في صفوف التحديث.",
  "catalogImport.changes.row": "الصف {row} · {name}",
  "catalogImport.changes.before": "قبل",
  "catalogImport.changes.after": "بعد",
  "catalogImport.changes.none": "(فارغ)",
  "catalogImport.changes.field.name": "الاسم",
  "catalogImport.changes.field.description": "الوصف",
  "catalogImport.changes.field.category": "الفئة",
  "catalogImport.changes.field.brand": "العلامة التجارية",
  "catalogImport.changes.field.tax_category": "فئة الضريبة",
  "catalogImport.changes.field.is_active": "مفعّل",
  "catalogImport.changes.loadFailed": "تعذّر تحميل التغييرات. لم يتغيّر الكتالوج.",

  // --- Step 6: Publish ----------------------------------------------------------------
  "catalogImport.publish.title": "نشر الاستيراد؟",
  "catalogImport.publish.body":
    "سيُنشر الاستيراد في الكتالوج دفعة واحدة: يُطبَّق كله أو لا يُطبَّق منه شيء.",
  "catalogImport.publish.count.create": "منتجات جديدة (بلا سعر)",
  "catalogImport.publish.count.update": "منتجات ستُحدَّث",
  "catalogImport.publish.count.identifiers": "معرّفات ستُضاف",
  "catalogImport.publish.count.brands": "علامات تجارية ستُنشأ",
  "catalogImport.publish.count.deactivated": "منتجات ستُوقف عن البيع",
  "catalogImport.publish.consequence":
    "لا يوجد تراجع عن النشر من هنا. تُوقف المنتجات الموقوفة عن البيع على كل الكاشيرات.",
  "catalogImport.publish.cancel": "إلغاء",
  "catalogImport.publish.confirm": "تأكيد النشر",
  "catalogImport.publish.busy": "جارٍ النشر…",
  "catalogImport.publish.inFlight": "جارٍ النشر… انتظر تأكيد الخادم. لا تغلق الصفحة.",
  "catalogImport.publish.unclear.title": "لم يتأكد النشر",
  "catalogImport.publish.unclear.heading": "لا نعرف إن كان النشر قد تم",
  "catalogImport.publish.unclear.body":
    "لم يصل رد الخادم. قد يكون الكتالوج قد تغيّر. لا ترفع ملفًا جديدًا ولا تلغِ الاستيراد قبل أن تتأكد.",
  "catalogImport.publish.unclear.resend": "إعادة الإرسال",
  "catalogImport.publish.unclear.refresh": "تحديث الحالة",
  "catalogImport.publish.unclear.close": "إغلاق",
  "catalogImport.publish.unclear.refreshing": "جارٍ تحديث الحالة…",
  "catalogImport.publish.unclear.notPublished": "لم يُنشر الاستيراد بعد. يمكنك إعادة الإرسال.",
  "catalogImport.publish.persistent.title": "حالة النشر غير مؤكدة",
  "catalogImport.publish.persistent.body":
    "لا نعرف إن كان الاستيراد قد نُشر. تأكد قبل أي إجراء آخر.",
  "catalogImport.publish.persistent.reason": "غير متاحين حتى تتأكد الحالة.",
  "catalogImport.publish.wait": {
    zero: "ما زال الخادم يعالج الطلب السابق. انتظر {count} ثانية ثم أعد الإرسال.",
    one: "ما زال الخادم يعالج الطلب السابق. انتظر ثانية واحدة ثم أعد الإرسال.",
    two: "ما زال الخادم يعالج الطلب السابق. انتظر ثانيتين ثم أعد الإرسال.",
    few: "ما زال الخادم يعالج الطلب السابق. انتظر {count} ثوانٍ ثم أعد الإرسال.",
    many: "ما زال الخادم يعالج الطلب السابق. انتظر {count} ثانية ثم أعد الإرسال.",
    other: "ما زال الخادم يعالج الطلب السابق. انتظر {count} ثانية ثم أعد الإرسال.",
  },

  // --- Step 7: Result -------------------------------------------------------------------
  "catalogImport.result.title": "تم نشر الاستيراد",
  "catalogImport.result.confirmed": "أكّد الخادم النشر في {time}.",
  "catalogImport.result.replay.title": "نُشر هذا الاستيراد من قبل",
  "catalogImport.result.replay.body": "هذه هي نتيجته المحفوظة؛ لم يُنشر شيء جديد.",
  "catalogImport.result.count.created": "منتجات أُنشئت",
  "catalogImport.result.count.updated": "منتجات حُدّثت",
  "catalogImport.result.count.identifiers": "معرّفات أُضيفت",
  "catalogImport.result.count.brands": "علامات تجارية أُنشئت",
  "catalogImport.result.count.deactivated": "منتجات أُوقفت عن البيع",
  "catalogImport.result.count.unchanged": "صفوف بلا تغيير",
  "catalogImport.result.count.excluded": "صفوف مستبعدة",
  "catalogImport.result.unpriced": "منتجات جديدة بلا سعر: {count}",
  "catalogImport.result.unpricedBody": "لن تظهر على الكاشير حتى تُسعَّر.",
  "catalogImport.result.audit": "مرجع التدقيق (معرّف الدفعة)",
  "catalogImport.result.copy": "نسخ المرجع",
  "catalogImport.result.copied": "تم نسخ المرجع",
  "catalogImport.result.copyFailed": "تعذّر النسخ. حدّد المرجع وانسخه يدويًا.",
  "catalogImport.result.viewProducts": "عرض المنتجات",
  "catalogImport.result.another": "استيراد ملف آخر",
  "catalogImport.result.loadFailed.title": "تعذّر تحميل نتيجة الاستيراد",
  "catalogImport.result.loadFailed.body": "النشر نفسه لم يتأثر.",

  // --- Errors by machine code (never the wire text) -------------------------------------
  "catalogImport.error.session": "انتهت جلستك. سجّل الدخول مرة أخرى.",
  "catalogImport.error.notAvailable": "لم يعد هذا الاستيراد متاحًا لك.",
  "catalogImport.error.generic": "تعذّر إكمال الطلب. حاول مرة أخرى.",
  "catalogImport.error.unknown": "حدث خطأ غير متوقع. لم نتأكد من حالة الطلب.",
  "catalogImport.error.origin_rejected":
    "تعذّر تنفيذ الطلب من هذه الصفحة. أعد تحميل الصفحة ثم حاول مرة أخرى. لم يتغيّر شيء.",
  "catalogImport.error.validation_error": "تعذّر قبول الطلب. أعد تحميل الصفحة. لم يتغيّر شيء.",
  "catalogImport.error.file_too_large":
    "الملف أكبر من 5 ميغابايت. قسّمه إلى ملفات أصغر وارفعها واحدًا بعد الآخر.",
  "catalogImport.error.file_type_unsupported":
    "هذا النوع من الملفات غير مدعوم. احفظه بصيغة XLSX أو CSV (UTF-8) ثم ارفعه.",
  "catalogImport.error.encoding_not_utf8":
    "ترميز الملف ليس UTF-8. احفظه كـ «CSV UTF-8» أو ارفعه بصيغة XLSX.",
  "catalogImport.error.file_unreadable":
    "تعذّرت قراءة الملف وقد يكون تالفًا. احفظه من جديد في برنامج الجداول ثم ارفعه.",
  "catalogImport.error.xlsx_limits_exceeded":
    "حجم الجدول يتجاوز الحدود المسموحة. احذف الصفوف والأعمدة الفارغة ثم ارفعه.",
  "catalogImport.error.sheet_not_found":
    "لا توجد ورقة بهذا الاسم في الملف. اترك الحقل فارغًا لقراءة الورقة الأولى.",
  "catalogImport.error.header_missing": "لا يوجد صف عناوين. ضع عناوين الأعمدة في الصف الأول.",
  "catalogImport.error.no_data_rows": "لا توجد صفوف بيانات بعد صف العناوين.",
  "catalogImport.error.too_many_rows": "عدد الصفوف يتجاوز 5,000. قسّم الملف إلى أكثر من ملف.",
  "catalogImport.error.file_too_many_rows":
    "الملف يحتوي صفوفًا أكثر من الحد الأقصى للجداول. احذف الصفوف الفارغة ثم ارفعه.",
  "catalogImport.error.too_many_columns":
    "عدد الأعمدة يتجاوز 50. احذف الأعمدة غير اللازمة ثم ارفعه.",
  "catalogImport.error.cell_too_long": "خلية تتجاوز 2,000 حرف. اختصرها ثم ارفع الملف.",
  "catalogImport.error.idempotency_key_conflict":
    "تعذّر تنفيذ الطلب. أعد تحميل الصفحة ثم ارفع الملف من جديد.",
  "catalogImport.error.import_batch_open": "لديك استيراد مفتوح.",
  "catalogImport.error.version_conflict":
    "تغيّر هذا الاستيراد منذ فتحته (ربما في تبويب آخر). أُعيد تحميله؛ راجعه وحاول مرة أخرى.",
  "catalogImport.error.import_batch_closed":
    "أُغلق هذا الاستيراد: نُشر أو أُلغي أو انتهت مدته. ابدأ استيرادًا جديدًا.",
  "catalogImport.error.import_batch_not_validated":
    "لا توجد نتائج تحقق حالية لهذا الاستيراد. ارجع إلى خطوة التحقق.",
  "catalogImport.error.preview_changed":
    "تغيّرت المعاينة منذ عرضتها. لم يُنشر شيء. راجع المعاينة الجديدة.",
  "catalogImport.error.import_not_publishable":
    "لا يمكن نشر الاستيراد: صفوف ما زالت بلا قرار أو بها أخطاء، أو صفوف متعارضة. لم يُنشر شيء.",
  "catalogImport.error.stale_validation":
    "تغيّر الكتالوج منذ التحقق. لم يُنشر شيء. أُعيد الاستيراد إلى التحقق؛ تحقق من جديد وراجع المعاينة.",
  "catalogImport.error.mapping_invalid": "الربط غير مكتمل أو متعارض. راجع الأعمدة المعلَّمة.",
  "catalogImport.error.mapping_required": "لم يُؤكَّد الربط بعد. أكّد ربط الأعمدة أولًا.",
  "catalogImport.error.resolution_not_allowed":
    "هذا القرار غير متاح لهذا الصف. أُعيد تحميل خيارات الصف.",
  "catalogImport.error.idempotency_in_progress":
    "ما زال الخادم يعالج الطلب السابق. انتظر ثم أعد الإرسال.",
  "catalogImport.error.rate_limited": "طلبات كثيرة. انتظر ثم حاول مرة أخرى.",

  // --- Row issues by code (fixed per code; cell values come from the row, never from here) ----
  "catalogImport.time.browser": "{time} (بتوقيت المتصفح)",
  "catalogImport.issue.cellValue": "القيمة: {value}",
  "catalogImport.issue.unknown": "حدث خطأ غير متوقع في هذا الصف.",
  "catalogImport.issue.required_field_missing": "حقل مطلوب فارغ: {field}. أدخل قيمة في الملف.",
  "catalogImport.issue.value_invalid": "{field}: قيمة غير صالحة. صحّحها في الملف.",
  "catalogImport.issue.identifier_numeric_cell":
    "{field}: الخلية رقمية في الملف فتفقد الأصفار والأرقام الطويلة. نسّق العمود كنص ثم أعد الرفع.",
  "catalogImport.issue.identifier_formula_cell":
    "{field}: الخلية ناتجة عن معادلة. استبدلها بنص ثابت.",
  "catalogImport.issue.identifier_non_ascii_digits":
    "{field}: يحتوي أرقامًا عربية-هندية. اكتب الأرقام بالأرقام اللاتينية 0-9 كما يقرؤها الماسح.",
  "catalogImport.issue.identifier_invisible_char":
    "{field}: يحتوي محرفًا مخفيًا (مسافة غير قابلة للكسر أو محرف اتجاه). احذفه وأعد كتابة القيمة.",
  "catalogImport.issue.formula_without_value":
    "{field}: معادلة بلا قيمة محسوبة محفوظة. افتح الملف واحفظه ثم ارفعه.",
  "catalogImport.issue.duplicate_in_file": "المعرّف مكرر في الصف {row}. اترك صفًا واحدًا لكل معرّف.",
  "catalogImport.issue.category_not_found":
    "الفئة غير موجودة بين فئات المؤسسة. اكتب اسمها كما هو تمامًا؛ لا يمكن إنشاء فئات من الاستيراد.",
  "catalogImport.issue.product_retired":
    "يطابق منتجًا مسحوبًا من الكتالوج ({name}). لا يعيد الاستيراد تفعيل المنتجات.",
  "catalogImport.issue.already_exists":
    "يوجد منتج بهذا المعرّف ({name}). استخدم «تحديث فقط» أو «إضافة وتحديث».",
  "catalogImport.issue.not_found":
    "لا يوجد منتج بهذا المعرّف. استخدم «إضافة فقط» أو «إضافة وتحديث».",
  "catalogImport.issue.ambiguous":
    "معرّفات الصف تخصّ أكثر من منتج. اختر المنتج المقصود أو استبعد الصف.",
  "catalogImport.issue.no_identifier":
    "الصف بلا معرّف، فلن يمكن مسحه ولا مطابقته لاحقًا. أنشئه كما هو أو استبعده.",
  "catalogImport.issue.sku_mismatch":
    "يطابق المنتج «{name}» لكن رمز SKU في الصف يختلف عن رمزه الحالي. لن يُضاف رمز ثانٍ.",
  "catalogImport.issue.store_scoped_conflict":
    "معرّف الصف مستخدم لمنتج آخر على مستوى متجر. لن يُضاف هذا المعرّف.",
  "catalogImport.issue.possible_duplicate":
    "الاسم يطابق منتجًا موجودًا ({name}) دون تطابق معرّف. قرّر: منتج جديد أم تحديث الموجود.",
  "catalogImport.issue.gtin_check_digit": "رقم التحقق في الباركود غير صحيح. قد يكون به خطأ طباعة.",
  "catalogImport.issue.tax_category_unused":
    "فئة الضريبة لم تُستخدم من قبل في مؤسستك. تأكد أنها مكتوبة صحيحة.",
  "catalogImport.issue.store_scoped_same_product": "المعرّف مسجّل أيضًا لهذا المنتج على مستوى متجر.",
  "catalogImport.issue.deactivates_product": "سيُوقف هذا الصف المنتج عن البيع على كل الكاشيرات.",
  "catalogImport.issue.price_not_imported": "السعر في هذا الصف لا يُستورد بعد.",
  "catalogImport.issue.whitespace_trimmed": "حُذفت مسافات زائدة من الخلية.",
  "catalogImport.issue.formula_cached_value": "استُخدمت القيمة المحسوبة المحفوظة لمعادلة.",
  "catalogImport.issue.brand_created": "ستُنشأ علامة تجارية جديدة: «{name}».",
} satisfies Messages;
