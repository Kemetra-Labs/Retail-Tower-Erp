<!--
RT-475 — §A4 P8 bridge-security record for the tenant branding channels
(spec 039 FR-33). Written with the implementation, before merge.
-->

# §A4: tenant branding bridge (RT-475)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-475: POS tenant logo read-down, offline cache and the four on-screen slots. |
| Contract | Backend-Core `packages/contracts/openapi/tenant-branding.openapi.yaml` (`posGetTenantBranding`, RT-473 S2, `backend-core/v0.3.3`). Spec 039 FR-30…FR-36. Slots: [`docs/design/vnext/31-rt832-logo-slot-references.md`](../../design/vnext/31-rt832-logo-slot-references.md). |
| Gate | §A4, the P8 Electron security boundary. |
| Baseline | `origin/main` at `3fe42b60`. |
| Prepared by | The implementation agent (Claude Code), 2026-11-01. **This is not an independent review.** It needs the owner's sign-off. |
| Verdict | **Two new channels**: one read-only invoke and one push. One existing allowlist (the locked-session guard) gains the invoke. Agent-assessed PASS. |

## 2. New bridge surface

| Channel | Kind | Request | Answer |
| :-- | :-- | :-- | :-- |
| `branding:get` | invoke | exactly `{}` | `BrandingSnapshot`, or `{ kind: 'refused', reason: 'invalid_input' }` |
| `branding:changed` | push (main → renderer) | n/a | `BrandingSnapshot` |

`BrandingSnapshot` (`src/shared/branding/types.ts`) is one of:

- `{ v: 1, kind: 'none' }`: no usable logo, or the terminal is not paired. The screens are exactly today's. Owner decision 2026-11-01: there is no name-as-text state.
- `{ v: 1, kind: 'logo', displayName, card, slots }`, where `slots` maps the four slots to `{ width, height, src1x, src2x }`. `displayName` is used only as the image's alt text.

## 3. Controls

| Control | Check | Result |
| :-- | :-- | :-- |
| CH-1 Enumerated channels | Both names come from `BRANDING_IPC_CHANNELS`. The preload binds only these names. No write, refresh or path channel exists, so the renderer cannot trigger a network read (test: exactly one invoke is registered). | PASS |
| INP-1 Closed request | The handler accepts exactly `{}`. Any other argument list is refused before the service runs: none, extra keys, `null`, two objects, a string (test). | PASS |
| SCOPE-1 Scope from main only | The tenant and pairing epoch come from the pairing store at call time (`resolveBrandingScope`). The renderer sends no identifier. | PASS |
| P8-1 No path, no URL | Images cross only as `data:image/png;base64,…` of the server-encoded screen renditions. `parseBrandingSnapshot` runs in main before sending and again in the preload, and refuses anything else: a `file://` path, an `https://` URL, an SVG data URI (tests). The cache lives in SQLite, so there is no file to name. | PASS |
| P8-2 Bounded payload | The display name is ≤ 80 UTF-16 units (OD-10, cut on a code point in main). Each slot size is ≤ its RT-832 box. Exactly four slots. Unknown fields are dropped (test). The receipt rendition is never bridged. | PASS |
| P8-3 No identifier | No tenant, terminal, branch or pairing id, no version and no revision cross the bridge. | PASS |
| SEC-1 Device token | The worker reads the token in-process through `readSendableDeviceToken` (null unless paired and not revoked) and hands it to the client only. It is never logged, cached or bridged. Logs carry the outcome kind and the tenant id only, like the catalogue read-down. | PASS |
| ISO-1 Tenant isolation | Every cache record carries the pairing it was read under (`tenant_id`, `paired_at`). A read under any other pairing purges both records: a re-pair to another tenant, a re-pair to the same tenant (the epoch always moves up, RT-113 F4), or an unpair. A device revocation keeps the cache for the same epoch only (FR-32). The worker re-checks the pairing just before writing, so a read that started before a re-pair is dropped. The renderer clears its copy on every pairing push (tests: the four RT-475 isolation cases plus the late-write case). | PASS |
| LOCK-1 Locked-session allowlist | `branding:get` is added to `LOCKED_ALLOWED_CHANNELS`, because the lock screen shows the logo (RT-832 `lock`). It returns only what the signed-out screens show. Its only write is deleting cache rows that fail validation or belong to another pairing (FR-35a, FR-32). It never writes a new value, and it never calls the network (test: the exact allowlist set). | PASS |
| AUTH-1 Not session-gated | Deliberate: the boot, pairing and sign-in screens run with no session (FR-30/FR-33). The answer holds no business data. | PASS |
| REV-1 No revocation side effect | The branding fetch is not wrapped in `withDeviceAuthObservation`. RT-215 decision 2 closes the revocation sources to cashier admissions, the read-down and sale sync, so a branding 401 is not counted. | PASS |
| PUSH-1 Push hygiene | The push is sent with `broadcastToWindows`, so a closing window is skipped. The preload drops an invalid push without a callback, and never forwards the `IpcRendererEvent` (test). | PASS |
| CSP-1 Rendering | `img-src 'self' data:` already allows data URIs (`index.html`, `bootstrap-window.ts`). No CSP change. | PASS |

## 4. Residuals for the owner

- **R-1, decoding.** Main has no image decoder. It checks the PNG signature, the IHDR size and the local digest. A PNG that passes those checks but does not decode fires `<img onError>`. The renderer then drops the snapshot to `none` for every screen, so no broken image and no stray powered-by line is shown, until the next push or pairing change.
