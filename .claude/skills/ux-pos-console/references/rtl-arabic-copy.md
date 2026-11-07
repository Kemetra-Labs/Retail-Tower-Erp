# RTL, accessibility and Arabic copy (UX-11, UX-12)

## RTL structure (UX-11.12-.16)

- RTL is **structure, not styling**: `lang`/`dir` on the document/app/surface boundary (and dialog portals), not text-align approximations. `lang` describes speech, `dir` describes flow.
- **Logical properties by default**: `margin-inline-start`, `inset-inline-end`, `border-inline-start`, `text-align: start/end`. A physical left/right needs a comment explaining why. Animations follow direction (drawer entry uses a direction-aware sign).
- **Machine data is isolated LTR**: amounts, SKUs, barcodes, emails, request IDs, sale/receipt numbers, times, card references, Latin product names use `<bdi dir="ltr">`/`unicode-bidi: isolate`. Isolate the number, not the whole Arabic sentence. Keypads stay LTR (1-2-3 top row).
- Visual order and Tab order must tell the same story (UX-11.7).
- Mirror directional icons by meaning; keep object icons. Keep the `›` separator as-is (it is Bidi_Mirrored and already flips).
- Admin Console on `origin/main` (b0b35e3, checked 2026-10-21): `<html lang="ar-EG" dir="rtl">`, default locale `ar`, English as a second locale via a top-bar switch (RT-399), message catalog in `src/i18n/messages/{ar,en}/`. Older Confluence text (Final Audit, UX-11, UX-12 of 2026-10-07) and the RT-266 plan (baseline 10-10) describe Admin as English/LTR with physical CSS: that is **stale**. Remaining items per Admin `DESIGN.md`: Store timezone (RT-401), owner-approved role labels, `error.code`-first error copy. Re-grep for leftover physical left/right CSS before claiming a surface is fully logical.

## Keyboard, focus, screen readers, contrast (UX-11)

- Accessibility is operational reliability, not a finishing layer (UX-11.1). Every essential action works without a pointer (UX-11.2). Native HTML before ARIA (UX-11.3).
- Focus is a first-class state, distinct from hover/selection/location (UX-11.4); **never obscured** by sticky headers, totals, drawers (UX-11.5; use scroll-padding/margin); outline, not box-shadow alone (UX-11.6).
- `aria-modal="true"` means a real Tab/Shift+Tab trap, safe Escape, intentional initial focus, focus restore (UX-11.9). Focus returns to the invoker, or to the next meaningful owner when the invoker vanished (UX-11.8).
- Dangerous/icon-only actions carry explicit accessible names (UX-11.10). Blocking reasons are persistent text (UX-11.11).
- Live regions announce consequence, not chatter; scan-add announcements stay short, e.g. «أُضيف: الاسم» via polite status; urgent blocking errors use assertive alert sparingly (UX-11.17-.19). Do not stack focus jump + modal + toast + alert for one validation problem (UX-11.20).
- Targets: POS 44x44 CSS px floor; Admin may be denser (36px) above the 24x24 WCAG 2.2 AA floor (UX-11.21-.23). 44px is the design target, not a claim of AA; meaning expands before it clips under zoom and long Arabic (UX-11.24).
- Forced colours are an operating environment, not a theme (UX-11.26). Reduced motion does not mean reduced feedback (UX-11.28).
- **Evidence**: static checks, component tests, keyboard-only walkthrough, axe, forced-colours capture, reduced-motion validation, packaged runtime proof for critical POS journeys, per touched surface (UX-11.29-.30). Flag anything unverified as "Needs verification".

## Copy model (UX-12)

- **Arabic is the primary authored language (UX-12.2). One locale at a time (UX-12.3)**: no «Arabic (English)» duplicates. English stays only for machine/proper terms (EGP, SKU, ERPNext, exact IDs). English as a second locale is planned (POS planning only; Admin switch shipped via RT-399).
- Operational Arabic: concise MSA/commonly understood retail Arabic; familiar beats pure (باركود, كاشير) (UX-12.4-.5). No exclamation-heavy copy; describe the state, not the operator's failure («المبلغ غير صالح») (UX-12.10-.11).
- **Name the action, not the button type**: «إضافة إلى السلة», «تأكيد الدفع», «إعادة الطباعة», «تحديث حالة الدفع» over OK/Confirm/Continue/Retry (UX-12.6).
- **Verb jurisdiction** (UX-12.7): حفظ persist edits; إضافة create/add; تأكيد cross a consequence boundary; إلغاء cancel a workflow; حذف delete a persisted entity; إزالة remove an association/cart element; تحديث re-read truth. «حاول مرة أخرى» only where retry can help (UX-12.8).
- **Error/recovery shape: What -> Safety -> Action -> Evidence** with a copyable reference where useful (UX-12.9).
- **Say what succeeded**: «تم حفظ البيع», «تم تسجيل الدفع», «تم تحديث السعر», not «تمت العملية بنجاح» (UX-12.12). Note: UX-12.7 reserves تحديث for re-reading truth, yet UX-12.12 itself uses «تم تحديث السعر» for a price write. Both are house text; do not "fix" either. For a price *edit* action prefer حفظ/تأكيد and use «تم تحديث السعر» only as the proven-outcome line, and flag the tension if it matters.
- **Verbs must not exceed evidence**: «أُرسل الإيصال للطابعة» when the job is submitted; «طُبع الإيصال» only for proven print (UX-12.13). **Receipt (الإيصال) != Sales Invoice (فاتورة مبيعات)** (UX-12.14).
- **Unknown is named as unknown**: «نتيجة الدفع غير مؤكدة», warn the amount may already be collected, forbid duplicate charging, expose only the supported recovery; never «مرفوض» (UX-12.15).
- Machine codes (`store_code_conflict`, `stale_version`) select localized messages; raw backend text is never primary copy; a missing translation never leaks a key or backend English (UX-12.33-.34).

