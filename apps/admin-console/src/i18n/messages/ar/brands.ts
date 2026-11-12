import type { Messages } from "../types";

/**
 * Arabic copy for the brands page (RT-1338, RT-286 S6).
 *
 * Glossary: Brand → «العلامة التجارية» (pl. «العلامات التجارية»); Item → «صنف»
 * (as in the catalog); Store → «المتجر» (never «الفرع»). Verb jurisdiction (UX-12.7):
 * «إضافة» creates a brand, «تغيير الاسم» renames it, «حفظ» saves the form.
 */
export const brands = {
  "brands.nav.label": "العلامات التجارية",

  // --- List -----------------------------------------------------------------
  "brands.list.title": "العلامات التجارية",
  "brands.list.subtitle": "العلامات التي تصنّف أصناف {tenant}. تُسند علامة واحدة لكل صنف.",
  "brands.list.scopePrompt": "اختر مؤسسة لإدارة علاماتها التجارية.",
  "brands.list.create": "إضافة علامة تجارية",
  "brands.list.caption": "العلامات التجارية، مرتبة بالاسم",
  "brands.list.loadingNoun": "العلامات التجارية",
  "brands.list.empty": "لا توجد علامات تجارية في هذه المؤسسة بعد.",
  "brands.list.loadFailed": "تعذّر تحميل العلامات التجارية.",
  "brands.list.retry": "حاول مرة أخرى",
  "brands.list.col.name": "الاسم",
  "brands.list.col.updated": "آخر تحديث",
  "brands.list.col.actions": "الإجراءات",
  "brands.list.rename": "تغيير الاسم",
  "brands.list.renameLabel": "تغيير اسم العلامة التجارية {name}",

  // --- Form -----------------------------------------------------------------
  "brands.form.createTitle": "إضافة علامة تجارية",
  "brands.form.renameTitle": "تغيير اسم العلامة التجارية",
  "brands.form.name": "الاسم",
  "brands.form.nameHint": "حتى {max} حرفًا. لا يتكرر الاسم بين علامات المؤسسة.",
  "brands.form.nameRequired": "اكتب اسم العلامة التجارية.",
  "brands.form.nameTooLong": "اسم العلامة أطول من الحد المسموح.",
  "brands.form.nameTaken": "توجد علامة تجارية بهذا الاسم بالفعل.",
  "brands.form.saveCreate": "إضافة العلامة",
  "brands.form.saveRename": "حفظ الاسم",

  // --- Write outcomes ---------------------------------------------------------
  "brands.write.error.validation": "رفض الخادم الاسم. راجعه وحاول مرة أخرى.",
  "brands.write.error.session": "انتهت الجلسة. سجّل الدخول من جديد.",
  "brands.write.error.forbidden": "ليس لديك صلاحية تعديل العلامات التجارية.",
  "brands.write.error.rateLimited": "طلبات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.",
  "brands.write.error.stale":
    "تغيّرت هذه العلامة منذ فتحتها. أُعيد تحميل القائمة، فافتحها وحاول مرة أخرى.",
  "brands.write.error.gone": "لم تعد هذه العلامة التجارية موجودة. أُعيد تحميل القائمة.",
  "brands.write.error.uncertain":
    "لم يصل رد واضح، وقد يكون الطلب قد نُفّذ. اضغط الحفظ مرة أخرى؛ لن يتكرر التنفيذ.",
  "brands.write.error.generic": "تعذّر حفظ العلامة التجارية. حاول مرة أخرى.",
} satisfies Messages;
