# Admin Console v9 «Ink & Receipt» — board sources

These are the source files of the 37 current boards of the design canvas
<https://claude.ai/artifact/7LkLBupz4nTpvB4P4k4NW4> (private; version 50, 2026-10-30), kept here so
every implementation slice can point at a fixed, versioned copy (RT-988).

- **Rules win over boards.** Where a board and `DESIGN.md` §12 differ, `DESIGN.md` wins; the
  governing decision is Confluence RETAIL 62816260 (D-V1…D-V9).
- **How to read them.** Each file is the board's markup, styles and sample data. The canvas runtime
  (`support.js`) is not included, so a file does not render on its own outside the canvas: read it
  for layout, copy, tokens and states, or open the canvas link above.
- **Sample data is illustrative.** Names, amounts, IDs and e-mail addresses are invented. Text a
  board marks as new (its sticky note on the canvas) still needs a message key (UX-12).
- **Not included:** history boards v4–v8 and the early buttons board.
- `G1`–`G10` are the per-screen slices listed in `DESIGN.md` §10 (g); they become Jira issues when
  work reaches them.

| Board file | Canvas title | Jira slice |
| --- | --- | --- |
| [`Overview-v9.dc.html`](boards/Overview-v9.dc.html) | ✓ المعتمد · نظرة عامة v9 (2026-10-30) | RT-993 (+ RT-991, RT-992) |
| [`Sales.dc.html`](boards/Sales.dc.html) | المبيعات · القائمة (v9) | G1 |
| [`Sale-detail.dc.html`](boards/Sale-detail.dc.html) | المبيعات · تفاصيل الفاتورة (v9) | G1 (payment summary: RT-992) |
| [`Sales-states.dc.html`](boards/Sales-states.dc.html) | المبيعات · الحالات | G1 |
| [`Sales-mobile.dc.html`](boards/Sales-mobile.dc.html) | المبيعات · الهاتف | G1 |
| [`Sales-dark.dc.html`](boards/Sales-dark.dc.html) | المبيعات · الوضع الداكن | G1, RT-990 |
| [`Catalog.dc.html`](boards/Catalog.dc.html) | الأصناف · القائمة (v9) | G2 |
| [`Product-detail.dc.html`](boards/Product-detail.dc.html) | الأصناف · تفاصيل الصنف وتخصيصات المتاجر (v9) | G2 |
| [`Product-edit.dc.html`](boards/Product-edit.dc.html) | الأصناف · تعديل الصنف | G2 |
| [`Catalog-states.dc.html`](boards/Catalog-states.dc.html) | الأصناف · الحالات | G2 |
| [`Sync.dc.html`](boards/Sync.dc.html) | التكامل · اتصال ERPNext والمزامنة (v9) | G3 |
| [`Sale-repair.dc.html`](boards/Sale-repair.dc.html) | التكامل · مبيعات تحتاج إلى إصلاح (v9) | G3 |
| [`Sync-states.dc.html`](boards/Sync-states.dc.html) | التكامل · حالات الموصل والمزامنة | G3 |
| [`Stores.dc.html`](boards/Stores.dc.html) | المتاجر · القائمة (v9) | G4 |
| [`Store-detail.dc.html`](boards/Store-detail.dc.html) | المتاجر · تفاصيل المتجر (v9) | G4 |
| [`Devices.dc.html`](boards/Devices.dc.html) | الأجهزة · القائمة وإيقاف الصلاحية (v9) | G4 |
| [`Users.dc.html`](boards/Users.dc.html) | المستخدمون · القائمة والدعوة والتعديل (v9) | G5 (band: RT-995) |
| [`Users-states.dc.html`](boards/Users-states.dc.html) | المستخدمون · الحالات | G5 |
| [`Shifts.dc.html`](boards/Shifts.dc.html) | الورديات · إقفالات بفرق نقدي (v9) | G6 |
| [`Shift-detail.dc.html`](boards/Shift-detail.dc.html) | الورديات · تفاصيل الإقفال وتسوية النقد (v9) | G6 |
| [`Shifts-states.dc.html`](boards/Shifts-states.dc.html) | الورديات · الحالات | G6 |
| [`Inventory.dc.html`](boards/Inventory.dc.html) | المخزون · مخزون المتجر وسجل الحركات (v9) | G7 |
| [`Inventory-product.dc.html`](boards/Inventory-product.dc.html) | المخزون · رصيد المنتج ونقل الحالة (v9) | G7 |
| [`Inventory-states.dc.html`](boards/Inventory-states.dc.html) | المخزون · الحالات | G7 |
| [`Discrepancies.dc.html`](boards/Discrepancies.dc.html) | فروقات ERPNext · المتاجر واللقطات (v9) | G7 |
| [`Discrepancy-store.dc.html`](boards/Discrepancy-store.dc.html) | فروقات ERPNext · المتجر: لقطة متقادمة وطلب معلّق (v9) | G7 |
| [`Discrepancy-states.dc.html`](boards/Discrepancy-states.dc.html) | فروقات ERPNext · الحالات | G7 |
| [`Audit.dc.html`](boards/Audit.dc.html) | سجل التدقيق · البحث ودرج الحدث (v9) | G8 |
| [`Audit-states.dc.html`](boards/Audit-states.dc.html) | سجل التدقيق · الحالات | G8 |
| [`Unknown-items.dc.html`](boards/Unknown-items.dc.html) | أصناف غير معروفة · قائمة المراجعة ودرج المعالجة (v9) | G7 |
| [`Unknown-items-states.dc.html`](boards/Unknown-items-states.dc.html) | أصناف غير معروفة · الحالات | G7 |
| [`Reports-hub.dc.html`](boards/Reports-hub.dc.html) | التقارير · الفهرس: متاح ومقترح (v9) | G9 |
| [`Reports.dc.html`](boards/Reports.dc.html) | التقارير · المبيعات المستلمة يوميًا: قراءة وصحة المسار (v9) | G9 |
| [`Reports-states.dc.html`](boards/Reports-states.dc.html) | التقارير · الحالات | G9 |
| [`Report-stores.dc.html`](boards/Report-stores.dc.html) | مقترح · المبيعات حسب المتجر (v9) | RT-996 (proposal; needs contract) |
| [`Platform.dc.html`](boards/Platform.dc.html) | المنصة · المؤسسات وجلسة الدعم (v9) | G10 |
| [`Platform-states.dc.html`](boards/Platform-states.dc.html) | المنصة · شريط جلسة الدعم والحالات | G10 |
