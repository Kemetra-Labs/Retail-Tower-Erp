import type { Messages } from "../types";

/**
 * Arabic copy for the Platform Console "POS pilot" page (RT-1329): the pilot
 * releases with their activation, and the tenant allowlist. Machine data
 * (version, SHA-256, GitHub login, tenant id) is not in the catalog: the page
 * isolates it LTR. Nothing here offers a withdraw: only the promotion workflow
 * withdraws a release (D-5a). The nav label lives in shell.ts.
 */
export const posPilot = {
  "posPilot.title": "تجربة نقطة البيع",
  "posPilot.sub": "إصدارات نقطة البيع التجريبية والمؤسسات المسموح لها بتنزيلها.",

  "posPilot.releases.panelTitle": "الإصدارات",
  "posPilot.releases.caption": "إصدارات التجربة",
  "posPilot.releases.note": "سحب الإصدار يتم من سير عمل الترقية فقط، لا من هذه الصفحة.",
  "posPilot.releases.col.version": "الإصدار",
  "posPilot.releases.col.state": "الحالة",
  "posPilot.releases.col.registered": "سُجّل في",
  "posPilot.releases.col.approvedBy": "اعتمده",
  "posPilot.releases.col.sha": "SHA-256",
  "posPilot.releases.col.size": "الحجم",
  "posPilot.releases.col.evidence": "الأدلة",
  "posPilot.releases.col.action": "الإجراء",
  "posPilot.releases.state.registered": "مسجّل",
  "posPilot.releases.state.current": "الحالي",
  "posPilot.releases.state.withdrawn": "مسحوب",
  "posPilot.releases.notApproved": "غير معتمد",
  "posPilot.releases.size": "{size} ميجابايت",
  "posPilot.releases.evidence.run": "تشغيل الترقية",
  "posPilot.releases.evidence.attestation": "الإثبات",
  "posPilot.releases.activate": "تفعيل",
  "posPilot.releases.activateFor": "تفعيل الإصدار {version}",
  "posPilot.releases.empty": "لا توجد إصدارات مسجّلة",
  "posPilot.releases.emptyHint": "يسجّل سير عمل الترقية الإصدارات المعتمدة.",
  "posPilot.releases.error.failed": "تعذّر تحميل الإصدارات.",

  "posPilot.activate.label": "تأكيد تفعيل الإصدار",
  "posPilot.activate.prompt":
    "تفعيل الإصدار {version}؟ سيصبح إصدار التجربة الحالي، وهو الإصدار الوحيد الذي يمكن أن تعرضه صفحة تنزيل نقطة البيع على المؤسسات المسموح لها. لا يمكن التراجع عنه من هنا: سحبه يتم من سير عمل الترقية فقط.",
  "posPilot.activate.promptBlocked":
    "تفعيل الإصدار {version}؟ الإصدار {current} هو الحالي الآن، لذلك سيُرفض التفعيل ولن يتغيّر شيء، إلا إذا كان سير عمل الترقية قد سحبه.",
  "posPilot.activate.confirm": "تأكيد التفعيل",
  "posPilot.activate.done": "الإصدار {version} هو الإصدار الحالي الآن.",
  "posPilot.activate.currentExists":
    "يوجد إصدار حالي آخر. يجب أن يسحبه سير عمل الترقية قبل تفعيل {version}. لم يتغيّر شيء.",
  "posPilot.activate.withdrawn": "الإصدار {version} مسحوب ولا يمكن تفعيله. لم يتغيّر شيء.",
  "posPilot.activate.notFound": "لم يعد هذا الإصدار موجودًا. يُعاد تحميل القائمة.",

  "posPilot.allowlist.panelTitle": "المؤسسات المسموح لها",
  "posPilot.allowlist.caption": "قائمة السماح للتجربة",
  "posPilot.allowlist.col.tenant": "المؤسسة",
  "posPilot.allowlist.col.added": "أُضيفت في",
  "posPilot.allowlist.col.action": "الإجراء",
  "posPilot.allowlist.unknownTenant": "مؤسسة غير معروفة",
  "posPilot.allowlist.empty": "لا توجد مؤسسة في قائمة السماح",
  "posPilot.allowlist.emptyHint": "لا تجد أي مؤسسة تنزيلًا لنقطة البيع حتى تُضاف هنا.",
  "posPilot.allowlist.error.failed": "تعذّر تحميل قائمة السماح.",
  "posPilot.allowlist.remove": "إزالة",
  "posPilot.allowlist.removeFor": "إزالة {name} من التجربة",

  "posPilot.add.label": "إضافة مؤسسة",
  "posPilot.add.placeholder": "اختر مؤسسة",
  "posPilot.add.submit": "إضافة إلى التجربة",
  "posPilot.add.none": "كل المؤسسات في قائمة السماح.",
  "posPilot.add.directoryFailed": "تعذّر تحميل قائمة المؤسسات، فلا يمكن إضافة مؤسسة الآن.",
  "posPilot.add.done": "أُضيفت {name} إلى التجربة.",
  "posPilot.add.alreadyListed": "{name} في قائمة السماح من قبل. لم يتغيّر شيء.",
  "posPilot.add.tenantNotFound": "لم تعد هذه المؤسسة موجودة. يُعاد تحميل القوائم.",
  "posPilot.add.loading": "جارٍ تحميل المؤسسات…",

  "posPilot.remove.label": "تأكيد إزالة المؤسسة",
  "posPilot.remove.prompt": "إزالة {name} من التجربة؟ لن تجد تنزيلًا لنقطة البيع حتى تُضاف مرة أخرى.",
  "posPilot.remove.confirm": "تأكيد الإزالة",
  "posPilot.remove.done": "أُزيلت {name} من التجربة.",

  "posPilot.notPermitted": "هذا الإجراء غير متاح لك.",
  "posPilot.rateLimited": "لم يتم ذلك بسبب كثرة الطلبات. حاول مرة أخرى بعد قليل.",
  "posPilot.failed": "تعذّر إكمال الإجراء. لم يتأكد أي تغيير.",
  "posPilot.retry": "حاول مرة أخرى",
} satisfies Messages;
