import type { Messages } from "../types";

/**
 * Arabic copy for the catalog product list (RT-765, CAT-C1a). Read-only.
 *
 * Glossary (UX-12): Retail Item → «الصنف»; Category → «الفئة»; Tracking →
 * «التتبع». «موقوف» stays the suspended-tenant word (D-AUD-08), so a retired
 * item reads «أُخرج من الكتالوج», as a retired device reads «أُخرج من
 * الخدمة». The list never claims a total: the contract has none, so the count
 * is what is loaded.
 */
export const catalog = {
  // --- Navigation ------------------------------------------------------------
  "catalog.nav.label": "الأصناف",

  // --- List ------------------------------------------------------------------
  "catalog.list.title": "الأصناف",
  "catalog.list.sub": "الأصناف المسجَّلة في {tenant}. للقراءة فقط.",
  "catalog.list.storeNote": "تُعرض قيم المتجر {store} كما يحسبها الخادم.",
  "catalog.list.scopePrompt": "اختر مؤسسة لعرض الأصناف.",
  "catalog.list.caption": "الأصناف، مرتَّبة بالاسم أبجديًا",
  "catalog.list.captionSearch": "الأصناف، المطابقات الدقيقة للرمز أولًا ثم بالاسم أبجديًا",
  "catalog.list.loadingNoun": "الأصناف",
  "catalog.list.empty": "لا توجد أصناف نشطة بعد.",
  "catalog.list.emptyHint": "تظهر الأصناف هنا بعد وصولها إلى الكتالوج.",
  "catalog.list.emptyFiltered": "لا توجد أصناف تطابق {filters}.",
  "catalog.list.emptyFilteredHint": "غيّر عوامل التصفية أو امسحها.",
  "catalog.list.clearFilters": "مسح عوامل التصفية",
  "catalog.list.partialPage":
    "لا توجد أصناف مطابقة في الجزء الذي فُحص حتى الآن. اختر «تحميل المزيد» لمتابعة البحث.",
  "catalog.list.ended": "انتهت قائمة الأصناف.",
  "catalog.list.unavailable": "هذه الأصناف غير متاحة لك.",
  "catalog.list.unavailableHint": "اختر مؤسسة أو متجرًا آخر.",
  "catalog.list.storeStale": "المتجر المحدَّد لم يعد متاحًا.",
  "catalog.list.storeStaleHint": "غيّر المتجر من شريط النطاق، أو اختر «كل المتاجر».",
  "catalog.list.filterRejected": "رفض الخادم هذا البحث. راجع نص البحث والفئة.",
  "catalog.list.loadFailed": "تعذّر تحميل الأصناف.",
  "catalog.list.sessionExpired": "انتهت جلستك. سجّل الدخول مرة أخرى.",
  "catalog.list.inlineError": "تعذّر تحميل بقية الصفوف. الصفوف المعروضة من آخر تحميل ناجح.",
  "catalog.list.retry": "إعادة المحاولة",
  "catalog.list.cursorRejected":
    "لم يقبل الخادم موضع الصفحة التالية. ابدأ من جديد من الصفحة الأولى.",
  "catalog.list.restart": "البدء من جديد",
  "catalog.list.loaded": "الأصناف المحمَّلة: {count}",
  "catalog.list.loadMore": "تحميل المزيد",
  "catalog.list.col.item": "الصنف",
  "catalog.list.col.status": "الحالة",
  "catalog.list.col.price": "السعر",
  "catalog.list.col.sku": "SKU",
  "catalog.list.col.barcode": "الباركود",
  "catalog.list.col.category": "الفئة",
  "catalog.list.col.availability": "الإتاحة في المتجر",
  "catalog.list.col.taxCategory": "فئة الضريبة",
  "catalog.list.col.tracking": "التتبع",
  "catalog.list.col.updatedAt": "آخر تحديث",

  // --- Values ----------------------------------------------------------------
  "catalog.value.noPrice": "بلا سعر",
  "catalog.value.noCategory": "بدون فئة",
  "catalog.status.active": "نشط",
  "catalog.status.inactive": "غير نشط",
  "catalog.status.retired": "أُخرج من الكتالوج",
  "catalog.status.any": "أي حالة",
  "catalog.status.unknownCode": "حالة غير مدعومة",
  "catalog.availability.yes": "متاح للبيع",
  "catalog.availability.no": "غير متاح",
  "catalog.availability.override": "مخصَّص للمتجر",
  "catalog.tracking.none": "بلا تتبع",
  "catalog.tracking.batch": "بالتشغيلة",
  "catalog.tracking.serial": "بالرقم المسلسل",
  "catalog.tracking.unknownCode": "تتبع غير مدعوم",

  // --- Filters ---------------------------------------------------------------
  "catalog.filter.label": "عوامل تصفية الأصناف",
  "catalog.filter.q": "الاسم أو الرمز",
  "catalog.filter.qNote":
    "يطابق الباركود أو SKU أو رمز البيع السريع كما هو بالضبط، أو جزءًا من الاسم. يُرسل النص كما كُتب.",
  "catalog.filter.status": "الحالة",
  "catalog.filter.category": "الفئة",
  "catalog.filter.categoryAll": "كل الفئات",
  "catalog.filter.categoryLoading": "جارٍ التحميل…",
  "catalog.filter.categoryStale": "فئة غير متاحة",
  "catalog.filter.categorySelected": "الفئة المحددة",
  "catalog.filter.categoriesFailed": "تعذّر تحميل الفئات.",
  "catalog.filter.apply": "بحث",
  "catalog.filter.clear": "مسح",
  "catalog.filter.qTooLong": "نص البحث لا يزيد على 100 حرف.",
  "catalog.filter.categoryInvalid": "الفئة في الرابط غير صالحة.",

  // --- Filter summary (the filtered-empty message) ---------------------------
  "catalog.summary.q": "بحث «{q}»",
  "catalog.summary.status": "الحالة: {status}",
  "catalog.summary.category": "الفئة: {category}",
  "catalog.summary.join": "، ",

  // --- Detail (RT-766, CAT-C1b) -----------------------------------------------
  "catalog.detail.back": "العودة إلى الأصناف",
  "catalog.detail.scopePrompt": "اختر مؤسسة لعرض هذا الصنف.",
  "catalog.detail.sub": "صنف في {tenant}. للقراءة فقط.",
  "catalog.detail.loadingNoun": "الصنف",
  "catalog.detail.unavailable": "هذا الصنف غير متاح لك.",
  "catalog.detail.unavailableHint": "قد لا يكون موجودًا، أو قد يكون خارج مؤسستك أو متاجرك.",
  "catalog.detail.loadFailed": "تعذّر تحميل هذا الصنف.",
  "catalog.detail.sessionExpired": "انتهت جلستك. سجّل الدخول مرة أخرى.",
  "catalog.detail.rateLimited": "طلبات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.",
  "catalog.detail.retry": "إعادة المحاولة",
  "catalog.detail.inventoryLink": "عرض الرصيد الفعلي في {store}",

  "catalog.detail.tenant.title": "قيم المؤسسة",
  "catalog.detail.field.status": "الحالة",
  "catalog.detail.field.description": "الوصف",
  "catalog.detail.field.category": "الفئة",
  "catalog.detail.field.taxCategory": "فئة الضريبة",
  "catalog.detail.field.tenantAvailability": "التوفر على مستوى المؤسسة",
  "catalog.detail.field.availability": "التوفر",
  "catalog.detail.field.tracking": "التتبع",
  "catalog.detail.field.price": "السعر",
  "catalog.detail.field.updatedAt": "آخر تحديث",
  "catalog.detail.value.noDescription": "لا يوجد وصف",
  "catalog.detail.noPriceNotice": "لا يوجد سعر: لن تبيع نقطة البيع هذا الصنف حتى يُحدَّد له سعر.",

  "catalog.detail.identifiers.title": "المعرّفات",
  "catalog.detail.identifiers.caption": "المعرّفات النشطة لهذا الصنف",
  "catalog.detail.identifiers.col.type": "النوع",
  "catalog.detail.identifiers.col.value": "القيمة",
  "catalog.detail.identifiers.col.scope": "النطاق",
  "catalog.detail.identifiers.col.source": "النظام المصدر",
  "catalog.detail.identifiers.scopeAll": "كل المتاجر",
  "catalog.detail.identifiers.empty": "لا توجد معرّفات نشطة لهذا الصنف.",
  "catalog.detail.identifierType.barcode": "الباركود",
  "catalog.detail.identifierType.sku": "SKU",
  "catalog.detail.identifierType.plu": "رمز البيع السريع",
  "catalog.detail.identifierType.supplier_code": "رمز المورّد",
  "catalog.detail.identifierType.external_pos_id": "معرّف نقطة بيع خارجية",
  "catalog.detail.identifierType.unknownCode": "نوع غير مدعوم",

  "catalog.detail.overrides.title": "تخصيصات المتاجر",
  "catalog.detail.overrides.sub":
    "قيم كل متجر الخاصة به كما هي مخزَّنة، بجانب قيمة المؤسسة. القيمة التي يبيع بها المتجر فعليًا يحسبها الخادم: اختر متجرًا من شريط النطاق ثم افتح قائمة الأصناف لرؤيتها.",
  "catalog.detail.overrides.empty": "لا يوجد متجر ضمن نطاقك له قيم خاصة بهذا الصنف.",
  "catalog.detail.overrides.noValues": "هذا التخصيص لا يحدد أي قيمة خاصة به.",
  "catalog.detail.overrides.caption": "تخصيص المتجر {store}",
  "catalog.detail.overrides.col.setting": "الإعداد",
  "catalog.detail.overrides.col.store": "قيمة المتجر",
  "catalog.detail.overrides.col.tenant": "قيمة المؤسسة",

  // --- تخصيصات المتاجر: التحديد والإزالة (RT-770, CAT-C2c) ----------------------------
  "catalog.override.change": "تغيير قيم {store}",
  "catalog.override.add": "تحديد قيم خاصة بـ{store}",
  "catalog.override.chooseStore":
    "لتحديد قيم خاصة بمتجر لهذا الصنف، اختر ذلك المتجر من شريط النطاق.",
  "catalog.override.saved": "حُفظت قيم {store}.",
  "catalog.override.removed": "يتبع {store} الآن قيم المؤسسة لهذا الصنف.",
  "catalog.override.drawer.title": "قيم {store}",
  "catalog.override.drawer.sub": "تسري هذه القيم في {store} فقط. لا يُغيَّر سعر المتجر من هنا.",
  "catalog.override.availability.legend": "التوفر في هذا المتجر",
  "catalog.override.availability.inherit": "يتبع المؤسسة",
  "catalog.override.availability.available": "متاح",
  "catalog.override.availability.unavailable": "غير متاح",
  "catalog.override.availability.tenantHint": "توفر المؤسسة: {value}.",
  "catalog.override.taxCategory": "فئة الضريبة في هذا المتجر",
  "catalog.override.taxCategoryHint":
    "اتركها فارغة ليتبع المتجر فئة ضريبة المؤسسة، {tax}. حتى 50 حرفًا، وتُحذف المسافات في طرفيها.",
  "catalog.override.taxReadOnly":
    "فئة الضريبة في هذا المتجر: {tax}. لا يغيّرها إلا مالك المؤسسة أو مسؤولها.",
  "catalog.override.priceKept": "لهذا المتجر سعر خاص به. يبقى كما هو ولا يُغيَّر من هنا.",
  "catalog.override.save": "حفظ قيم المتجر",
  "catalog.override.reloaded":
    "تم تحميل أحدث القيم. ما اخترته محفوظ في النموذج. راجعه ثم احفظ مرة أخرى.",
  "catalog.override.retire.title": "إزالة تخصيص المتجر",
  "catalog.override.retire.sub": "بعدها يتبع {store} قيم المؤسسة في التوفر وفئة الضريبة.",
  "catalog.override.retire.start": "إزالة التخصيص",
  "catalog.override.retire.confirmLabel": "تأكيد: إزالة تخصيص المتجر",
  "catalog.override.retire.prompt": "إزالة تخصيص {store}؟",
  "catalog.override.retire.confirm": "نعم، أزِل التخصيص",
  "catalog.override.error.taxCategoryTooLong":
    "يجب ألا تتجاوز فئة الضريبة 50 حرفًا. اختصرها أو اتركها فارغة.",
  "catalog.override.error.validation": "رفض الخادم هذه القيم. راجع فئة الضريبة ثم حاول مرة أخرى.",
  "catalog.override.error.taxForbidden": "لا يغيّر فئة ضريبة المتجر إلا مالك المؤسسة أو مسؤولها.",
  "catalog.override.error.forbidden": "ليست لديك صلاحية تغيير قيم هذا المتجر.",
  "catalog.override.error.notFound": "هذا الصنف أو المتجر أو تخصيصه لم يعد متاحًا لك.",
  "catalog.override.error.conflict":
    "حالة تخصيص المتجر لا تسمح بهذا التغيير. أعد التحميل ثم حاول مرة أخرى.",
  "catalog.override.error.pricePresent":
    "لهذا المتجر سعر خاص به يبقى كما هو. لا يمكن إزالة سعر المتجر من هنا، لذلك يبقى تخصيص المتجر.",
  "catalog.override.error.stale":
    "تغيّرت قيم هذا المتجر منذ فتحتها. أعد التحميل للحصول على أحدث نسخة. ما اخترته محفوظ في النموذج.",
  "catalog.override.error.staleRetire":
    "تغيّرت قيم هذا المتجر منذ فتحتها. أعد التحميل للحصول على أحدث نسخة ثم قرّر من جديد.",
  "catalog.override.error.retired": "أُخرج هذا الصنف من الكتالوج، فلم يعد تغيير قيم متاجره ممكنًا.",
  "catalog.override.error.empty":
    "لن يبقى في تخصيص المتجر أي قيمة خاصة به. ليتبع المتجر قيم المؤسسة، أزِل تخصيص المتجر بدلًا من ذلك.",
  "catalog.override.error.emptyAction": "إزالة التخصيص بدلًا من ذلك",

  // RT-767: المنتقي المشترك للأصناف (الأصناف النشطة فقط، دون سعر).
  "catalog.picker.search": "البحث في الأصناف النشطة",
  "catalog.picker.searchNote":
    "اكتب جزءًا من الاسم، أو باركودًا أو SKU أو رمز بيع سريع مطابقًا تمامًا. يُرسَل النص كما كُتب.",
  "catalog.picker.submit": "بحث",
  "catalog.picker.list": "الأصناف النشطة",
  "catalog.picker.loading": "جارٍ تحميل الأصناف",
  "catalog.picker.count": "الأصناف المعروضة: {count}",
  "catalog.picker.more": "تُعرض الأصناف الأولى فقط. حسِّن البحث لتضييق القائمة.",
  "catalog.picker.empty": "لا يوجد صنف نشط يطابق هذا البحث.",
  "catalog.picker.emptyAll": "لا توجد أصناف نشطة.",
  "catalog.picker.sku": "SKU",
  "catalog.picker.barcode": "الباركود",
  "catalog.picker.retry": "إعادة المحاولة",
  "catalog.picker.qTooLong": "يجب ألا يتجاوز نص البحث 100 حرف.",
  "catalog.picker.error.notFound": "لا يمكن البحث في الأصناف من هذا الحساب أو هذا النطاق.",
  "catalog.picker.error.session": "انتهت جلستك. سجّل الدخول مرة أخرى للبحث في الأصناف.",
  "catalog.picker.error.rejected": "رفض الخادم هذا البحث. غيّر النص ثم حاول مرة أخرى.",
  "catalog.picker.error.rateLimited":
    "طلبات كثيرة جدًا في وقت قصير. انتظر انتهاء العدّ التنازلي ثم حاول مرة أخرى.",
  "catalog.picker.error.generic": "تعذّر تحميل الأصناف.",
  // --- التعديل والإخراج من الكتالوج (RT-768, CAT-C2a) ----------------------------
  "catalog.detail.subWriter": "صنف في {tenant}.",
  "catalog.detail.edit": "تعديل الصنف",
  "catalog.detail.retiredNotice":
    "أُخرج هذا الصنف من الكتالوج، لذلك هو للقراءة فقط. تبقى معرّفاته مرتبطة به.",

  "catalog.edit.title": "تعديل {name}",
  "catalog.edit.sub": "تسري التغييرات في {tenant}. يُحفظ فقط ما غيّرته.",
  "catalog.edit.scopePrompt": "اختر مؤسسة لتعديل هذا الصنف.",
  "catalog.edit.back": "العودة إلى الصنف",
  "catalog.edit.loadingNoun": "الصنف",
  "catalog.edit.readOnly": "يمكنك عرض هذا الصنف دون تعديله.",
  "catalog.edit.readOnlyHint": "تعديل الأصناف متاح لمالك المؤسسة ومسؤولها.",
  "catalog.edit.retired": "أُخرج هذا الصنف من الكتالوج، لذلك هو للقراءة فقط.",
  "catalog.edit.retiredHint": "تبقى معرّفاته مرتبطة به. لا يمكن التراجع عن إخراج الصنف من هنا.",
  "catalog.edit.section": "بيانات الصنف",
  "catalog.edit.save": "حفظ التغييرات",
  "catalog.edit.noChanges": "لا توجد تغييرات للحفظ.",
  "catalog.edit.reload": "إعادة التحميل",
  "catalog.edit.reloaded": "تم تحميل أحدث نسخة. ما كتبته محفوظ في النموذج. راجعه ثم احفظ مرة أخرى.",
  "catalog.edit.reloadFailed": "تعذّرت إعادة تحميل هذا الصنف. ما كتبته محفوظ في النموذج.",

  "catalog.form.name": "الاسم",
  "catalog.form.description": "الوصف",
  "catalog.form.category": "الفئة",
  "catalog.form.categoryNone": "بدون فئة",
  "catalog.form.categoryRetired": "{name} (مُخرجة من الكتالوج)",
  "catalog.form.categoryUnavailableOption": "{name} (غير متاحة)",
  "catalog.form.categoriesFailed": "تعذّر تحميل الفئات. تبقى الفئة الحالية كما هي.",
  "catalog.form.taxCategory": "فئة الضريبة",
  "catalog.form.taxCategoryHint": "رمز قصير حتى 50 حرفًا. يُحفظ كما كُتب، عدا المسافات في طرفيه.",
  "catalog.form.availability": "متاح للبيع افتراضيًا",
  "catalog.form.availabilityHint": "يمكن للمتجر أن يحدد توفره بنفسه.",
  "catalog.form.price": "السعر",
  "catalog.form.priceHint": "لا يُعدَّل السعر من هنا.",
  "catalog.form.error.nameRequired": "أدخل اسم الصنف.",
  "catalog.form.error.nameTooLong": "يجب ألا يتجاوز الاسم 500 حرف. اختصره.",
  "catalog.form.error.descriptionTooLong": "يجب ألا يتجاوز الوصف 2000 حرف. اختصره.",
  "catalog.form.error.taxCategoryRequired": "أدخل فئة الضريبة.",
  "catalog.form.error.taxCategoryTooLong": "يجب ألا تتجاوز فئة الضريبة 50 حرفًا. اختصرها.",
  "catalog.form.error.categoryUnavailable":
    "هذه الفئة لم تعد متاحة. اختر فئة أخرى أو اترك الصنف بدون فئة.",

  "catalog.write.error.validation":
    "رفض الخادم هذه القيم. راجع الاسم والوصف وفئة الضريبة ثم حاول مرة أخرى.",
  "catalog.write.error.session": "انتهت جلستك. سجّل الدخول مرة أخرى.",
  "catalog.write.error.origin":
    "رُفض الطلب لأنه لم يصدر من هذه اللوحة. أعد تحميل الصفحة ثم حاول مرة أخرى.",
  "catalog.write.error.forbidden": "ليست لديك صلاحية تغيير هذا الصنف.",
  "catalog.write.error.notFound": "هذا الصنف لم يعد متاحًا لك.",
  "catalog.write.error.conflict": "حالة الصنف لا تسمح بهذا التغيير. أعد التحميل ثم حاول مرة أخرى.",
  "catalog.write.error.stale":
    "تغيّر هذا الصنف منذ فتحته. أعد التحميل للحصول على أحدث نسخة. ما كتبته محفوظ في النموذج.",
  "catalog.write.error.staleRetire":
    "تغيّر هذا الصنف منذ فتحته. أعد التحميل للحصول على أحدث نسخة ثم قرّر من جديد.",
  "catalog.write.error.retired": "أُخرج هذا الصنف من الكتالوج، فلم يعد تغييره ممكنًا.",
  "catalog.write.error.rateLimited": "طلبات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.",
  "catalog.write.error.server": "حدث خطأ ولم يُحفظ شيء. حاول مرة أخرى.",

  "catalog.retire.section": "إخراج الصنف من الكتالوج",
  "catalog.retire.sub": "إخراج الصنف يوقف بيعه. لا يمكن التراجع عنه من لوحة التحكم.",
  "catalog.retire.start": "إخراج الصنف",
  "catalog.retire.confirmLabel": "تأكيد: إخراج هذا الصنف من الكتالوج",
  "catalog.retire.prompt": "إخراج {name} من الكتالوج؟",
  "catalog.retire.consequence":
    "لا يمكن التراجع عن هذا الإجراء من هنا. تتوقف نقطة البيع عن عرض هذا الصنف. تبقى الباركودات وبقية معرّفاته مرتبطة به، فلا يمكن استخدامها لصنف آخر.",
  "catalog.retire.confirm": "نعم، أخرج الصنف",
  "catalog.retire.done": "أُخرج {name} من الكتالوج. وهو للقراءة فقط الآن.",
  "catalog.retire.reloaded": "تم تحميل أحدث نسخة. أخرج الصنف مرة أخرى إذا كنت لا تزال تريد ذلك.",
  // --- معرّفات الصنف: إضافة وإزالة (RT-769, CAT-C2b) ---------------------------------
  "catalog.identifier.col.actions": "إجراءات",
  "catalog.identifier.add.start": "إضافة معرّف",
  "catalog.identifier.add.title": "إضافة معرّف",
  "catalog.identifier.add.submit": "إضافة المعرّف",
  "catalog.identifier.field.type": "النوع",
  "catalog.identifier.field.scope": "النطاق",
  "catalog.identifier.field.scopeHint": "المعرّف الخاص بمتجر واحد لا يُتعرَّف عليه إلا في ذلك المتجر.",
  "catalog.identifier.field.source": "النظام المصدر",
  "catalog.identifier.field.sourceHint":
    "اسم نظام نقطة البيع الخارجية الذي جاء منه هذا المعرّف، حتى 100 حرف.",
  "catalog.identifier.field.value": "القيمة",
  "catalog.identifier.field.valueHint":
    "حتى 200 حرف. يمكنك إدخالها بالماسح الضوئي. تُحفظ كما أُدخلت تمامًا: لا تُحذف مسافات ولا تُحوَّل حروف أو أرقام.",
  "catalog.identifier.warning.arabicDigits":
    "تحتوي القيمة على أرقام غير 0-9 (مثل الأرقام العربية المشرقية). الماسحات الضوئية ترسل الأرقام 0-9، فقد لا يُعثر على الصنف عند المسح. ستُحفظ القيمة كما أدخلتها.",
  "catalog.identifier.error.valueRequired": "أدخل القيمة.",
  "catalog.identifier.error.valueControl":
    "تحتوي القيمة على حرف تحكم غير مرئي (مثل مسافة الجدولة). احذفه.",
  "catalog.identifier.error.valueEdgeSpace":
    "تبدأ القيمة أو تنتهي بمسافة. احذفها: تُحفظ القيمة كما أُدخلت تمامًا.",
  "catalog.identifier.error.valueTooLong": "يجب ألا تتجاوز القيمة 200 حرف.",
  "catalog.identifier.error.sourceRequired": "أدخل النظام المصدر.",
  "catalog.identifier.error.sourceControl": "يحتوي النظام المصدر على حرف غير مسموح به. احذفه.",
  "catalog.identifier.error.sourceTooLong": "يجب ألا يتجاوز النظام المصدر 100 حرف.",
  "catalog.identifier.error.aliasConflict": "هذه القيمة مستخدمة بالفعل لصنف آخر.",
  "catalog.identifier.error.validation":
    "رفض الخادم هذا المعرّف. راجع النوع والقيمة والنطاق ثم حاول مرة أخرى.",
  "catalog.identifier.error.notFound": "هذا الصنف أو المتجر المختار لم يعد متاحًا لك.",
  "catalog.identifier.error.retired": "أُخرج هذا الصنف من الكتالوج، فلا يمكن إضافة معرّفات إليه.",
  "catalog.identifier.error.gone":
    "لم يعد هذا المعرّف نشطًا على هذا الصنف. ستُعاد قراءة الصنف عند إغلاق هذه النافذة.",
  "catalog.identifier.retire.title": "إزالة معرّف",
  "catalog.identifier.retire.consequence":
    "تتحرر قيمته، فيمكن إضافتها من جديد لهذا الصنف أو لصنف آخر. وحتى ذلك الحين لن يجد المسح بها أي صنف.",
  "catalog.identifier.retire.confirm": "نعم، أزل المعرّف",
  "catalog.identifier.retire.start": "إزالة",
  "catalog.identifier.retire.rowLabel": "إزالة {type} {value}",
  "catalog.identifier.added": "أُضيف المعرّف.",
  "catalog.identifier.retiredDone": "أُزيل المعرّف. قيمته متاحة للاستخدام من جديد.",
} satisfies Messages;
