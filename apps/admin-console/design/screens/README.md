# Retail Tower Admin Console: reviewed screen designs

Static PNG exports of the screen designs made in the **Retail Tower Design System** project in Claude Design (claude.ai/design). They are a design record, not production UI, and nothing in `src/` imports them. Every name, ID, time, count and amount in them is mock data.

## Provenance

- **Source:** Claude Design project `53e2ffd3-a314-4094-899d-aff63deca985`, folder `export/screens/`. Each image was read back with DesignSync and checked before it was committed: PNG signature, closing `IEND` chunk, and a full decode at its stated size. None is truncated.
- **Exported:** 12 October 2026, at 1440px wide. Claude Design split long screens top to bottom into parts (`-a`, `-b`, …) so each file stays under 180 KB; read the parts in order.
- **Design system:** the screens use the bundle in [`../claude-design-system/`](../claude-design-system/) as synced after #94.
- **Decisions applied:** RT-391 D1–D5; RT-414 decisions 1–4 as merged in Backend-Core #741 (purpose enum, renewal cap of 8 hours, owner and tenant-admin audit visibility, `ticket_ref` pattern); and the owner decisions of 12 October 2026. D-AUD-07 (charts), D-AUD-08 (status words) and DS-R17 (design-only actions) are recorded in the [design-system README](../claude-design-system/README.md). The one-action break-glass scope and the suspended-tenant rule are on RT-414 (comment 11711), where the suspended-tenant rule awaits contract confirmation. D-AUD-01 (only the platform team resolves an unknown outcome) and D-AUD-02 (the owner workspace is a role-gated group inside the Platform Console) are recorded in the audit trail: `templates/design-audit/DESIGN-AUDIT.md` and `FOLLOW-UPS.md` in the Claude Design project.
- **RT-400 corrections (13 October 2026):** `16-store-create.png`, `17-store-edit.png` and `19-store-details-denied.png` replace their 12 October exports. They apply the corrections from RT-400 comment 11832: the edit form has an editable store name, the denial screen has no «حذف المتجر» action, and the time zone reads «القاهرة (Africa/Cairo)» with no fixed UTC offset.
  - The project's `export/screens/` still held the old versions, so these three were rendered locally from the corrected templates listed in the index (default view, light, Arabic) at 1440×900. They used the synced design-system CSS, the Claude Design runtime (`support.js`) and Chromium.
  - The fonts were a local Dubai copy, not the project's uploaded files.
  - The change log is `templates/design-audit/rt-400/RT-400.md` in the project. The owner has not yet approved these three for RT-400.
- **RT-474 tenant logo (29 October 2026):** `47-…` to `56-…` come from the owner-approved Design canvas «RT-474 Tenant Logo» in Claude, not from the Claude Design project above. The brief is [`docs/design/rt474-tenant-logo/README.md`](../../docs/design/rt474-tenant-logo/README.md).
  - The canvas has one page component with a `state` property. Each state was rendered to static HTML from that component, with the synced design-system CSS in [`../claude-design-system/`](../claude-design-system/), and captured with Chromium at 1440 and 1280 wide (the 1280 frames carry `-1280`). Each PNG passed the same checks as the others: PNG signature, closing `IEND`, and a full decode at its stated size. None needed splitting.
  - The font is Dubai, installed on the capture machine. The sample logo «النخبة» is mock data.
  - The receipt preview uses 203 dpi, which matches the BIXOLON SRP-B300 driver reading recorded on RT-473 (comment 14342). OD-8 still waits for a printed self-test.
- **`/platform` as built (29 October 2026):** `57-…` to `76-…` are not designs. They are captures of the shipped Platform Console screens (RT-780, RT-781, RT-782), taken from the built SPA (`pnpm build`, then `pnpm preview`) with a mocked Backend-Core in the shapes the e2e specs use.
  - Arabic, light theme, at 1440 and 1280 wide (the 1280 frames carry `-1280`). Every name, ID and time is mock data.
  - Each PNG passed the same checks as the others: PNG signature, closing `IEND`, and a full decode at its stated size. None needed splitting.
  - They record what ships, for review against RT-777. The review findings are in [`docs/design/rt777-platform-console/as-built-review.md`](../../docs/design/rt777-platform-console/as-built-review.md).
  - Not captured: a session expiring while a tenant screen is open (403 `support_session_expired`). Inside a session every tenant route shows the read-only notice and calls no tenant API, so that path cannot be reached in the current UI.
- **Status:** reviewed with the owner in Claude Design. These images are not an implementation sign-off: backend contracts that the screens depend on are listed in `FOLLOW-UPS.md`, and controls without a service are shown `aria-disabled` with a «تصميم فقط» reason.

