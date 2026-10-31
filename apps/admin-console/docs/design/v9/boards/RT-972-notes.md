# RT-972: v4.0 boards for Console screens not built yet

These are planning boards only. They change no code. RT-972 asked for v3 mockups; on 2026-10-31 the
owner decided they are drawn in the v4.0 «Ink & Receipt» look instead (DESIGN.md §12, Confluence
RETAIL 62816260).

- **Format.** Same `.dc.html` format as the other files in this folder. The canvas runtime
  (`support.js`) is not included, so read them for layout, copy, tokens and states.
- **Not on the canvas.** These boards are not on the v9 canvas, so they are not in
  [`../README.md`](../README.md)'s index of canvas copies.
- **Rules win.** Where a board and `DESIGN.md` §12 differ, `DESIGN.md` wins. A board decides no
  behaviour; the linked issue and its contract do.
- **Copy.** Text marked «نص جديد», and any text that is not a shipped key, still needs a message
  key (UX-12).
- **Placeholders.** A dashed box or a grey dashed tag marks a placeholder: a field or value that no
  issue or contract names yet. Each placeholder points to an open question below. It is never a
  proposed field.
- **v3 artboards.** The v3 canvas (`NvG61RAVXHdy2gjFgX3sZK`) could not be opened from the account
  that drew these boards. Scope therefore comes from the Jira issues, the contracts on `main` and
  the v3 notes posted on RT-827, RT-455 and RT-807 on 2026-10-30.

| Board | For | Screen |
| --- | --- | --- |
| [`Product-create.dc.html`](Product-create.dc.html), [`Product-create-states.dc.html`](Product-create-states.dc.html) | RT-827 | Product create form and its 15 states |
| [`Tracking-holds.dc.html`](Tracking-holds.dc.html), [`Tracking-holds-states.dc.html`](Tracking-holds-states.dc.html) | RT-455 | Tracking holds, recall, resolution queue and health tabs |
| [`Password-change.dc.html`](Password-change.dc.html), [`Password-forgot.dc.html`](Password-forgot.dc.html), [`Password-states.dc.html`](Password-states.dc.html) | RT-807 | Change password (signed in) and forgot password (public) |
| [`Inventory-item.dc.html`](Inventory-item.dc.html), [`Inventory-item-states.dc.html`](Inventory-item-states.dc.html) | W3, no issue yet | Tracking identity (batch or serial) detail |

## 1. Product create (RT-827)

**Sources:**

- the merged brief [`../../rt827-product-create/README.md`](../../rt827-product-create/README.md),
  whose copy and keys are reused verbatim;
- RT-752 AC 3 (the fields);
- `console-catalog.yaml` `consoleCreateCatalogProduct`;
- the owner decisions of 2026-10-29: D9 hold, OD-2, OD-3 «إضافة صنف», OD-4 manual retry.

**Primary actions:**

| Region | Primary |
| --- | --- |
| List band | «إضافة صنف» (Mint on Ink) |
| Form | «إنشاء الصنف» (Ink) |
| Landing page | «تعديل الصنف» stays the header action; «إضافة باركود أو SKU» sits in the success banner |

**States drawn:**

- entry and empty list;
- loading;
- categories failed;
- blocked:
  - a read-only role;
  - 404;
- submitting;
- the write failures:
  - 400 key;
  - 409 conflict;
  - 425 countdown;
  - 422 category;
  - an unknown outcome;
  - 429;
- the landing page;
- the conditional OD-2 variant.

**v4.0 applied:**

- the Ink sidebar;
- the D-V9 list band with a Mint primary;
- the Ink aside «ماذا يحدث بعد الإنشاء»;
- the Ink primary on the light form.

No receipt card is drawn: §12.2 limits receipt cards to KPI cards and the payment summary.

**Open questions:**

- **PC-1.** The price field once a price write exists. D9 holds create until then, so the board
  draws price as a placeholder, not «بلا سعر». Which field, and its contract, follow RT-484/485's
  implementation.
- **PC-2.** RT-827 stays blocked by D9. The board describes the route once it opens. Nothing here
  changes D9.
- **PC-3.** The wording of the OD-2 read-only availability line. It applies only if create ships
  before a price write.
- **PC-4.** The categories-failed text for create. The shipped `catalog.form.categoriesFailed` says
  «تبقى الفئة الحالية كما هي», which is right for edit, not create.

## 2. Tracking holds and recall (RT-455)

**Sources:**

- `inventory.yaml` 1.8.0-draft (RT-449):
  - `listInventorySafetyFindings`;
  - `getTrackingHold`;
  - `placeQualityHold`;
  - `releaseTrackingHold`;
  - `createInventoryRecall`;
  - `getInventoryRecall`;
- `inventory-safety-feed.yaml`;
- RT-455's scope.

**Primary actions:**

| Region | Primary |
| --- | --- |
| List band | «تسجيل استدعاء» (Mint) |
| Hold drawer | «رفع الحجز» (owner only) |
| Recall drawer | «تسجيل الاستدعاء» |
| «منتهية وقابلة للبيع» tab | «نقل إلى منتهي الصلاحية», which opens the existing status move |