## Terminology (UX-12.16-.19)

| Domain concept | Arabic UI | Evidence term |
|---|---|---|
| Tenant | المؤسسة | Tenant |
| Legal Entity | الكيان القانوني | Legal Entity |
| Trading Brand | العلامة التجارية | Trading Brand |
| Store | المتجر (never «الفرع»; authored names like «فرع المعادي» stay) | Store |
| Retail Item | الصنف | tenant_product |
| Product Family | عائلة المنتج | Product Family |
| Catalog | الكتالوج | Catalog |
| Stock Location | موقع المخزون | Stock Location |
| Receipt / Sales Invoice | الإيصال / فاتورة مبيعات | Receipt / Sales Invoice |
| Shift | الوردية | Shift |
| Cashier / Manager | الكاشير / المدير | cashier / manager |
| Generic identity | المستخدم | operator |

Code names (`operator`, `tenant_product`, `projection`) never leak into copy. ERPNext Item is never shown as product authority.

## Numbers, money, time (UX-12.20-.30)

- **Western digits 0-9** in system-generated output through `ar-EG-u-nu-latn`, not the device default. Authored catalogue/business names keep their own digits and script. Numeric inputs accept Arabic-Indic/Persian digits and normalize to ASCII.
- **Money**: `1,250.00 EGP`: grouping, exactly two decimals, `EGP` after the figure, whole run LTR-isolated, minus as U+2212 at the inline start. Arithmetic is integer minor units. POS renderer formatter `human-format.ts` implements it; `shared/money` `format()` still prints ungrouped, and printed receipts are a separate decision (OD-3 receipt check still open).
- **Counts/plurals**: dense metadata noun-first («الأصناف: 11 · الوحدات: 23»); prose uses full plural messages with CLDR categories zero/one/two/few/many/other (use `Intl.PluralRules('ar')` / `shared/formatters/arabic-plural.ts`); never `{n} + noun`; localize whole sentences, not fragments. Sync counts use words for 1 and 2, a digit from 3 (POS freeze 5.1).
- **Time**: operational = readable Arabic date, Western digits, 24h, in the **Store's** timezone («7 أكتوبر 2026، 13:42»); audit/support evidence = exact timestamp with explicit zone/UTC. Relative time («منذ 3 دقائق») orients on freshness surfaces; absolute stays available when freshness affects a decision; Audit never relies on relative time alone. Cross-store views expose an explicit zone.

## Frequently used POS messages (freeze catalogue; verbatim, check the file for current state)

| ID | Situation | Copy |
|---|---|---|
| M-S1 | Scan owner states | «جاهز للمسح» / «المسح متوقف — البحث مفتوح» / «المسح متوقف — نافذة مفتوحة» / «المسح غير متاح» |
| M-S2 | Item added | «أُضيف: ‹الاسم›» + «تراجع» |
| M-S3 | Unknown barcode | «الباركود ‹code› غير موجود في الكتالوج. امسح مرة أخرى أو ابحث بالاسم.» |
| M-S5 | Scan into money/PIN/ref field | «لا يُقبل المسح في حقل المبلغ. أدخل المبلغ بالأرقام.» |
| M-P8 | Known card decline (contract pending D-P1) | «رُفضت العملية على جهاز البطاقات. لم يُسجَّل أي مبلغ. اختر طريقة دفع أخرى.» |
| M-P9 | UNKNOWN | «النتيجة غير مؤكدة. لا تكرر الخصم. تحقق من جهاز البطاقات ثم تابع الاستعادة.» |
| M-P13 | After local reversal of a card line | «أُلغي الدفع هنا فقط. ألغِ العملية على جهاز البطاقات قبل أي خصم جديد.» |
| M-P11 | Finalization failed | «تم تسجيل الدفع لكن لم يُحفظ البيع. لا تكرر الدفع. أعد محاولة الحفظ.» |
| M-C2/C3 | Receipt sent / failed | «أُرسل الإيصال للطابعة» / «تعذّرت طباعة الإيصال. البيع محفوظ. أعد الطباعة أو سلّم إيصالًا يدويًا.» |
| M-A3 | Session expired | «انتهت جلسة الدخول. سجّل الدخول مرة أخرى للمتابعة.» |
| M-L1 | Locked | «الطرفية مقفلة. أدخل الرقم السري للمتابعة.» |

Do not use M-C4 «لم يُفتح درج النقود. افتحه يدويًا.» (superseded: drawer is optional, RT-495).
