# Shared principles (both surfaces)

Rule IDs refer to Confluence Constitution pages. Condensed; re-read the page for exact wording when it matters.

## Truth and operational state (UX-07, UX-01)

- **Truth -> Safety -> Action** (UX-07.1): say what is true, whether it is safe to continue, then what to do.
- **State the closest proven truth** (UX-07.2). Do not promote downstream failure into failure of an already-proven local sale (printer fails, sync fails, ERP posting fails: the sale stays proven).
- **Status is a vector** (UX-07.3): connectivity, storage, payment, sale persistence, receipt, sync, ERP posting, printer, authentication each have their own truth. Never collapse to one Online/Error bit.
- **Never invent operational truth to complete the UI** (UX-07.4). Unknown or unwired signals stay unknown or absent. (POS connectivity was hard-coded online; do not ship a fake "متصل".)
- **Pending != Failed != UNKNOWN** (UX-07.7). **Known Write / Stale Read** (UX-07.8): protect the proven write, block duplicate mutation, offer re-read only.
- **Degraded != Failed** (UX-07.6). **Stale is a truth state** (UX-07.10): disclose freshness when age affects a decision.
- **Proof before celebration** (UX-07.13): completion is a proof stack (payment, sale persisted, receipt, sync/posting), not one success banner. Success colour only for the proven fact being reported.
- **State surface ladder** (UX-07.15-.20): Indicator -> Inline notice -> Banner -> Outcome panel -> Blocking surface -> Recovery workspace. Pick by safety, not by how severe the error looks. Toast = neutral transient acknowledgement only.
- **Urgency = severity x current relevance** (UX-07.22); keep an attention budget, consolidate banners (UX-07.23, UX-04.13).
- **Loading != Empty** (UX-07.25). Expected-empty stays quiet; actionable-empty gives one next step (UX-07.26).
- **Name the retry** (UX-07.28): reload, re-read state, resend, reprint, retry-save are different. Generic "Retry" is wrong where it could repeat a financial mutation.
- **POS and Admin share truth, differ in depth** (UX-07.30, UX-12.35): never tell two different stories about the same state.

## Interaction grammar (UX-05)

- **Direct by default, guarded by consequence** (UX-05.1-.3). Smallest safe commitment surface.
- States Rest / Hover / Focus / Pressed / Selected / Busy / Blocked / Error stay distinct. **Selection != Focus** (UX-05.6). **Hover never owns essential function** (UX-05.7).
- **Intent survives the input method** (UX-05.8): mouse, touch, keyboard, scanner expressing the same intent give the same outcome. Scanner ownership is visible and singular (UX-05.9).
- **Focus returns with intent** (UX-05.10). **Danger is never the default**: destructive confirmations focus the safe option (UX-05.11).
- **One primary per region; meaning owns position** (UX-05.12-.13): commit, cancel/back and destructive slots stay predictable; a destructive action never takes the slot the commit held in the previous state (POS A2 `ActionSlots`).
- **Hide what does not belong, explain what is temporarily blocked** (UX-05.14): unauthorized actions are hidden; relevant-but-unavailable actions stay visible with the reason in persistent text, not a hover tooltip (UX-11.11).
- **Acknowledge without interrupting** (UX-05.15); **react immediately, claim only what is proven** (UX-05.16); **the action owns its progress** (UX-05.17); **optimistic interaction != optimistic truth** (UX-05.18); **feedback lives where the corrective action lives** (UX-05.19); **message lifetime follows consequence** (UX-05.20).
- **Never offer Undo without domain reversibility** (UX-05.21). POS Undo is main-owned (`cart.undoLast`, RT-245); the renderer never composes the inverse and no timer authorises it.
- **Confirmations state action, scope and consequence** (UX-05.23), safe default, no generic "Are you sure?".
- **Financial actions cross a commitment boundary** (UX-05.24): editing/calculating is visually distinct from commit, committing, and proven outcome. **When truth is uncertain, narrow the interaction space** (UX-05.25).
- **Inline does not mean implicit** (UX-05.26): consequential values (price) need an explicit lightweight commit, not save-on-blur. Complex entities edit in a drawer or dedicated surface (UX-05.27). **Scope before consequence** for bulk actions (UX-05.28).

