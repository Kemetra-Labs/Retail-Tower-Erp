// Strings of the Ops | Story switch and the guided tour, in English and Arabic.
// Copy is from the approved mockup (docs/superpowers/specs/2026-11-13-rt-control-room-mockup.html,
// its `FRAMES` and `PT`); the "PROPOSAL" badge is dropped and the fixed "4 faults" of the last
// step is a placeholder filled from the board.

export const MODE_STRINGS = {
  modeAria: { en: "View mode", ar: "طريقة العرض" },
  modeOps: { en: "Ops", ar: "التشغيل" },
  modeStory: { en: "Story", ar: "القصة" },

  tourName: { en: "Story tour", ar: "جولة القصة" },
  tourPrev: { en: "Back", ar: "رجوع" },
  tourNext: { en: "Next", ar: "التالي" },
  tourExit: { en: "Exit tour", ar: "اخرج من الجولة" },
  tourStep: { en: "Step {n} of {total}", ar: "خطوة {n} من {total}" },

  tour1Title: { en: "One test lab, from till to ledger", ar: "معمل تجربة واحد، من الكاشير للدفتر" },
  tour1Text: {
    en: "Four Retail Tower products and one accounting system. Every link is drawn, and every fault is pinned where it happens.",
    ar: "أربع منتجات من Retail Tower ونظام حسابات واحد. كل رابط مرسوم، وكل عطل متثبّت مكانه.",
  },
  tour2Title: { en: "The till and the console", ar: "الكاشير ولوحة الإدارة" },
  tour2Text: {
    en: "Cashiers sell on the POS. Managers run stores in the Admin Console. Both talk only to Backend-Core.",
    ar: "الكاشير بيبيع على الـ POS. المديرين بيديروا المحلات من لوحة الإدارة. الاتنين بيكلموا Backend-Core بس.",
  },
  tour3Title: { en: "Backend-Core is the hub", ar: "Backend-Core هو المحور" },
  tour3Text: {
    en: "Sales and catalog changes pass through Backend-Core. Nothing skips it on the way to the ledger.",
    ar: "المبيعات وتعديلات الكتالوج بتعدي على Backend-Core. مفيش حاجة بتتخطاه في الطريق للدفتر.",
  },
  tour4Title: { en: "The bridge to the ledger", ar: "الجسر للدفتر" },
  tour4Text: {
    en: "ERPNext is the accounting ledger, outside Retail Tower. Only the Connector may reach it.",
    ar: "ERPNext هو دفتر الحسابات، برّه Retail Tower. الجسر بس اللي يوصله.",
  },
  tour5Title: { en: "Honest about faults", ar: "صريحين في الأعطال" },
  // Three readings of the last step, all from board data: a count, no faults reported, or counts not read.
  tour5Faults: {
    en: "Where something is wrong, the board shows where it comes from: {faults} on the invoice cable, reported by Sentry. What is not watched yet shows as unknown, never as healthy.",
    ar: "لما في عطل، اللوحة بتوريك جاي منين: {faults} على كابل الفواتير، من Sentry. اللي لسه مش متراقب بيظهر مجهول، عمره ما بيظهر سليم.",
  },
  tour5None: {
    en: "The board shows where a fault comes from. No faults are reported on the invoice cable right now. What is not watched yet shows as unknown, never as healthy.",
    ar: "اللوحة بتوريك العطل جاي منين. مفيش أعطال مبلّغ عنها على كابل الفواتير دلوقتي. اللي لسه مش متراقب بيظهر مجهول، عمره ما بيظهر سليم.",
  },
  tour5NotRead: {
    en: "The board shows where a fault comes from, but fault counts are not read right now: the error tracker could not be read. What is not watched yet shows as unknown, never as healthy.",
    ar: "اللوحة بتوريك العطل جاي منين، بس عدد الأعطال مش مقروء دلوقتي: متتبع الأخطاء مقدرش يتقرا. اللي لسه مش متراقب بيظهر مجهول، عمره ما بيظهر سليم.",
  },
  // A fault count: English plural; Arabic one / two / few (3-10) / many (as in the verdict).
  tourFaultsOne: { en: "1 fault", ar: "عطل واحد" },
  tourFaultsTwo: { en: "{n} faults", ar: "عطلين" },
  tourFaultsFew: { en: "{n} faults", ar: "{n} أعطال" },
  tourFaultsMany: { en: "{n} faults", ar: "{n} عطل" },
} as const;