## Known gaps

- **Not shown:** mobile (390px) frames; laptop (1280px) frames except for the RT-474 tenant logo family (`47-…` to `56-…`) and the `/platform` as-built captures (`57-…` to `76-…`), which have `-1280` copies; dark theme beyond the Stores family; and English beyond the Stores family. The templates support them.
- **Re-authentication method for break-glass** (FOLLOW-UPS #11) and `perm_owner_console` (#30) are still open; the screens say «لم تُحدَّد بعد» where they apply.

## Index

| Files | Screen and states | Claude Design template |
|---|---|---|
| `01-stores-ar-ready.png`<br>`02-stores-ar-loading.png`<br>`03-stores-ar-empty.png`<br>`04-stores-ar-error.png`<br>`05-stores-ar-details.png` | Stores directory, Arabic: ready, loading, empty, error, store details | `templates/stores/Stores.dc.html` |
| `06-stores-dark-ready.png`<br>`07-stores-dark-loading.png`<br>`08-stores-dark-empty.png`<br>`09-stores-dark-error.png`<br>`10-stores-dark-details.png` | Stores directory, dark theme: same five states | `templates/stores-dark/StoresDark.dc.html` |
| `11-stores-en-ready.png`<br>`12-stores-en-loading.png`<br>`13-stores-en-empty.png`<br>`14-stores-en-error.png`<br>`15-stores-en-details.png` | Stores directory, English: same five states | `templates/stores-en/StoresEnglish.dc.html` |
| `16-store-create.png` | Store create | `templates/store-create/StoreCreate.dc.html` |
| `17-store-edit.png` | Store edit | `templates/store-edit/StoreEdit.dc.html` |
| `18-no-access.png` | No access | `templates/no-access/NoAccess.dc.html` |
| `19-store-details-denied.png` | Store details, access denied | `templates/store-details-denied/StoreDetailsDenied.dc.html` |
| `20-support-session-start-a.png`<br>`20-support-session-start-b.png`<br>`21-support-session-active-a.png`<br>`21-support-session-active-b.png`<br>`22-support-session-expiring-a.png`<br>`22-support-session-expiring-b.png`<br>`23-support-session-renewed-a.png`<br>`23-support-session-renewed-b.png`<br>`24-support-session-expired-a.png`<br>`24-support-session-expired-b.png`<br>`25-tenant-not-available-a.png`<br>`25-tenant-not-available-b.png` | Support session (RT-391 D1/D2, RT-414): start, active, expiring, renewed, expired, tenant not available | `templates/platform-dashboard/PlatformDashboard.dc.html` |
| `26-break-glass-active-a.png`<br>`26-break-glass-active-b.png`<br>`27-break-glass-reauth-a.png`<br>`27-break-glass-reauth-b.png`<br>`28-break-glass-reason-a.png`<br>`28-break-glass-reason-b.png`<br>`29-break-glass-confirm-a.png`<br>`29-break-glass-confirm-b.png` | Break-glass, one action: active, re-authentication, reason, confirm (design only) | `templates/platform-dashboard/PlatformDashboard.dc.html` |
| `30-support-platform-search.png`<br>`31-support-session-search.png`<br>`32-support-sale-rejected-a.png`<br>`32-support-sale-rejected-b.png`<br>`33-support-sale-unknown-a.png`<br>`33-support-sale-unknown-b.png`<br>`34-support-sale-queued-a.png`<br>`34-support-sale-queued-b.png`<br>`35-support-device-offline-outbox-a.png`<br>`35-support-device-offline-outbox-b.png`<br>`36-support-not-found.png` | Support search: platform directory, session search, sale rejected, sale outcome unknown, sale queued, device offline with outbox, not found | `templates/support-search/SupportSearch.dc.html` |
| `37-attention-default-a.png`<br>`37-attention-default-b.png`<br>`37-attention-default-c.png`<br>`38-attention-empty.png`<br>`39-attention-source-disconnected-a.png`<br>`39-attention-source-disconnected-b.png`<br>`39-attention-source-disconnected-c.png`<br>`39-attention-source-disconnected-d.png`<br>`39-attention-source-disconnected-e.png` | Needs attention: default, empty, source disconnected | `templates/needs-attention/NeedsAttention.dc.html` |
| `40-platform-dashboard-default-a.png`<br>`40-platform-dashboard-default-b.png` | Platform dashboard, default | `templates/platform-dashboard/PlatformDashboard.dc.html` |
| `41-occ-overview-a.png`<br>`41-occ-overview-b.png`<br>`42-occ-incident-a.png`<br>`42-occ-incident-b.png`<br>`43-occ-observability-a.png`<br>`43-occ-observability-b.png` | Owner command center: overview, incident investigation, observability | `templates/owner-command-center/OwnerCommandCenter.dc.html` |
| `44-tenant-dashboard-default-a.png`<br>`44-tenant-dashboard-default-b.png` | Tenant dashboard, default | `templates/tenant-dashboard/TenantDashboard.dc.html` |
| `45-app-shell-owner.png` | App shell, owner role | `templates/app-shell/AppShell.dc.html` |
| `46-support-session-cap-reached-a.png`<br>`46-support-session-cap-reached-b.png` | Support session at the 8-hour renewal cap (RT-414 decision 2) | `templates/platform-dashboard/PlatformDashboard.dc.html` |
| `47-logo-empty.png` | Tenant logo (RT-474): no logo stored | Canvas «RT-474 Tenant Logo», `LogoPage.dc.html` (`state=empty`) |
| `48-logo-current.png` | Tenant logo: current logo, replace and remove | same (`current`) |
| `49-logo-preview-loading.png` | Tenant logo: preview being generated | same (`loading`) |
| `50-logo-preview-ok.png` | Tenant logo: screen and receipt preview, no warnings | same (`ok`) |
| `51-logo-preview-low-contrast.png` | Tenant logo: `low_contrast`, every slot on the white card | same (`lowContrast`) |
| `52-logo-preview-receipt-warnings.png` | Tenant logo: both receipt warnings | same (`receiptWarn`) |
| `53-logo-refused-too-small.png`<br>`53-logo-refused-aspect.png`<br>`53-logo-refused-type.png`<br>`53-logo-refused-svg-unsafe.png`<br>`53-logo-refused-too-large.png` | Tenant logo: refusals (`image_too_small`, `aspect_ratio_out_of_range`, `file_type_not_allowed`, `svg_unsafe_content`, `file_too_large`) | same (`refusedSmall`, `refusedAspect`, `refusedType`, `refusedSvg`, `refusedLarge`) |
| `54-logo-remove-confirm.png` | Tenant logo: inline remove confirm | same (`removeConfirm`) |
| `55-logo-conflict.png` | Tenant logo: `409 logo_changed_concurrently` | same (`conflict`) |
| `56-logo-saved.png` | Tenant logo: save succeeded | same (`saved`) |

Every RT-474 file above also exists at 1280 wide with `-1280` before `.png` (for example `47-logo-empty-1280.png`).

### `/platform` as built (captures, not designs)

| Files | Screen and state | Source |
|---|---|---|
| `57-platform-directory.png` | Tenant directory | `/platform/tenants`, no session |
| `58-platform-directory-member.png` | Directory, the operator is a member of one tenant («فتح المؤسسة») | same |
| `59-platform-directory-no-match.png` | Directory search, no match | same |
| `60-platform-directory-empty.png` | Directory, no tenants | same |
| `61-platform-directory-error.png` | Directory load failed, retry | `listTenants` 500 |
| `62-platform-directory-rate-limited.png` | Directory rate limited | `listTenants` 429 |
| `63-platform-start-drawer.png` | Start drawer | `StartSessionDrawer` |
| `64-platform-start-invalid.png` | Start drawer, validation errors | same |
| `65-platform-start-replaces.png` | Start drawer while another session is open | same, with a session |
| `66-platform-start-not-found.png` | Start refused: tenant not available | `openSupportSession` 404 |
| `67-platform-start-member.png` | Start refused: already a member | `openSupportSession` 409 `already_member` |
| `68-platform-start-rate-limited.png` | Start rate limited | `openSupportSession` 429 |
| `69-platform-session-active.png` | Session active | `SupportSessionBar` |
| `70-platform-session-expiring.png` | Session expiring (under 5 minutes) | same |
| `71-platform-session-cap.png` | Session at the 8-hour renewal cap | same |
| `72-platform-session-expired.png` | Session expired | same |
| `73-platform-session-renewed.png` | Right after a successful renew | `renewSupportSession` 200 |
| `74-platform-session-renew-gone.png` | Renew answered that the session is already gone | `renewSupportSession` 409 `support_session_absent` |
| `75-platform-session-renew-origin.png` | Renew refused: origin rejected | `renewSupportSession` 403 `origin_rejected` |
| `76-platform-no-access.png` | `/platform` for a user who is not a platform admin | `PlatformNotAvailable` |

Every file in this table also exists at 1280 wide with `-1280` before `.png`.

140 files, 10.1 MB in total; the largest is under 180 KB.