## Forms, input and validation (UX-08)

- **Every field has a contract** (UX-08.1): grammar, normalization, validation authority, commit behaviour, error ownership, accessibility.
- **Validate where truth lives** (UX-08.2): local syntax/math on the client; uniqueness, permissions, versions, business truth at Backend-Core. **Prevent locally, decide authoritatively** (UX-08.3). **Invalid value != invalid context** (UX-08.4): a stale-version conflict is not a field error.
- **Editing-valid != commit-valid** (UX-08.5-.6): let typing be incomplete; be exact at commit. No premature error noise (UX-08.7). Name the error and the repair (UX-08.8). Field-attributable errors render at the field; transaction/scope/auth/concurrency errors at form or workspace level (UX-08.9). Long forms with several errors: summary plus inline (UX-08.10).
- **Money is parsed, never guessed; no silent rounding; edit plain, display rich** (UX-08.11-.13). Arithmetic is integer minor units.
- **Normalize equivalent digits** (Arabic-Indic/Persian -> ASCII) in numeric fields, never infer intent, never alter identifiers (UX-08.14). Quantity precision follows the UOM contract (UX-08.15). `inputMode` is a hint, not validation (UX-08.16).
- **Machine input never contaminates consequential human input** (UX-08.17): scanner bursts must not become money, PIN, password, card reference or counted cash.
- Credentials keep their own contracts (UX-08.18): cashier PIN is 4-6 digits; manager PIN is a separate 6-8 rule (POS freeze M5 note). Do not block password managers/paste where the contract allows (UX-08.19). Preserve valid non-secret input on failure; secrets may clear (UX-08.20).
- Codes/IDs: explicit format guidance, no autocorrect/spellcheck, LTR isolation (UX-08.21). External card reference is optional, `^[A-Z0-9]{0,6}$`, lowercase is invalid not silently uppercased, scanner input refused (I-10, UX-08 stress tests).
- Make unsafe data unrepresentable when a narrow safe domain exists (UX-08.22). Search zero-result is not a validation error (UX-08.23). Immutable is not disabled: show read-only and copyable (UX-08.24). Required/optional must be programmatic, not placeholder/asterisk/colour alone (UX-08.25). Server-known field errors return to the field (UX-08.27).

## Navigation, scope, location (UX-09)

- **Location != Scope != State** (UX-09.6); breadcrumbs are hierarchy, not workflow steps (UX-09.7).
- **Scope change is a context transition, not a filter click** (UX-09.8). **Deep links never silently mutate scope** (UX-09.9). **Context transitions respect unsaved work**: save / discard / stay (UX-09.10).
- Navigation follows the operator's mental model, not the repo map (UX-09.11); ERPNext IA is reference only (UX-09.12). Depth moves into the workspace (UX-09.14); a feature earns a primary-nav slot only as a durable destination (UX-09.15); actions and utilities are not destinations (UX-09.16); no dead destinations in production (UX-09.17).
- Role-aware navigation (UX-09.18): hide what does not belong. Default landing follows the dominant job (cashier lands sale-ready). The shell owns identity, scope and nav; the screen owns the task (UX-09.20).
- **Back follows the workflow contract, not browser history; navigation never bypasses transaction boundaries** (UX-09.22-.23). URL depth and visual depth need not match: a deep URL may open a drawer inside a stable workspace (UX-09.24-.25). Home orients, it does not repeat the menu (UX-09.26).

## Personality and anti-patterns (UX-01)

"Confident Retail Craft": precise, modern, trustworthy; calm surface, alive interaction; beauty under pressure. Expression varies by surface x task x risk and shrinks as risk rises (UX-01.9, .17). Structure before containers (UX-01.10); human summary first, evidence nearby (UX-01.12). Judge quality in tables, forms, loading, empty, disabled, offline and failure states, not only a dashboard screenshot (UX-01.26).

Anti-patterns (UX-01.27-.33): AI gradients, glass/glow, nested cards, spectacle animation, decorative colour per action/status, novel interaction patterns without measured benefit, ERPNext/Frappe UI as the operator experience.
