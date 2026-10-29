# RT-474: tenant logo screen, design brief for Claude Design

Work item: Jira **RT-474** (Admin-Console, Implementation). This file is the **design brief** that
comes before it: what to draw in the Retail Tower Design System project in Claude Design, and how to
export it. Nothing here changes `src/`, a contract or a pin.

- **Status: approved 2026-10-29 (owner), brief and Arabic copy.** Reviewed with `impeccable shape`
  against `DESIGN.md` and `PRODUCT.md` before approval (§10).
- **Implementation is still blocked.** Owner decision 2026-10-23 (RT-474 comment 13574): RT-474
  waits for RT-473 S2 (the runtime), so it can be verified against real endpoints. These designs
  are the UI reference that slice needs, per the freeze rule.

## 0. Sources

| Source | What it fixes |
|---|---|
| Jira RT-474 | Scope: one upload field, server-rendered screen and receipt previews, warnings that never block saving, remove with a confirm step, tenant admins only |
| Jira RT-472 D-1…D-3, comments 11845 and 11846 | One logo per tenant; the receipt logo is derived automatically; no light variant; tenant brand first, Retail Tower secondary |
| Jira RT-473 S1 (Backend-Core `ddae78a`, #761) | `services/backend-core/packages/contracts/openapi/tenant-branding.openapi.yaml`: operations, codes, warnings, revision rules |
| RT-473 comment 13662 / RT-832 (POS #821) | The approved slot boxes, the white card, the powered-by line «بدعم من Retail Tower»: `apps/pos/docs/design/vnext/31-rt832-logo-slot-references.md` |
| `apps/admin-console/DESIGN.md`, `PRODUCT.md` | Tokens, button variants, copy grammar, RTL and focus rules, surface grammar |
| `design/screens/README.md` | Export rules: 1440 wide, split into `-a`/`-b` parts under 180 KB, mock data only |

## 1. Purpose and primary action

A tenant `owner` or `tenant_admin` uploads, replaces or removes the tenant's single logo. Before
saving, they see **exactly** what the POS will show on its four screens and print on the receipt.
The previews are the server's own renditions, never a re-render in the browser.

**Primary action:** confirm that the previewed logo is right, then save it. Everything on the page
serves that one decision.

## 2. Placement and access

- **Route:** `/tenants/:tenantId/branding`, title «هوية المؤسسة». It matches the contract path
  `/api/v1/tenants/{tenant_id}/logo`.
- **Entry:** a «هوية المؤسسة» link on the tenant page (`TenantDetail`, route `tenants/:tenantId`).
  Tenant console users reach that page from the shared «المؤسسات» nav entry (`LIVE_NAV` in
  `src/shell/AppShell.tsx`). It already hosts tenant configuration for the same roles:
  `TenantPolicySection` (cash policy) and `TenantAiPlanSection`, each gated by a role helper
  (`src/cash-policy/policyAccess.ts`). The logo link follows that precedent. It is a link to its
  own route, not an inline section, because the two previews need the full width.
- **Access:** `owner` and `tenant_admin` of that tenant only. For other roles the link is not
  rendered. Opening the URL directly shows the existing no-access screen (`18-no-access.png`); the
  server answers the same non-disclosing `404` for a wrong role and for another tenant.
- Tenant Console only. No `/platform` entry and no support-session access.

## 3. Page structure (one column, RTL, reading measure about 65ch except the previews)

Sections are headings with spacing, not cards (DESIGN.md §5 surface grammar).

1. **Current logo.**
   - With a logo: the logo at small size, «آخر تحديث» with the date and time from `updated_at`, a
     `.btn-secondary` «استبدال الشعار» and a `.btn-danger-quiet` «إزالة الشعار».
   - Without a logo: the empty state (state A) with one `.btn-primary` «رفع شعار».
2. **Upload field.** One labelled file input, PNG or SVG, at most 1 MB, with the requirements line
   from §5.3 under it. The client may pre-check type and size for fast feedback; real validation
   is the server's. Choosing a file calls `consolePreviewTenantLogo` straight away. Choosing
   another file while a preview is running replaces that request; only the latest file is shown.
3. **Screen preview.** One recessed panel that samples the POS light surface. Inside it, the four
   slots at their approved CSS sizes, each with a short label, laid out by size (boot first), not
   as four identical cards:

   | Slot | Box (CSS px) | Label |
   |---|---|---|
   | `boot` | 240×120 | شاشة التشغيل |
   | `pairing` | 200×80 | شاشة ربط الجهاز |
   | `sign_in` | 128×32 | شريط تسجيل الدخول |
   | `lock` | 200×80 | شاشة القفل |

   - Show the server's `scale: 1` rendition in each box, `contain`-fitted, never stretched.
   - The 12px muted line «بدعم من Retail Tower» (name isolated LTR) appears with every slot, where
     RT-832 places it: under the status for boot, at the foot of the card for pairing and lock, and
     at the inline-end of the strip for sign-in. The preview stays faithful to what the POS shows.
   - When `presentation.card` is `true`, draw the logo on the white card: `#fff`, 1px border, 8px
     radius, with the RT-832 padding outside the box. In forced colours the card stays un-forced
     (`forced-color-adjust: none`), as on the POS.
4. **Receipt preview.** A paper strip 80 mm wide with the 1-bit receipt rendition in its header,
   sized at `width_px / dpi × 25.4` mm. Caption: the printed size in mm, and «مقاس تقريبي على
   الشاشة», since screen millimetres are not physical ones.
5. **Actions.** «حفظ الشعار» is the only primary button once a preview exists. It is unavailable
   (recessed, per DESIGN.md §9) until a preview succeeds, and it sends the preview `version` and
   the `expected_revision` the page loaded with. «إلغاء» (`.btn-ghost`) discards the preview and
   returns to section 1.

Warnings (§5.2) sit beside the preview they describe, as `.rtc-alert--warning` with icon and text,
and never make «حفظ الشعار» unavailable.

**Leaving with an unsaved preview** uses the existing unsaved-work guard (`src/shell/dirty-guard.tsx`,
RT-268): save, discard or stay.

## 4. Frames to draw

Arabic, light theme, mock data only. Draw each state at **1440** and **1280**. Numbering continues
after `46`. English and dark are a later pass, as with the platform screens.

| # | Frame file (1440; add `-1280` for the second width) | State |
|---|---|---|
| A | `47-logo-empty.png` | No logo stored (`logo: null`): empty state, requirements line, «رفع شعار» |
| B | `48-logo-current.png` | A logo stored: logo, last updated, replace and remove |
| C | `49-logo-preview-loading.png` | File chosen, preview in progress: skeleton slots and strip, save unavailable |
| D | `50-logo-preview-ok.png` | Preview with no warnings: four slots, receipt strip, save available |
| E | `51-logo-preview-low-contrast.png` | `low_contrast`: every slot on the white card, warning beside the screen preview |
| F | `52-logo-preview-receipt-warnings.png` | `receipt_high_black_coverage` and `receipt_thin_strokes` together beside the receipt preview |
| G | `53-logo-refused-too-small.png`<br>`53-logo-refused-aspect.png`<br>`53-logo-refused-type.png`<br>`53-logo-refused-svg-unsafe.png`<br>`53-logo-refused-too-large.png` | Refusals: inline error on the upload field (`aria-invalid` plus text), no preview, save unavailable, the current logo unchanged |
| H | `54-logo-remove-confirm.png` | Inline remove confirm inside section 1; `.btn-destructive` appears only here |
| I | `55-logo-conflict.png` | `409 logo_changed_concurrently` on save or remove, as a banner above the actions |
| J | `56-logo-saved.png` | Save succeeded: inline success line, section 1 shows the new logo |
| K | (reuse `18-no-access.png`) | Not a tenant admin |

Every frame shows the receipt preview with an **assumed 203 dpi**, labelled «قيمة افتراضية للعرض».
OD-8 (the bench-measured dpi and printable width, RT-110) is still open; the real value comes from
the server's `receipt.dpi` at runtime.

## 5. Copy (owner-approved 2026-10-29)

Errors follow DESIGN.md §8: what happened, whether anything changed, what to do. Numbers, sizes and
ratios are isolated LTR (`<bdi>`), with Western digits.

### 5.1 Refusals (inline on the upload field)

Each refusal message is followed by the same second line: «لم يتغيّر الشعار الحالي.»

| Code (HTTP) | Arabic message |
|---|---|
| `file_type_not_allowed` (422) | نوع الملف غير مدعوم. ارفع صورة PNG أو SVG. |
| `image_malformed` (422) | تعذّرت قراءة الصورة، وقد يكون الملف تالفًا. احفظ الشعار من جديد في برنامج التصميم ثم ارفعه. |
| `image_dimensions_too_large` (422) | أبعاد الصورة كبيرة جدًا. الحد الأقصى 4000 بكسل لكل ضلع. |
| `image_too_small` (422) | الصورة صغيرة. المطلوب 512×512 بكسل على الأقل للشعار المربع، أو ارتفاع 256 بكسل للشعار العرضي. |
| `aspect_ratio_out_of_range` (422) | شكل الشعار غير مناسب. يجب أن تكون نسبة العرض إلى الارتفاع بين 1:1 و4:1. |
| `image_empty` (422) | الصورة لا تحتوي على شعار ظاهر. |
| `svg_unsafe_content` (422), all eight `construct` values | يحتوي ملف SVG على عناصر غير مسموح بها لأسباب أمنية. صدّر الشعار بصيغة PNG وارفعه. |
| `svg_unsupported` (422) | تعذّرت معالجة ملف SVG هذا. صدّر الشعار بصيغة PNG وارفعه. |
| `file_too_large` (413) | حجم الملف أكبر من 1 ميجابايت. |
| `logo_preview_mismatch` (409) | الملف لا يطابق المعاينة المعروضة. اختر الملف مرة أخرى لعرض معاينة جديدة، ثم احفظ. |

The SVG message never names the construct and never echoes file content (the server echoes none).
Focus stays on the file input; the message is linked with `aria-describedby` and announced through a
persistent polite live region.

### 5.2 Warnings (non-blocking)

| Warning | Arabic message |
|---|---|
| `low_contrast` | الشعار فاتح على الخلفية البيضاء، لذلك سيظهر داخل بطاقة بيضاء بإطار على أجهزة الكاشير. يمكنك حفظه كما هو. |
| `receipt_high_black_coverage` | مساحة السواد كبيرة في نسخة الإيصال، فقد يظهر الشعار كتلة داكنة وتصبح الطباعة أبطأ. شعار بخلفية فاتحة يعطي نتيجة أوضح. |
| `receipt_thin_strokes` | بعض خطوط الشعار رفيعة جدًا وقد تختفي في الطباعة الحرارية. شعار بخطوط أعرض يعطي نتيجة أوضح. |

The receipt fix is always a clearer screen logo: there is no separate receipt upload.

### 5.3 Page states and labels

| Place | Arabic text |
|---|---|
| Page title | هوية المؤسسة |
| Empty state | لا يوجد شعار للمؤسسة. تعرض أجهزة الكاشير اسم المؤسسة نصًا في مكانه. |
| Requirements line (under the file input) | PNG أو SVG، حتى 1 ميجابايت. 512×512 بكسل على الأقل للشعار المربع، أو ارتفاع 256 بكسل للشعار العرضي. |
| Screen preview heading | كما سيظهر على أجهزة الكاشير |
| Receipt preview heading | كما سيُطبع على الإيصال |
| Remove confirm, text | إزالة شعار المؤسسة؟ ستعرض أجهزة الكاشير والإيصالات اسم المؤسسة نصًا بدل الشعار. |
| Remove confirm, buttons | «إزالة الشعار» (`.btn-destructive`) · «إلغاء» (`.btn-ghost`) |
| Conflict (409) | تغيّر شعار المؤسسة بعد فتحك لهذه الصفحة. حدّث الصفحة لترى الشعار الحالي، ثم أعد المحاولة. |
| Save succeeded | تم حفظ الشعار. ستعرضه أجهزة الكاشير بعد تحديث بياناتها. |
| Removal succeeded | تمت إزالة الشعار. ستعرض أجهزة الكاشير اسم المؤسسة نصًا بعد تحديث بياناتها. |

When the POS picks the change up is decided by RT-475 (the read-down and cache). The «بعد تحديث
بياناتها» wording stays vague on purpose until then.

«آخر تحديث» follows DESIGN.md §8 for evidence time: a human Arabic date with Western digits,
24-hour time and an explicit time zone. The page is tenant-scoped, so there is no store time zone
to use.

### 5.4 Errors handled by existing patterns

- `429 rate_limited`: the existing `RateLimitBanner`.
- `401 unauthorized`: the existing sign-in redirect.
- `404 not_found`: the no-access screen (`18`).
- `403 origin_rejected` and `500 internal_error`: the existing generic error with the request id.

No new frame is needed for these.

## 6. Design rules that apply

- Role tokens from `DESIGN.md` and `src/styles/tokens.css` only. The POS surface inside the screen
  preview is a sample of the POS light surface from RT-832, not Admin chrome.
- One primary per context: «رفع شعار» in state A, «حفظ الشعار» once a preview exists.
- A destructive action starts with `.btn-danger-quiet`; `.btn-destructive` appears only in its
  inline confirm (state H).
- Warnings and refusals carry an icon and text, never colour alone; verify in forced colours.
- Icons come from the semantic registry (`src/components/icons/registry.ts`), `aria-hidden`. The
  Admin registry has no warning or upload icon yet; the implementation adds them the RT-263 way,
  with the same names as the POS registry (D-263-9).
- Logical CSS properties; the page reads right to left; visual order and tab order match.
- Motion: new banners, inline errors and the inline confirm settle in on Signal (150ms), zero under
  reduced motion. No other motion.

## 7. Export

- Export from Claude Design into `apps/admin-console/design/screens/`, at 1440 and 1280, split
  into `-a`/`-b` parts when a file would exceed 180 KB.
- Check each PNG as the existing ones were checked: PNG signature, closing `IEND`, a full decode at
  its stated size.
- Add a row per frame to the index in `design/screens/README.md`, naming the Claude Design template.

## 8. Out of scope

Per-branch logos, a receipt-specific upload, a light-variant upload, colour or theme settings per
tenant, English and dark frames (later pass), and any `/platform` access.

## 9. Open items

| # | Item | Owner |
|---|---|---|
| 1 | ~~Draw the frames in §4 and export them (§7)~~ Done 2026-10-29: `47-…` to `56-…` in `design/screens/`, owner-approved | Design |
| 2 | OD-8: bench dpi and printable width (RT-110); replace the assumed 203 dpi in the frames | Owner (bench) |
| 3 | Owner review of the exported frames before RT-474 implementation starts | Owner |

## 10. Review record

Reviewed on 2026-10-29 with the Admin Console `impeccable` skill (`shape`, product register). The
discovery questions were answered by RT-474, RT-473, RT-832 and the owner's approval of the
structure. Visual direction probes were skipped: the harness has no native image generation.

Changes from that review: the remove action became `.btn-danger-quiet` with an inline confirm
instead of a dialog; every refusal states that the current logo is unchanged; the four slots sit in
one recessed panel instead of identical cards; a requirements line was added under the file input;
numbers and ratios are LTR-isolated; the unsaved-preview guard, the replaced in-flight request,
focus handling, the forced-colours card and the on-screen scale caveat were added; two copy fixes
(«تصبح الطباعة أبطأ», and a conflict message that does not guess the cause). The placement was
checked against the code: `TenantDetail` is reachable by tenant roles and already hosts
owner/tenant_admin configuration sections. The powered-by line shows with every slot, as RT-832
places it.