**Roles:**

- Release is owner only. A tenant_admin sees the button recessed, with the reason.
- Placing a hold and creating a recall are for owner or tenant_admin.
- A store_manager only reads findings for its own stores.

**Band facts.** The findings list is not paged, so the band can count the whole set:

- active holds;
- expired-but-sellable lots;
- `generatedAt`.

**Drawn as unavailable, with the reason:**

- **The «قريبة الانتهاء» tab.** `expiring_lot` is reserved and never emitted in 1.8.0 (RT-50 B1). It
  is never shown as zero.
- **The «قائمة الحل» tab.** Its fields are placeholders only.

**Open questions:**

- **TR-1.** The route and the navigation entry. The board puts «الحجز والاستدعاء» under الكتالوج
  والمخزون.
- **TR-2.** The Tracking Resolution queue. `tracking_unresolved` and the bind command have no
  contract on `main` (RT-451 is To Do). Every field in that tab is a placeholder.
- **TR-3.** Sold-under-hold findings, tracking-consistency findings, and a list of released holds
  or past recalls. None has a contract. The contract reads one hold or one recall by id; active
  holds exist only as findings.
- **TR-4.** Who placed a hold. `placedBy` and `createdBy` are internal user ids, and no contract
  resolves them to a name.
- **TR-5.** The reason codes offered in the pickers. `SafetyReasonCode` is a pattern, not a list.
  `supplier_notice`, `authority_notice` and `label_misprint` are the contract's own examples.
- **TR-6.** The server signal that the tenant has tracked products. The section is hidden without
  one (RT-455 item 5, decisions 967 and 968).
- **TR-7.** Names of products and stores. Findings carry `tenantProductRef` and `storeIds` only. The
  board shows names read from the catalog and the store list. A batch read for this is not decided.

## 3. Change and forgot password (RT-807)

**Sources:**

- RT-807;
- `auth.openapi.yaml`:
  - `changePassword`;
  - `requestPasswordReset`;
  - `confirmPasswordReset` (RT-937);
- the shipped `AuthLayout` and the `auth.*` keys.

**Primary actions:**

| Screen | Primary |
| --- | --- |
| Change password | «تغيير كلمة المرور» |
| Forgot password | «إرسال الرابط» |
| Reset completion | «تعيين كلمة المرور» |

**Fields.** Change password has only the current and the new password, as RT-807 names them. The
v3 artboard's confirm field is not in the issue or the contract, so it is left out (PW-4).

**States drawn:**

- **Change password:**
  - 400 is one generic refusal, so a wrong current password and a rejected new password cannot be
    told apart;
  - 409 is blocked with a reason: no identity link;
  - 429 per user;
  - 503 provider down;
  - 401;
  - success says the other sessions were signed out and this one stays open.
- **Forgot password:** the same confirmation for every address (202).
- **Reset completion:** conditional; it needs RT-793's lab proof.

Invite acceptance, RT-807 item 4, is not drawn here.

**Open questions:**

- **PW-1.** Where change password lives. The board draws a «حسابي» page reached from a new entry
  in the user menu (RT-969), which today holds only preferences.
- **PW-2.** The password rules. The provider defines them, so the board shows no strength meter and
  no rule list until the provider publishes them.
- **PW-3.** Reset completion: hosted by Descope, or a minimal Console page. The contract's
  `minLength: 12` may change with RT-937.
- **PW-4.** Whether to add a "confirm new password" field. It is not in RT-807.
- **PW-5.** The colour of the public brand panel. §12.1 does not list it as an expressive surface.
  It is drawn flat on Ink, without the grid or glow, as a proposal. The shipped panel is deep teal.

## 4. Inventory item detail (W3)

**What this board is.** The v4.0 board `Inventory-product.dc.html` already covers the store product
page (balance, status breakdown, status move, batch table). This board is the gap below it: the
detail of one batch or serial, opened from that batch table.

**Sources:**

- `TrackingIdentity` (`listTrackingIdentities`);
- `TrackingHold`;
- `placeQualityHold`;
- `correctTrackingIdentityExpiry`;
- the `expired_lot_sellable` finding.

**Primary actions:**

| Region | Primary |
| --- | --- |
| Hero band | «وضع حجز جودة», or «رفع الحجز» for the owner while a hold is active |
| Expiry correction form | «تسجيل التصحيح» |

**Roles.** Identity reads are for owner and tenant_admin. Any other role gets a 404 that does not
say why.

**Open questions:**

- **II-1.** Confirm the scope and the route. The board assumes this, not a second store-product
  page, is the item detail RT-972 meant.
- **II-2.** Stock of one batch per store and status. `getOnHand` is per product, not per identity,
  so this is a placeholder.
- **II-3.** A batch's hold history. There is no list read, so this is a placeholder.
- **II-4.** The expiry correction history. The server keeps it, but there is no read contract, so
  this is a placeholder.
