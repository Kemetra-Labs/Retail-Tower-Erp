# RT-827: product create, design brief

Work item: Jira **RT-827** (Admin-Console, Implementation). This file is the **design brief** that
comes before it: the screens the create flow needs, every state, and the copy for each. Nothing here
changes `src/`, a contract or a pin.

- **Status: draft for owner review, 2026-10-29.** Brief, frames and copy are proposals. Nothing here
  is owner-approved yet. The canvas is «RT-827 Product Create»
  (<https://claude.ai/artifact/TifcPJh6V6PjqciYHwufoU>, private to the owner); the frames are
  `78-…` to `88-…` in [`design/screens/`](../../../design/screens/README.md).
- **Implementation is still blocked.** Owner decision D9 (RT-768 comment 13487, 2026-10-22) chose
  option (b): edit and retire ship, create waits for a price write. RT-484 and RT-485 now read Done,
  but both are planning tickets. On `main` `471d81f7` no contract under
  `services/backend-core/packages/contracts/openapi/` has an operation that writes a price, and
  `consoleCreateCatalogProduct` says the new product "has no price (O-2)". RT-827 comment 14055
  (2026-10-27) records the owner's "keep blocked". These frames are the UI reference the build needs
  once that changes. RT-827's status is unchanged.

## 0. Sources

| Source | What it fixes |
|---|---|
| Jira RT-827 | Scope: create form on `POST /products`, Idempotency-Key once per attempt, 425 retry after `Retry-After`, land on detail with an "add a barcode / SKU" prompt, CTA for owner and tenant_admin only |
| Jira RT-752 comment 13117, AC 3 | The field contract (name, description, category, tax category, tenant availability, price as read-only text), write mechanics, the multi-error summary |
| RT-752 comment 13119 | D5 (trim the ends of name and tax category, block whitespace-only), D7 (summary on any blocked submit of a full-page form), D9 still open at the time |
| RT-768 comment 13487 | D9 decided as (b): create held until a price write exists |
| RT-752 AC 2 and AC 4 | Route `/catalog/products/new`; create lands on detail; the dataset-empty list carries the CTA for owner and tenant_admin |
| `services/backend-core/packages/contracts/openapi/catalog/console-catalog.yaml` (`1.1.0-draft`) | `consoleCreateCatalogProduct`: `CreateCatalogProductRequest`, `Idempotency-Key` (16 to 128 printable ASCII), 201 and its replay, 400 / 401 / 403 / 404 / 409 / 422 / 425 / 429 / 500 |
| `src/catalog/ProductFormFields.tsx`, `ProductEditForm.tsx`, `productFormLogic.ts`, `CatalogProductEdit.tsx` | The shipped edit form this reuses: fields, validation, banners, error summary, the route frame |
| `src/components/FormErrorSummary.tsx` | The shared error summary (RT-768) |
| `src/unknown-items/unknownItemIdempotency.ts` | The key pattern: one key per request body, reused on a retry of the same body; only a 425 or a retryable 5xx keeps the key; nothing retries on its own |
| `DESIGN.md`, `PRODUCT.md`, `design/claude-design-system/` | Tokens, button variants, copy grammar, RTL and focus rules |
| `design/screens/README.md` | Export rules: 1440 and 1280 wide, `-a`/`-b` parts under 180 KB, mock data only |

## 1. Purpose and primary action

A tenant `owner` or `tenant_admin` adds a new item to the tenant catalog. The item gets its name,
description, category, tax category and tenant availability here. Its identifiers (barcode, SKU) are
added afterwards on the item page, and its price cannot be set in the console at all.

**Primary action:** create the item once, then go straight on to give it a barcode or SKU. Two
things the page must make plain: the item will exist without a price, and a retry never creates it
twice.

## 2. Placement and access

- **Entry, list header:** «إضافة صنف» (`.btn-primary`) in the header actions of the catalog list
  (`/catalog/products`, `CatalogProductList`). It is a link to the create route, not a nav item
  (RT-752 AC 2).
- **Entry, empty catalog:** the dataset-empty state of the same list carries the same «إضافة صنف»
  (RT-752 AC 4). While the catalog is empty the header button is not shown, so the page has one
  primary. The filtered-empty state does not carry it: it offers «مسح عوامل التصفية» as today.
- **Who sees it:** `owner` and `tenant_admin` only, the API's write roles (`canWriteCatalog`). For
  `store_manager` neither button is rendered and the list keeps today's read-only subtitle.
  `store_staff` does not reach the list at all: the catalog reads are for `owner`, `tenant_admin`
  and `store_manager`, so the catalog routes show their non-disclosing "not available" state
  (`canReadCatalog`). `canWriteCatalog` only decides what is shown; the server authorizes.
- **Route:** `/catalog/products/new`, title «إضافة صنف». «الأصناف» stays the selected nav entry.
  Opening the route directly:
  - without a tenant in scope: the scope prompt, as on the other catalog routes;
  - as `store_manager`: a read-only notice and a way back, no form (the `CatalogProductEdit`
    pattern);
  - as `store_staff`, or any role the catalog refuses: the "not available" state
    (`catalog.detail.unavailable`), as `CatalogProductEdit` does;
  - the server's own refusal of a wrong role is the non-disclosing 404.
- **Wording.** The task asked for «إضافة منتج». The shipped catalog follows the UX-12 glossary
  (Retail Item → «الصنف»): the nav entry is «الأصناف», the edit button «تعديل الصنف». The frames use
  «إضافة صنف» to match; open decision OD-3 (§9).

## 3. Page structure

One column, RTL, the same frame as the edit route: back link «العودة إلى الأصناف», title, subtitle,
then the form. Sections are headings with spacing, not cards (DESIGN.md §5).

1. **Not-sellable notice (proposal, OD-2).** A warning notice (icon and text) between the header and
   the form, so it is read before any typing: the item will have no price, and the POS will not sell
   it until a price is set. Drawn on every form frame and labelled «مقترح» in the frames.
2. **Banner slot.** Context errors (400, 409, 425, 500, network, 403, 404, 429) are one `Banner`
   above the form, never entries in the summary (RT-768 rule).
3. **Error summary.** `FormErrorSummary` at the top of the form, on any blocked submit (D7).
4. **«بيانات الصنف»** with the fields of §4, in contract order.
5. **Actions.** «إنشاء الصنف» (`.btn-primary`, the only primary) and «إلغاء» (`.btn-secondary`,
   back to the list), on the divided action row the edit form uses.

**Leaving with typed values** uses the unsaved-work guard (`src/shell/dirty-guard.tsx`, RT-268). A
created item leaves with `SAVED_NAVIGATION`.

## 4. Fields (RT-752 AC 3, unchanged)

`CreateCatalogProductRequest` takes `name` and `taxCategory` (required), `description`,
`categoryId` and `isActive`. Nothing else may be sent: a price or any unknown key is 400
`validation_error`.

| Field (wire) | Input | Normalisation | Prevent (client) | Server → where it shows |
|---|---|---|---|---|
| الاسم `name` (required) | Text, `dir="auto"` | Trim the ends (D5) | Required, not whitespace-only, at most 500 characters | 400 `validation_error` → banner (no field pointer, G9) |
| الوصف `description` | Textarea, `dir="auto"` | Empty or whitespace-only → `null` (`minLength: 1`) | At most 2000 characters | 400 → banner |
| الفئة `categoryId` | `<select>`: «بدون فئة» plus `consoleListCatalogCategories` | «بدون فئة» → `null` | — | 422 `category_unavailable` → **field error** in the summary and inline; the categories are read again; the refused option stays selected and marked «(غير متاحة)» until another is chosen |
| فئة الضريبة `taxCategory` (required) | Text, `dir="ltr"`, `spellcheck=false`, `autocomplete=off`, mono | Trim the ends (D5) | Required, at most 50 characters | Free text with no registry (G2); the hint explains the format |
| متاح للبيع افتراضيًا `isActive` | Checkbox, **checked by default** (contract default `true`) | — | — | — |
| السعر (display only) | Read-only text «بلا سعر», not a disabled input | — | — | No write exists (O-2, G1) |
| التتبع (display only) | Read-only text «بلا تتبع» | — | — | A new item starts with the `none` profile |

The create form differs from the edit form only where the contract does: no `expectedUpdatedAt`, no
retired-category option, no "only what changed" patch (the whole body is sent), and the read-only
tracking row, because a new item has no history to show.

**Validation timing** follows RT-768 as shipped: nothing is in error before the first submit, and
there is no check on blur. After a blocked submit every error shows in the summary and inline, and
each clears live as it is fixed.

## 5. Write mechanics

- **One key per request body** (`reuseOrNewKey`). The body's fingerprint is the trimmed values that
  are sent. A retry of the same body reuses the key, so the server replays the `201`
  (`Idempotent-Replayed: true`) instead of creating a second item. A different body gets a new key.
- **The fields are locked while an attempt is unsettled:** while submitting, while a 425 is
  counting down, and after a 500 or a lost response. Editing then would change the fingerprint and
  mint a new key, and the earlier attempt may already have created the item. The fieldset is shown
  read-only, the summary is not shown, and the reason for the lock is in the banner, next to what
  the operator reads first.
- **«إلغاء» stays available**, also while an attempt is unsettled: leaving mints no key. Leaving
  then goes through the unsaved-work guard, which says the item may still be created (§7.3).
- **Which outcomes keep the key** (`keepsKey`): 425, 500, and no response. Every other failure is
  final for its key; the next submit mints a new one. A 429 also holds the next submit until its
  `Retry-After` wait ends (the shared `RateLimitBanner`, §7.3).
- **425 `idempotency_in_progress`:** the body carries `retryAfterSec` (integer, at least 1) and the
  `Retry-After` header the same. The banner counts down; «إعادة المحاولة» is unavailable (recessed,
  `aria-disabled`) until zero, then sends the same key and body. **Nothing retries on its own**,
  matching `unknownItemIdempotency.ts`. This is a design assumption the owner can overrule (§9).
- **500 or no response:** the outcome is unknown. The banner says so, offers «إعادة المحاولة»
  (same key and body: safe, because a created item is replayed, not duplicated) and «تعديل القيم»
  (unlocks the fields; the next submit gets a new key, so the banner first asks the operator to check
  the list).
- **Success (201, or its replay):** go to `/catalog/products/:productId` with a success banner.
  Focus moves to the item's title, as the detail page already does.
- **Create is not atomic with identifiers** (RT-752 AC 3): the item exists first; identifiers are
  added on the detail page, so an `alias_conflict` there never hides the created item.

## 6. Frames to draw

Arabic, light theme, mock data only, at **1440** and **1280**. Numbering continues after `77`
(frame `77` belongs to RT-930). English and dark are a later pass.

| # | Frame file (1440; `-1280` for the second width) | State |
|---|---|---|
| A | `78-product-create-entry.png` | Catalog list, owner: «إضافة صنف» in the header actions; writer subtitle |
| B | `79-product-create-entry-empty.png` | Catalog list with no items, owner: the empty state with «إضافة صنف» |
| C | `80-product-create-empty.png` | Create form, nothing typed; the not-sellable notice (proposal) |
| D | `81-product-create-filled.png` | Create form filled in, ready to send |
| E | `82-product-create-invalid.png` | Blocked submit: error summary with two entries, inline errors on name and tax category |
| F | `83-product-create-submitting.png` | Sending: spinner on «إنشاء الصنف», fields locked |
| G | `84-product-create-key-rejected.png` | 400 `idempotency_key_required` / `idempotency_key_malformed`: banner, fields editable |
| H | `85-product-create-key-conflict.png` | 409 `idempotency_key_conflict`: banner with a link to the list, typed values kept |
| I | `86-product-create-in-progress.png` | 425: countdown banner, retry unavailable, fields locked |
| J | `87-product-create-category-unavailable.png` | 422 `category_unavailable`: field error in the summary and inline, option marked unavailable |
| K | `88-product-create-created.png` | Landed on the new item: success banner with «إضافة باركود أو SKU», no-price notice, identifiers prompt |
| L | (reuse `18-no-access.png` and the edit route's read-only notice) | Not a catalog writer |

A frame taller than one 180 KB file is split into `-a` and `-b` parts, top to bottom. At 1280 the
parts are named `NN-…-a-1280.png`, `NN-…-b-1280.png`.

## 7. Copy

Errors follow DESIGN.md §8: what happened, whether anything changed, what to do. Numbers are
Western digits, isolated LTR (`<bdi>`). **Key** names the shipped message key the implementation
reuses; **new** marks proposed text.

### 7.1 Entry and page

| Place | Arabic | English | Key |
|---|---|---|---|
| List CTA, header and empty state | إضافة صنف | Add item | new `catalog.create.start` |
| List subtitle for a writer | الأصناف المسجَّلة في {tenant}. | The items catalogued in {tenant}. | new `catalog.list.subWriter` (today's `catalog.list.sub` ends «للقراءة فقط», wrong for a writer) |
| Empty list, writer hint | أضف أول صنف إلى الكتالوج، ثم أضف له باركود أو SKU. | Add the first item to the catalog, then give it a barcode or SKU. | new `catalog.list.emptyHintWriter` (the shipped hint «تظهر الأصناف هنا بعد وصولها إلى الكتالوج» stays for readers) |
| Page title | إضافة صنف | Add item | new `catalog.create.title` |
| Subtitle | يُضاف الصنف إلى كتالوج {tenant}، لكل المتاجر. | The item is added to the {tenant} catalog, for every store. | new `catalog.create.sub` |
| Back link | العودة إلى الأصناف | Back to items | `catalog.detail.back` |
| Section | بيانات الصنف | Item details | `catalog.edit.section` |
| Submit | إنشاء الصنف | Create item | new `catalog.create.submit` |
| Cancel | إلغاء | Cancel | `common.cancel` |
| Read-only role | يمكنك عرض الأصناف دون إضافتها. · إضافة الأصناف متاحة لمالك المؤسسة ومسؤولها. | You can view items but not add them. · Adding items is for owners and tenant admins. | new `catalog.create.readOnly`, `catalog.create.readOnlyHint` |

### 7.2 Fields

All field labels, hints and client errors are the shipped `catalog.form.*` keys: «الاسم»,
«الوصف», «الفئة», «بدون فئة», «فئة الضريبة» with `catalog.form.taxCategoryHint`, «متاح للبيع
افتراضيًا» with `catalog.form.availabilityHint`, «السعر», the `catalog.form.error.*` texts and
`components.errorSummary.title` (plural: «خطآن يحتاجان إلى إصلاح»). New:

| Place | Arabic | English | Key |
|---|---|---|---|
| Price row value | بلا سعر | No price | `catalog.value.noPrice` |
| Price row hint | لا يُحدَّد السعر من لوحة التحكم. | Prices are not set in the console. | new `catalog.create.priceHint` (the edit form's «لا يُعدَّل السعر من هنا» says "edit") |
| Tracking row | التتبع: بلا تتبع | Tracking: None | `catalog.detail.field.tracking`, `catalog.tracking.none` |
| Not-sellable notice (proposal, OD-2) | سيُنشأ الصنف بلا سعر. لا تبيع نقطة البيع صنفًا بلا سعر، ولا يمكن تحديد السعر من لوحة التحكم بعد. | The item will be created without a price. The POS does not sell an item with no price, and prices cannot be set in the console yet. | new `catalog.create.noPriceNotice` |

### 7.3 Failures of the create

| Code (HTTP) | Arabic | English | Key |
|---|---|---|---|
| `idempotency_key_required`, `idempotency_key_malformed` (400) | لم يقبل الخادم طلب الإنشاء لخلل في لوحة التحكم، فلم يُنشأ أي صنف. أعد المحاولة. إذا تكرر ذلك فأبلغ الدعم برقم الطلب. | The server refused the create because of a console fault, so no item was created. Try again. If it happens again, give support the request ID. | new `catalog.create.error.key` |
| `validation_error` (400) | رفض الخادم هذه القيم، فلم يُنشأ أي صنف. راجع الاسم والوصف وفئة الضريبة ثم حاول مرة أخرى. | The server rejected these values, so no item was created. Check the name, description and tax category, then try again. | new `catalog.create.error.validation` |
| `idempotency_key_conflict` (409) | تعارض هذا الطلب مع محاولة سابقة، فلم يُنشئ هذا الطلب أي صنف. ربما أنشأت المحاولة السابقة الصنف: ابحث عنه في قائمة الأصناف قبل أن تحاول مرة أخرى. ما كتبته محفوظ في النموذج. | This request clashed with an earlier attempt, so it created nothing. The earlier attempt may have created the item: look for it in the item list before you try again. What you typed is kept. | new `catalog.create.error.keyConflict`; action «عرض الأصناف» / "View items" |
| `idempotency_in_progress` (425) | لا يزال طلب الإنشاء السابق قيد المعالجة، ولم يُنشأ صنف ثانٍ. يمكنك إعادة المحاولة بعد {seconds} بالقيم نفسها. الحقول مقفلة حتى ذلك الحين، حتى لا يُرسل طلب جديد. | The earlier create is still being processed, and no second item was created. You can try again in {seconds} with the same values. The fields are locked until then, so that no new request is sent. | new `catalog.create.error.inProgress`; `{seconds}` plural («3 ثوانٍ», «ثانية واحدة») |
| 425, button while counting | إعادة المحاولة بعد {seconds} | Try again in {seconds} | new `catalog.create.retryIn` |
| 425, button at zero | إعادة المحاولة | Try again | `catalog.detail.retry` |
| `category_unavailable` (422) | هذه الفئة لم تعد متاحة. اختر فئة أخرى أو اترك الصنف بدون فئة. | This category is no longer available. Choose another category, or no category. | `catalog.form.error.categoryUnavailable` |
| 500, or no response | لم يصل ردّ مؤكَّد من الخادم، فقد يكون الصنف قد أُنشئ. أعد المحاولة بالقيم نفسها: إن كان قد أُنشئ فستنتقل إليه ولن يُنشأ مرة ثانية. | The outcome of the request is unknown, so the item may have been created. Try again with the same values: if it was created, you go to it and it is not created twice. | new `catalog.create.error.unknown`; actions «إعادة المحاولة», «تعديل القيم» / "Edit values" |
| Leaving while an attempt is unsettled (unsaved-work guard) | قد يُنشأ الصنف حتى لو غادرت الآن. ابحث عنه لاحقًا في قائمة الأصناف قبل أن تضيفه مرة أخرى. | The item may still be created if you leave now. Look for it in the item list before you add it again. | new `catalog.create.leaveUnsettled` |
| After «تعديل القيم» | ستُرسل القيم المعدّلة طلبًا جديدًا. تأكد أولًا من قائمة الأصناف أن الصنف لم يُنشأ. | Changed values are sent as a new request. Check the item list first that the item was not created. | new `catalog.create.editAfterUnknown` |
| `origin_rejected` (403) | The shipped `catalog.write.error.origin` | | `catalog.write.error.origin` |
| `not_found` (404) | ليست لديك صلاحية إضافة أصناف في هذه المؤسسة. | You cannot add items in this organization. | new `catalog.create.error.notFound` (the shipped key says "this item") |
| `rate_limited` (429) | The shared `RateLimitBanner` (RT-621): its countdown from `Retry-After`, then «you can try again now». «إنشاء الصنف» stays unavailable until the wait ends; the fields stay editable. Nothing was written, so the next submit gets a new key | | `rateLimit.wait`, `rateLimit.ready` |
| `unauthorized` (401) | The shipped text, then the sign-in redirect | | `catalog.write.error.session` |

The shipped `catalog.write.error.server` («ولم يُحفظ شيء») is **not** reused for the create: after a
500 or a lost response the item may exist.

### 7.4 After the create

| Place | Arabic | English | Key |
|---|---|---|---|
| Success banner | أُنشئ الصنف {name}. أضف له باركود أو SKU ليتعرّف عليه الكاشير عند المسح. | {name} was created. Give it a barcode or SKU so the cashier can scan it. | new `catalog.create.done` |
| Success banner action | إضافة باركود أو SKU | Add a barcode or SKU | new `catalog.create.addIdentifier` (opens the RT-769 identifier drawer) |
| Identifiers, none yet, writer | لا توجد معرّفات بعد. أضف باركود أو SKU ليتمكّن الكاشير من مسح هذا الصنف. | No identifiers yet. Add a barcode or SKU so the cashier can scan this item. | new `catalog.detail.identifiers.emptyWriter`, with the shipped «إضافة معرّف» |
| Price, no price | بلا سعر, and «لا يوجد سعر: لن تبيع نقطة البيع هذا الصنف حتى يُحدَّد له سعر.» | | `catalog.value.noPrice`, `catalog.detail.noPriceNotice` |

The identifiers prompt is not tied to the create: it shows for a writer whenever the item has no
active identifier, so it stays true on a later visit.

## 8. Design rules that apply

- Role tokens only (`colors_and_type.css`, `components.css`, `src/styles/tokens.css`).
- One primary per context: «إضافة صنف» on the list, «إنشاء الصنف» on the form. On the landing the
  shipped «تعديل الصنف» stays the header primary; the next step sits in the success banner.
- Notices and errors carry an icon and text, never colour alone; checked in forced colours.
- An unavailable control is recessed (dashed border, `aria-disabled="true"`), never hidden, and says
  why next to it.
- Locked fields read as read-only, with their values legible; they are not greyed out of contrast.
- Logical CSS properties; RTL by structure; visual order and tab order match.
- The tax category is machine text: LTR, mono, isolated.
- Motion: banners and the summary settle in on Signal (150ms), zero under reduced motion. The
  countdown changes text only, once a second, and is announced politely at its start and at zero,
  not every second.

## 9. Open decisions (owner)

| # | Decision | Options | State |
|---|---|---|---|
| D9 | Revisit D9: ship create before a price write exists? | (a) ship create with the not-sellable notice; (b) keep holding create until a price write ships (current decision, RT-768 13487, reaffirmed in RT-827 14055) | **Owner.** These frames do not assume either: they are the reference for whenever create ships. |
| OD-2 | The not-sellable notice | Wording; placement (drawn: a warning notice above the form; or only the price row; or a confirm step on submit); tone (warning drawn; or information); whether «متاح للبيع افتراضيًا» stays checked by default on an item that cannot be sold yet (drawn: the shipped label and contract default, unchanged). The same tension shows on the shipped detail page (frame 88): «التوفر على مستوى المؤسسة: متاح للبيع» sits two rows above «بلا سعر» | **Owner.** Drawn as a proposal and labelled «مقترح» in the frames. |
| OD-3 | CTA wording | «إضافة صنف» (drawn; UX-12 glossary, matches «الأصناف» and «تعديل الصنف») or «إضافة منتج» (as the task text) | Owner, minor |
| OD-4 | 425 retry | Manual retry after the countdown (drawn; matches `unknownItemIdempotency.ts`) or one automatic retry with the same key | Recommendation: manual. Owner may overrule. |

## 10. Export

- The canvas is «RT-827 Product Create» (a Design canvas in Claude). It has one page component,
  `ProductCreatePage.dc.html`, with a `state` property, and one artboard per state.
- Each state was rendered from that component to static HTML with the design-system CSS in
  `design/claude-design-system/`. A small stand-in for the canvas runtime ran the component's
  `renderVals()` and resolved its `sc-if` blocks and `{{…}}` holes. The pages were captured with
  Chromium at 1440 and 1280 wide into `apps/admin-console/design/screens/`.
- Check each PNG: signature, closing `IEND`, a full decode at its stated size, under 180 KB.
- Add a row per frame to `design/screens/README.md`.

## 11. Review record

Shaped on 2026-10-29 with the Admin Console `impeccable` skill (`shape`, product register). No owner
was available for the discovery round, so it was answered from RT-827, RT-752 AC 2 to AC 4, RT-768
and the contract, and the assumptions are listed in §9. Visual direction was not explored: the page
reuses the shipped edit form and list.

Drawn as a proposal, not decided (OD-2): the not-sellable notice above the form, so it is read
before typing.

Decisions taken while shaping:

- The create reuses the edit form's fields, summary and banners. It differs only where the contract
  does.
- The fields lock while an attempt is unsettled, so a retry can never mint a second key by accident.
- 500 and a lost response say the item *may* exist, and point to a safe retry.
- 409 sends the operator to the list before retrying.
- The empty catalog gets a writer variant of its hint, and the list gets a writer subtitle.

The `critique` pass on the exported frames is recorded in §12.

## 12. Critique of the frames

`impeccable critique`, 2026-10-29, on the 1440 frames. Method: the design review ran in an isolated
subagent. The detector (`impeccable detect`) ran on `ProductCreatePage.dc.html` separately, and its
output was not shared with the review. **Heuristic score: 25/40 (Acceptable).** The lowest scores
were user control (2), error prevention (2), efficiency (2), minimalism (2) and help (2).

Fixed in the frames:

| Finding | Severity | Change |
|---|---|---|
| 425: the reason for the locked fields was small grey text at the end of the action row, far from focus | P1 | The reason is now in the banner body (frame 86, §7.3) |
| «إلغاء» was unavailable while sending and during the 425 wait, so the operator could not leave | P2 | «إلغاء» stays available; leaving goes through the unsaved-work guard with its own copy (§5, §7.3) |
| One circle icon for danger, warning and info banners: the tone read by colour alone | Accessibility | One icon per tone (frames 84, 85, 86) |
| Detector: the artboard's `a:hover` rule turned a link styled as the primary button dark-on-teal (2.1:1) | Contrast | The link rule now skips `.btn` (canvas only; static frames show no hover) |
| Detail header button far from the 820px content; form header wider than the form; locked checkbox looked active; empty space under the content | Layout | Fixed before the first export |

Not changed, and why:

- **P0, gated on OD-2:** the form lets an operator create an item that cannot be sold, and
  «متاح للبيع افتراضيًا» stays checked next to a notice that says so. Changing the default, or
  replacing the checkbox with a read-only line, is the owner's decision (OD-2), so the frames keep
  the shipped label and the contract default.
- **P1, part of OD-2:** the notice is the loudest element on an empty form, and its «مقترح» label
  sits inside the product UI. The label marks a proposal in the design record and must not ship.
  Tone and placement are OD-2.
- **P2:** on a failure the notice and the failure banner stack above the form (frames 84 to 86).
  The notice keeps its place so the form never jumps.
- **P3:** the Arabic tax-category hint gives no example. The shipped English hint has one
  ("for example standard"); the Arabic key `catalog.form.taxCategoryHint` does not. This is a
  shipped copy gap, outside this brief.
- **Efficiency:** there is no "create and add another" and no create-then-barcode in one step.
  The contract keeps identifiers apart from the create (RT-752 AC 3); a faster loop would be a
  separate request.
- **Detector false positives:** five "cramped padding" hits on `.banner`, `.error-summary`,
  `.shell__scope` and the focused title, and one "dark glow". They come from the unrendered source;
  the rendered frames carry the design-system padding, and the page is light.

Not drawn: English, dark and forced-colours frames. The RT-827 acceptance criteria require Arabic
and English, forced colours and axe in Playwright, so those come with the build.
