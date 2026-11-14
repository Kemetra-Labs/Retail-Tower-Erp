// Strings of the alarm panel, the detail, the table view and the lower panels,
// in English and Arabic. Copy is from the approved mockup
// (docs/superpowers/specs/2026-11-13-rt-control-room-mockup.html); the
// "PROPOSAL" prefixes are dropped and fixed figures are {n} placeholders.

export const PANEL_STRINGS = {
  // ---- alarm list ------------------------------------------------------------
  notPlaced: { en: "Not placed on the map", ar: "مش متحدد على الخريطة" },
  alarmsEmpty: {
    en: "No active alarms. Places with no health check stay listed below as unknown, so no alarms never means all healthy.",
    ar: "مفيش إنذارات شغالة. الأماكن اللي مفيهاش فحص صحة فاضلة تحت كمجهولة، فمفيش إنذارات مش معناها كله سليم.",
  },
  exampleTag: { en: "Example, not real", ar: "مثال، مش حقيقي" },
  watchNote: { en: "Not a fault: health is unknown", ar: "مش عطل: الصحة مش معروفة" },
  watchNoCheck: { en: "{name}: no health check", ar: "{name}: مفيش فحص صحة" },

  // ---- where an alarm is -----------------------------------------------------
  whereCable: { en: "On the cable {from} to {to} ({carries})", ar: "على كابل {from} إلى {to} ({carries})" },
  whereInside: { en: "Inside {name}", ar: "جوه {name}" },
  whereHost: { en: "On server {host}, inside {name}", ar: "على السيرفر {host}، جوه {name}" },
  whereUnplaced: {
    en: "Not placed on the map: Port does not say which server",
    ar: "مش متحدد على الخريطة: Port مش بيقول أنهي سيرفر",
  },

  // ---- events ----------------------------------------------------------------
  eventsEmpty: {
    en: "No changes yet. New ones appear here when Port reports them.",
    ar: "مفيش تغييرات لسه. الجديد بيظهر هنا لما Port يبلّغ عنه.",
  },
  replayNote: {
    en: "Last 24 h (partial): rebuilt from what Port still holds, not a full history.",
    ar: "آخر 24 ساعة (جزئي): معاد بناؤها من اللي لسه موجود في Port، مش تاريخ كامل.",
  },
  evAlarm: { en: "Error", ar: "خطأ" },
  evMonitor: { en: "Check", ar: "فحص" },
  evMerge: { en: "Merge", ar: "دمج" },
  evCi: { en: "CI", ar: "CI" },
  evJira: { en: "Jira", ar: "Jira" },
  evDeploy: { en: "Deploy", ar: "نشر" },

  announceMany: { en: "{n} new alarms. Latest: {text}", ar: "{n} إنذارات جديدة. آخرها: {text}" },

  // ---- detail ----------------------------------------------------------------
  openDatadog: { en: "Open in Datadog", ar: "افتح في Datadog" },
  noPath: { en: "No path is drawn: the location is not known.", ar: "مفيش مسار مرسوم: المكان مش معروف." },
  hopFailing: { en: "fails here", ar: "العطل هنا" },
  dChecks: { en: "Health checks", ar: "فحوصات الصحة" },
  dChecksNone: { en: "None, so health is unknown", ar: "مفيش، فالصحة مش معروفة" },
  hostPackNote: {
    en: "The {n} host checks watch every server at once.",
    ar: "مراقبات السيرفر الـ {n} بتراقب كل السيرفرات مع بعض.",
  },
  hostLedgerNote: {
    en: "The ledger, outside Retail Tower. Only the bridge may reach it.",
    ar: "دفتر الحسابات، خارجي. الجسر بس اللي يوصله.",
  },

  // ---- table view of the map ---------------------------------------------------
  tableView: { en: "Table view", ar: "عرض الجدول" },
  tableNote: {
    en: "The same data as the diagram, as a table. A narrow tile shows this instead of the diagram.",
    ar: "نفس بيانات الرسمة في جدول. المربع الضيق بيعرض ده بدل الرسمة.",
  },
  thState: { en: "State", ar: "الحالة" },
  thAlarms: { en: "Alarms", ar: "الإنذارات" },
  thChecks: { en: "Health checks", ar: "فحوصات الصحة" },
  thLinks: { en: "Links", ar: "الروابط" },
  stFault: { en: "Fault", ar: "عطل" },
  stLedger: { en: "External ledger, not monitored here", ar: "دفتر خارجي، مش متراقب من هنا" },
  stUnknown: { en: "Unknown: no health check", ar: "مجهول: مفيش فحص صحة" },
  stNoErrors: { en: "No errors reported", ar: "مفيش أخطاء مبلّغ عنها" },
  stNoFaults: { en: "No faults", ar: "مفيش أعطال" },
  stNotRead: { en: "Not read", ar: "مش مقروء" },

  // ---- lower panels ------------------------------------------------------------
  ciAria: { en: "Last {n} runs: {passed} passed, {failed} failed.", ar: "آخر {n} تشغيلة: {passed} نجحوا، {failed} فشلوا." },
  hcCore: { en: "Backend-Core", ar: "Backend-Core" },
  hcServers: { en: "Servers (each of {n})", ar: "السيرفرات (كل واحد من {n})" },
  hcDatabases: { en: "Databases and cache", ar: "قواعد البيانات والكاش" },
  hcAdmin: { en: "Admin Console", ar: "لوحة الإدارة" },
  hcConn: { en: "ERPNext-Connector", ar: "الجسر" },
  hcPos: { en: "POS", ar: "POS" },
  hcOther: { en: "Not placed on a server", ar: "مش متحدد على سيرفر" },
} as const;
