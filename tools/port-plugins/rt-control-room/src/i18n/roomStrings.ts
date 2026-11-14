// Strings of the control-room diagram (stations, cables, sources, servers,
// legend), in English and Arabic. Copy is from the approved mockup
// (docs/superpowers/specs/2026-11-13-rt-control-room-mockup.html); the few
// keys the mockup hard-coded as figures are {n} placeholders.

export const ROOM_STRINGS = {
  mapAria: {
    en: "Control room: stations, cables and alarms. The full list is in the alarms panel.",
    ar: "غرفة تحكم: المحطات والكابلات والإنذارات. القائمة الكاملة في لوحة الإنذارات.",
  },

  // ---- zones, bus and the source bar ---------------------------------------
  zoneFront: { en: "Front", ar: "الواجهات" },
  zoneCore: { en: "Core", ar: "العقل" },
  zoneIntegration: { en: "Integration", ar: "التكامل" },
  zoneBooks: { en: "Books", ar: "الدفاتر" },
  busTitle: { en: "Control room: Port reads from", ar: "غرفة التحكم: Port بيقرا من" },
  busLabel: { en: "Signal bus", ar: "خط الإشارات" },
  srcPort: { en: "Port catalog", ar: "كتالوج Port" },
  srcSentry: { en: "Error tracker", ar: "متتبع الأخطاء" },
  srcDatadog: { en: "Health checks", ar: "فحوصات الصحة" },
  srcGithub: { en: "Code history", ar: "تاريخ الكود" },
  srcJira: { en: "Task tracker", ar: "متتبع المهام" },
  srcSynced: { en: "Synced {ago}", ar: "اتزامن {ago}" },
  srcUpToDate: { en: "Up to date", ar: "محدّث" },
  srcStale: { en: "Stale", ar: "قديم" },
  srcStaleSynced: { en: "Stale, synced {ago}", ar: "قديم، اتزامن {ago}" },
  srcUnknown: { en: "Not known", ar: "مش معروف" },
  srcChange: { en: "Last change {ago}", ar: "آخر تغيير {ago}" },
  srcNoChange: { en: "No change recorded", ar: "مفيش تغيير مسجل" },

  // ---- station readings ------------------------------------------------------
  rdAlarms: { en: "Alarms", ar: "إنذارات" },
  rdChecks: { en: "Checks", ar: "فحوصات" },
  rdCi: { en: "CI 7d", ar: "CI 7 أيام" },
  rdTasks: { en: "Tasks", ar: "مهام" },
  // Shorter than the mockup wording so it does not run into the next column on the station card.
  rdPrs: { en: "PRs", ar: "تعديلات" },
  rdMerged: { en: "Merged", ar: "اتدمج" },
  rdDeploys: { en: "Deploys", ar: "تنزيلات" },
  rdCiFails: { en: "CI fails", ar: "فشل CI" },
  notRead: { en: "not read", ar: "مش مقروء" },
  // Station card cell: the approved mockup prints n/a in both languages (the detail view says it in words).
  na: { en: "n/a", ar: "n/a" },
  none: { en: "none", ar: "مفيش" },
  okCount: { en: "{n} OK", ar: "{n} تمام" },
  okOfCount: { en: "{ok}/{total} OK", ar: "{ok}/{total} تمام" },
  external: { en: "External", ar: "خارجي" },
  stationAlarmsN: { en: "{n} alarms", ar: "{n} إنذارات" },
  stationAlarmsNotRead: { en: "alarms not read", ar: "الإنذارات مش مقروءة" },

  // ---- link lamps (state words) ----------------------------------------------
  lampSending: { en: "sending", ar: "بيبعت" },
  lampLive: { en: "live", ar: "شغال" },
  lampLinked: { en: "linked, no signal yet", ar: "مربوط، مفيش إشارة لسه" },
  lampNone: { en: "not linked", ar: "مش مربوط" },
  lampNa: { en: "not needed", ar: "مش محتاج" },
  lampAlert: { en: "alarm", ar: "إنذار" },

  // ---- alarm kinds -----------------------------------------------------------
  kindRefused: { en: "ERPNext refused the request", ar: "ERPNext رفض الطلب" },
  kindDown: { en: "ERPNext is not answering", ar: "ERPNext مش بيرد" },
  kindTimeout: { en: "The request took too long", ar: "الطلب اتأخر وانتهت المهلة" },
  kindReset: { en: "The connection was cut", ar: "الاتصال اتقطع" },
  kindBug: { en: "A screen failed to draw", ar: "شاشة فشلت تترسم" },
  kindUnknown: { en: "Health not watched", ar: "الصحة مش متراقبة" },
  kindLatency: { en: "Responses are slow", ar: "الردود بطيئة" },
  kindNodata: { en: "Stopped reporting", ar: "بطّل يبلّغ" },
  kindMonitor: { en: "A Datadog check is in alert", ar: "فحص في Datadog في حالة إنذار" },

  // ---- cables, servers -------------------------------------------------------
  cableFaults: { en: "{n} faults", ar: "{n} أعطال" },
  cableFaultsOne: { en: "1 fault", ar: "عطل واحد" },
  cableNoFaults: { en: "no faults", ar: "مفيش أعطال" },
  ruleNote: {
    en: "No direct cable to ERPNext: a deliberate protection",
    ar: "مفيش كابل مباشر لـ ERPNext: حماية مقصودة",
  },
  serversLabel: { en: "Servers", ar: "السيرفرات" },
  hostDown: { en: "Down", ar: "واقع" },
  hostUnknown: { en: "Not known", ar: "مش معروف" },
  hostChecksOk: { en: "{n} Datadog checks OK", ar: "{n} مراقبات Datadog تمام" },
  hostChecksSome: { en: "{ok}/{total} Datadog checks OK", ar: "{ok}/{total} مراقبات Datadog تمام" },
  hostNoChecks: { en: "No Datadog checks", ar: "مفيش مراقبات Datadog" },
  hostAria: { en: "Server {name}: {state}. {checks}", ar: "السيرفر {name}: {state}. {checks}" },
  sparkAria: { en: "Merged per day, 13 days", ar: "اتدمج في اليوم، 13 يوم" },
} as const;
