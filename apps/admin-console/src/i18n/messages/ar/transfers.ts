/**
 * Arabic copy for the read-only shipment-Transfer views (RT-1515, PR 1): the
 * list inside the Inventory section and one Transfer's drawer.
 *
 * Glossary: shipment Transfer → «تحويل» (list: «تحويلات المخزون»); In Transit →
 * «قيد النقل» (a quantity of the line, never a location or a status); Store →
 * «المتجر», never «الفرع»; product on a Transfer line → «المنتج», never «الصنف» (owner
 * decision, RT-1515 PR 2). PR 2 adds the writes (draft, approve, cancel,
 * dispatch): «مسودة» / «اعتماد» / «إلغاء» / «شحن»; every refusal is worded by
 * `error.code`, never by the server's message. Traps: no plain «المخزون» as a
 * figure, and no Available-to-Sell figure (none exists yet). The 404 while the
 * workflow is off is non-disclosing: say "not available", never claim why.
 */
export const transfers = {
  "transfers.entry": "تحويلات المخزون بين المتاجر",
  "transfers.title": "تحويلات المخزون",
  "transfers.sub": "تحويلات البضاعة بين متاجر المؤسسة، الأحدث أولًا.",
  "transfers.note.readOnly": "عرض للقراءة فقط. لا يُنشأ هنا أي تحويل ولا يُعتمد ولا يُشحن ولا يُستلم.",
  "transfers.note.inTransit":
    "الكمية «قيد النقل» كمية في سطر التحويل، وليست موقع تخزين ولا حالة مخزون.",

  "transfers.value.unknown": "غير معروف",
  "transfers.value.none": "—",
  "transfers.notFound": "هذا التحويل غير متاح.",
  "transfers.notAvailable": "تحويلات المخزون غير متاحة لهذه المؤسسة.",
  "transfers.notAvailable.hint":
    "قد لا تكون التحويلات مفعّلة للمؤسسة بعد. يفعّلها المالك أو مسؤول المؤسسة عند جاهزيتها.",
  "transfers.notAvailable.filtered":
    "قد لا تكون التحويلات مفعّلة للمؤسسة، أو أن المتجر المختار غير متاح لك. أعد ضبط عوامل التصفية.",
  "transfers.route": "من {source} إلى {destination}",

  "transfers.state.draft": "مسودة",
  "transfers.state.approved": "معتمد",
  "transfers.state.in_transit": "قيد النقل",
  "transfers.state.partially_received": "مستلم جزئيًا",
  "transfers.state.received": "مستلم",
  "transfers.state.closed": "مغلق",
  "transfers.state.cancelled": "ملغى",

  "transfers.leg.not_posted": "لم يُرحَّل بعد",
  "transfers.leg.pending": "قيد الترحيل",
  "transfers.leg.confirmed": "أكّده ERPNext",
  "transfers.leg.rejected": "رفضه ERPNext",
  "transfers.leg.reconciliation_required": "تحتاج إلى مطابقة",
  "transfers.leg.notDispatched": "لم يُشحن بعد",

  "transfers.filter.legend": "تصفية التحويلات",
  "transfers.filter.store": "المتجر",
  "transfers.filter.store.all": "كل المتاجر",
  "transfers.filter.direction": "الاتجاه",
  "transfers.filter.direction.any": "صادر ووارد",
  "transfers.filter.direction.outbound": "صادر من المتجر",
  "transfers.filter.direction.inbound": "وارد إلى المتجر",
  "transfers.filter.state": "الحالة",
  "transfers.filter.state.all": "كل الحالات",
  "transfers.filter.reset": "إعادة ضبط عوامل التصفية",

  "transfers.list.title": "التحويلات",
  "transfers.list.caption": "تحويلات المخزون، الأحدث أولًا",
  "transfers.list.col.created": "وقت الإنشاء",
  "transfers.list.col.route": "المسار",
  "transfers.list.col.state": "الحالة",
  "transfers.list.col.lines": "الأسطر",
  "transfers.list.col.receipts": "الاستلامات",
  "transfers.list.col.dispatchErp": "ترحيل الشحن في ERPNext",
  "transfers.list.openHint": "فتح تفاصيل التحويل",
  "transfers.list.loadingNoun": "التحويلات",
  "transfers.list.loadFailed": "تعذّر تحميل التحويلات.",
  "transfers.list.empty": "لا توجد تحويلات مخزون بعد.",
  "transfers.list.emptyFiltered": "لا توجد تحويلات تطابق عوامل التصفية.",
  "transfers.list.loadMore": "تحميل تحويلات أقدم",

  "transfers.detail.title": "تفاصيل التحويل",
  "transfers.detail.loadingNoun": "التحويل",
  "transfers.detail.loadFailed": "تعذّر تحميل التحويل.",
  "transfers.detail.route": "المسار",
  "transfers.detail.state": "الحالة",
  "transfers.detail.createdAt": "أُنشئ",
  "transfers.detail.approvedAt": "اعتُمد",
  "transfers.detail.dispatchedAt": "شُحن",
  "transfers.detail.shortClosedAt": "اعتُمد إغلاق الكمية الناقصة",
  "transfers.detail.closedAt": "أُغلق",
  "transfers.detail.cancelledAt": "أُلغي",
  "transfers.detail.dispatchErp": "ترحيل الشحن في ERPNext",
  "transfers.detail.reason": "السبب",
  "transfers.detail.shortCloseReason": "سبب إغلاق الكمية الناقصة",
  "transfers.detail.cancelReason": "سبب الإلغاء",
  "transfers.detail.id": "مرجع التحويل",

  "transfers.lines.title": "الأسطر",
  "transfers.lines.caption": "أسطر التحويل وكمياتها",
  "transfers.lines.col.seq": "السطر",
  "transfers.lines.col.product": "المنتج",
  "transfers.lines.col.tracking": "هوية التتبع",
  "transfers.lines.col.unit": "الوحدة",
  "transfers.lines.col.ordered": "المطلوب",
  "transfers.lines.col.dispatched": "المشحون",
  "transfers.lines.col.received": "المستلم",
  "transfers.lines.col.shortClosed": "المغلق ناقصًا",
  "transfers.lines.col.inTransit": "قيد النقل",

  "transfers.receipts.title": "الاستلامات",
  "transfers.receipts.caption": "استلامات التحويل، الأقدم أولًا",
  "transfers.receipts.col.receivedAt": "وقت الاستلام",
  "transfers.receipts.col.erp": "ترحيل الاستلام في ERPNext",
  "transfers.receipts.col.line": "السطر",
  "transfers.receipts.col.quantity": "الكمية المستلمة",
  "transfers.receipts.col.status": "حالة المخزون عند الاستلام",
  "transfers.receipts.col.note": "ملاحظة",
  "transfers.receipts.loadingNoun": "الاستلامات",
  "transfers.receipts.loadFailed": "تعذّر تحميل الاستلامات.",
  "transfers.receipts.empty": "لم يُسجَّل أي استلام لهذا التحويل بعد.",
  "transfers.receipts.loadMore": "تحميل استلامات أحدث",

  "transfers.note.writes":
    "هنا يمكن إنشاء التحويلات واعتمادها وإلغاؤها وشحنها واستلامها وإغلاقها. إغلاق الكمية الناقصة للمالك ومسؤول المؤسسة فقط.",

  "transfers.create.open": "تحويل جديد",
  "transfers.create.title": "تحويل جديد",
  "transfers.create.scope": "مسودة تحويل بين متجرين",
  "transfers.create.intro":
    "اختر المتجر المصدر والمتجر الوجهة ثم أضف المنتجات وكمياتها. يُحفظ التحويل مسودة: لا تتحرك بضاعة ولا يُحجز مخزون قبل الاعتماد.",
  "transfers.create.chooseStore": "اختر المتجر",
  "transfers.create.source": "المتجر المصدر",
  "transfers.create.destination": "المتجر الوجهة",
  "transfers.create.noLines": "لم تُضف أي منتجات بعد.",
  "transfers.create.quantity": "الكمية",
  "transfers.create.remove": "إزالة",
  "transfers.create.removeLine": "إزالة السطر: {name}",
  "transfers.create.addProduct": "إضافة منتج",
  "transfers.create.addProductHelp":
    "ابحث عن منتج نشط ثم اختره ليُضاف سطرًا. سطر واحد لكل منتج، ولكل دفعة في المنتجات المتتبَّعة بالدفعات.",
  "transfers.create.add.serial":
    "لا يمكن تحويل المنتجات ذات الأرقام التسلسلية بعد. اختر منتجًا آخر.",
  "transfers.create.add.duplicate": "هذا المنتج مضاف بالفعل. يُسمح بسطر واحد لكل منتج.",
  "transfers.create.add.tooMany": "بلغ التحويل الحد الأقصى: 100 سطر.",
  "transfers.create.add.unknownMode": "نمط تتبع هذا المنتج غير معروف، فلا يمكن إضافته.",
  "transfers.create.identity": "الدفعة",
  "transfers.create.identitiesNoun": "الدفعات",
  "transfers.create.identitiesFailed": "تعذّر تحميل دفعات المنتج.",
  "transfers.create.identitiesUnavailable": "لا يمكن قراءة دفعات هذا المنتج بدورك الحالي.",
  "transfers.create.identitiesEmpty": "لا توجد دفعات مسجّلة لهذا المنتج.",
  "transfers.create.identitiesMore": "تحميل المزيد من الدفعات",
  "transfers.create.stock.noSource": "اختر المتجر المصدر لقراءة رصيده من هذا المنتج.",
  "transfers.create.stock.loading": "جارٍ قراءة رصيد المتجر المصدر…",
  "transfers.create.stock.failed":
    "تعذّرت قراءة رصيد المتجر المصدر، فوحدة المخزون غير معروفة ولا يمكن إرسال التحويل.",
  "transfers.create.stock.physical": "الرصيد الفعلي في المصدر",
  "transfers.create.stock.sellable": "القابل للبيع في المصدر",
  "transfers.create.stock.noUnit": "غير معروفة: لا وحدة مسجّلة لهذا المنتج في المتجر المصدر",
  "transfers.create.reason": "سبب التحويل",
  "transfers.create.reasonHelp": "حتى {max} حرف.",
  "transfers.create.effect": "الحفظ لا يشحن شيئًا: يبقى التحويل مسودة إلى أن يُعتمد ثم يُشحن.",
  "transfers.create.submit": "حفظ مسودة التحويل",
  "transfers.create.error.source": "اختر المتجر المصدر.",
  "transfers.create.error.destination": "اختر المتجر الوجهة.",
  "transfers.create.error.sameStore": "يجب أن يختلف المتجر الوجهة عن المتجر المصدر.",
  "transfers.create.error.noLines": "أضف منتجًا واحدًا على الأقل.",
  "transfers.create.error.tooManyLines": "الحد الأقصى 100 سطر في التحويل.",
  "transfers.create.error.reason": "سبب التحويل أطول من 500 حرف.",
  "transfers.create.error.identity": "اختر دفعة لهذا المنتج.",
  "transfers.create.error.quantity": "أدخل كمية أكبر من صفر، حتى 4 منازل عشرية.",
  "transfers.create.error.unit": "وحدة المخزون غير معروفة لهذا المنتج في المتجر المصدر.",
  "transfers.create.error.duplicate": "هذا المنتج (وهذه الدفعة) مكرر في سطر آخر. أبقِ سطرًا واحدًا.",

  "transfers.write.optional": "(اختياري)",
  "transfers.write.retry": "إعادة إرسال الطلب نفسه",
  "transfers.write.failed":
    "لم يصل أي رد، فلا نعرف إن كان الطلب قد سُجّل. أعد إرسال الطلب نفسه: لن يُسجَّل مرتين.",
  "transfers.write.error.validation": "رفض الخادم بيانات الطلب. راجع الحقول ثم أعد المحاولة.",
  "transfers.write.error.session": "انتهت جلستك. سجّل الدخول مرة أخرى.",
  "transfers.write.error.forbidden": "دورك لا يسمح بهذا الإجراء على هذا التحويل.",
  "transfers.write.error.notFound": "المتجر أو التحويل المطلوب غير متاح لك.",
  "transfers.write.error.rateLimited": "طلبات كثيرة في وقت قصير. انتظر قليلًا ثم أعد المحاولة.",
  "transfers.write.error.rateLimitedFor": {
    zero: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد {count} ثانية.",
    one: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد ثانية واحدة.",
    two: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد ثانيتين.",
    few: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد {count} ثوانٍ.",
    many: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد {count} ثانية.",
    other: "طلبات كثيرة في وقت قصير. أعد المحاولة بعد {count} ثانية.",
  },
  "transfers.write.error.notInState":
    "تغيّرت حالة التحويل ولم يعد هذا الإجراء متاحًا له. أعد فتح التحويل لرؤية حالته الحالية.",
  "transfers.write.error.crossLegalEntity":
    "المتجران يتبعان كيانين قانونيين مختلفين، ولا يمكن التحويل بينهما.",
  "transfers.write.error.identityRequired":
    "المنتج المتتبَّع يحتاج إلى دفعة واحدة في كل سطر. اختر الدفعة.",
  "transfers.write.error.identityHeldOrExpired":
    "الدفعة المختارة محجوزة أو منتهية الصلاحية. اختر دفعة أخرى.",
  "transfers.write.error.serialNotSupported": "تحويل المنتجات ذات الأرقام التسلسلية غير مدعوم بعد.",
  "transfers.write.error.warehouseUnmapped":
    "أحد المتجرين، أو مستودع البضاعة قيد النقل، غير مربوط بمستودع في ERPNext. اطلب من المسؤول إكمال الربط.",
  "transfers.write.error.itemUnmapped":
    "أحد المنتجات غير مربوط بمقابله في ERPNext. اطلب من المسؤول إكمال الربط.",
  "transfers.write.error.keyConflict":
    "تعذّر تأكيد هذا الطلب ولم يُسجَّل. اضغط الإرسال مرة أخرى لإرسال طلب جديد.",
  "transfers.write.error.overReceipt":
    "لا يمكن استلام أكثر من الكمية «قيد النقل» في السطر، ولم يُسجَّل شيء على التحويل. لا تُسجَّل الزيادة هنا: تُعالَج خارج التحويل بتسوية مخزون معتمدة.",
  "transfers.write.error.shortCloseReason": "إغلاق الكمية الناقصة يحتاج إلى سبب.",
  "transfers.write.error.generic": "تعذّر على الخادم إكمال الطلب. أعد المحاولة بعد قليل.",
  "transfers.write.error.code": "رمز الخطأ: {code}",

  "transfers.actions.title": "الإجراءات",
  "transfers.approve.open": "اعتماد التحويل",
  "transfers.approve.intro":
    "الاعتماد يحجز كمية التحويل من المتجر المصدر حتى انتهاء المدة المختارة.",
  "transfers.approve.window": "مدة الحجز",
  "transfers.approve.days.1": "يوم واحد",
  "transfers.approve.days.3": "3 أيام",
  "transfers.approve.days.7": "7 أيام",
  "transfers.approve.until": "ينتهي الحجز حوالي {at}.",
  "transfers.approve.submit": "اعتماد",
  "transfers.cancel.open": "إلغاء التحويل",
  "transfers.cancel.intro":
    "الإلغاء يُنهي هذا التحويل ويُحفظ السبب عليه. لا يتوفر تراجع عن الإلغاء هنا.",
  "transfers.cancel.reason": "سبب الإلغاء",
  "transfers.cancel.submit": "تأكيد الإلغاء",
  "transfers.cancel.error.reason": "اكتب سبب الإلغاء، من حرف إلى 500 حرف.",
  "transfers.dispatch.open": "شحن التحويل",
  "transfers.dispatch.confirm":
    "تخرج كامل الكمية المعتمدة من المتجر المصدر وتصبح «قيد النقل». لا يوجد شحن جزئي.",
  "transfers.dispatch.note": "ملاحظة الشحن",
  "transfers.dispatch.submit": "تأكيد الشحن",
  "transfers.dispatch.error.note": "ملاحظة الشحن أطول من 500 حرف.",
  "transfers.recorded.approve": "سُجّل اعتماد التحويل.",
  "transfers.recorded.cancel": "سُجّل إلغاء التحويل.",
  "transfers.recorded.dispatch": "سُجّل شحن التحويل.",

  "transfers.receive.open": "استلام البضاعة",
  "transfers.receive.intro":
    "اكتب الكمية المستلمة لكل سطر. اترك السطر فارغًا إذا لم يكن ضمن هذا الاستلام. ما لا يُستلم يبقى «قيد النقل».",
  "transfers.receive.lineHead": "السطر {seq}: {product}",
  "transfers.receive.quantity": "الكمية المستلمة، السطر {seq}",
  "transfers.receive.disposition": "حالة المخزون عند الاستلام، السطر {seq}",
  "transfers.receive.location": "الموقع",
  "transfers.receive.note": "ملاحظة الاستلام",
  "transfers.receive.submit": "تسجيل الاستلام",
  "transfers.receive.error.quantity":
    "اكتب كمية أكبر من صفر بحد أقصى 4 منازل عشرية، أو اترك السطر فارغًا.",
  "transfers.receive.error.over":
    "لا يمكن استلام أكثر من الكمية «قيد النقل» في هذا السطر، ولم يُرسَل شيء. لا تُسجَّل الزيادة هنا: تُعالَج خارج التحويل بتسوية مخزون معتمدة.",
  "transfers.receive.error.noLines": "اكتب كمية لسطر واحد على الأقل.",
  "transfers.receive.error.note": "ملاحظة الاستلام أطول من 500 حرف.",
  "transfers.close.open": "إغلاق التحويل",
  "transfers.close.confirm": "استُلمت كل البضاعة. الإغلاق يُنهي هذا التحويل.",
  "transfers.close.submit": "تأكيد الإغلاق",
  "transfers.shortClose.open": "إغلاق مع الكمية الناقصة",
  "transfers.shortClose.intro":
    "الكمية التي ما زالت «قيد النقل» في كل سطر أدناه تُشطب كخسارة معتمدة وتبقى خارج المتجرين. لا تُستلم في المتجر الوجهة. السبب مطلوب.",
  "transfers.shortClose.listLabel": "الكمية التي ستُشطب، حسب السطر",
  "transfers.shortClose.line": "السطر {seq}: {product}، {quantity} {unit} ما زالت «قيد النقل»",
  "transfers.shortClose.reason": "سبب إغلاق الكمية الناقصة",
  "transfers.shortClose.submit": "تأكيد إغلاق الكمية الناقصة",
  "transfers.shortClose.error.reason": "اكتب سبب إغلاق الكمية الناقصة، من حرف إلى 500 حرف.",
  "transfers.recorded.receive": "سُجّل استلام التحويل.",
  "transfers.recorded.close": "سُجّل إغلاق التحويل.",
  "transfers.recorded.shortClose": "سُجّل إغلاق الكمية الناقصة.",
};
