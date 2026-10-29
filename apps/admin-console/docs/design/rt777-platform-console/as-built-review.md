# `/platform` as built: design review (29 October 2026)

Follow-up to the RT-777 design review ([README.md](README.md)). RT-780, RT-781 and RT-782 shipped the
Platform Console's directory, start drawer and support-session bar. RT-777 §3 had listed most of
their states as missing frames, so instead of drawing them, this review captured the shipped screens
and reviewed them. Docs only: nothing in `src/` changes here.

## 0. Method and limits

- **Baseline:** `main@54b7d9c0`. Built with `pnpm build` and served with `pnpm preview`.
- **Captures:** 20 states, at 1440 and 1280, Arabic, light, with a mocked Backend-Core in the shapes
  the e2e specs use. They are `57-…` to `76-…` in [`design/screens/`](../../../design/screens/README.md).
- **Review:** the Admin Console `impeccable critique` method, run as two passes.
  - The author of this file reviewed the captures against `DESIGN.md`, the design-system rules and the
    code.
  - A separate agent, which did not see that review, scored the screens independently (Nielsen and
    cognitive load) and checked each claim against the source.
  - The findings below are where the two passes agree, plus the points each pass added once verified.
- **Not run:** the skill's deterministic detector. It is not installed locally, and `npx impeccable`
  would download a package; that was not done without approval.
- **Mock artifact, withdrawn (corrected 29 October 2026):** the first version listed a P1-3 («المالك»
  shown inside a support session). It came from the e2e fixture, which sets `active_role_code: "owner"`
  with a support session (`tests/e2e/support-session.spec.ts:45`). Backend-Core sets
  `active_role_code` from the user's own membership of the active tenant
  (`services/backend-core/apps/api/src/context/context.service.ts`, `activeMembership?.roleCode ?? null`),
  and a support session opens only for a tenant the user is not a member of (409 `already_member`
  otherwise). The real value in a session is `null`, and `AppShell` then shows no role. Frames 69–75
  still show «المالك» because they use that fixture; read them with this in mind.
- **Unreachable:** a session expiring while a tenant screen is open (403 `support_session_expired`).
  Inside a session every tenant route shows the read-only notice and calls no tenant API, so
  `SupportSessionBoundary`'s 403 path cannot be reached until tenant views exist inside a session
  (RT-783).

## 1. Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | A renew shows no visible confirmation (73); "session gone" shows nothing (74) |
| 2 | Match with the real world | 3 | Full date plus UTC for a 60-minute window |
| 3 | User control and freedom | 3 | Nothing traps the user |
| 4 | Consistency and standards | 2 | «لوحة التحكم» instead of the platform label inside a support session; one action, two names (58, 67); refusals use `info` |
| 5 | Error prevention | 3 | The replace warning does not name the session it ends (65) |
| 6 | Recognition over recall | 3 | 65 relies on memory |
| 7 | Flexibility and efficiency | 1 | No fast path from search to a session |
| 8 | Aesthetic and minimalist design | 2 | Repeated messages (62, 68, 72, 64) |
| 9 | Error recovery | 2 | 74 recovers silently; 62 has two retry controls |
| 10 | Help and documentation | 3 | Inline hints are specific |
| **Total** | | **24/40** | Acceptable; real improvements are needed |

**Not AI slop.** Tokens only, no decoration, and the copy is specific. The weakness is the opposite:
some surfaces are under-designed, most visibly the session bar, the highest-privilege state on the
console, which is its quietest band.

**What works:**
- Refusals say what did not happen: «لم تبدأ أي جلسة ولم يتغير شيء» (66, 68). Request IDs are shown.
- Session states are modelled honestly: at the cap, Renew stays visible and `aria-disabled` (71);
  expired copy switches to past tense (72).
- A member gets «فتح المؤسسة» instead of a session that would be refused (58).

## 2. Priority issues

| Id | Severity | Frame | Issue | Cause (verified) | Fix |
|---|---|---|---|---|---|
| P1-1 | P1, layout bug | 76 | The no-access page is broken: the top bar renders at the bottom-left and the card sits off-centre | `.platform-standalone` (`platform.css`) has `grid-template-rows` but no areas; `.topbar` (`app-shell.css:32`) sets `grid-area: topbar`, an unknown name, so the grid adds implicit tracks | Add `grid-template-areas: "topbar" "stage"` and `grid-area: stage`, or `.platform-standalone .topbar { grid-area: auto; }` |
| P1-2 | P1, flow | 74 | Renew answered "session already gone": the operator is sent to the directory with no message, and the live region unmounts with the bar | `gone: "leave"` in `useSessionActions.ts` | A one-shot notice on the directory saying the session ended or was replaced, that nothing changed, and how to continue. Same for End `gone`. Needs new copy |
| P2-1 | P2, duplicate state | 62, 68 | Rate limit shown twice, with two retry controls in different states | The shell's `RateLimitBanner` (`PlatformShell.tsx:110`) plus the directory's and drawer's own banners | One message and one countdown per failure: suppress the shell banner when the surface owns the 429 |
| P2-2 | P2, layout bug | 57, 58 | The slug floats about 450px from the tenant name and reads as a third, headerless column | `.platform-directory__slug { display: block }` on an LTR `bdi` aligns to the left of the RTL cell | Align it to the cell's start (`text-align: right` under RTL, or an inline isolate); constrain the table width |
| P2-3 | P2, copy | 65 | «لديك جلسة دعم حالية…» does not name the session it ends; it sits low in the drawer | `platform.start.replaces` | Name the tenant, purpose and ticket of the current session, and place the warning above the submit button. New copy |

## 3. Minor observations

- **72:** the expired message appears twice (bar notice and page body). Keep one. The «صفحة المؤسسات»
  link looks like the browser default (no link token found in `src/**/*.css`; not confirmed further).
- **66, 67:** refusals use the `info` banner (`StartSessionDrawer.tsx:53`, `:73`). Design-system rule
  3 reserves info for pending; a final refusal is neutral or warning. The banners also shrink to their
  content (`justify-items: start`).
- **67:** «استخدم تبديل المؤسسة العادي» is an instruction, not an action name. Use «فتح المؤسسة» as
  in 58.
- **64:** the ticket error repeats the whole rule under the hint. Say what is wrong («يحتوي على مسافة»).
- **63:** the facts list wraps values to three lines in a narrow column. Stack label over value in the
  440px drawer. The suspended-tenant line repeats the read-only point without saying why it differs
  (enforced by the server, not only by the UI).
- **59, 60:** the empty and no-match states are bare text. «المعروض: 0 من 3» is redundant under
  «لا توجد مؤسسة تطابق». A «مسح البحث» action would help.
- **69–75:** inside a support session the top bar's identity label reads «لوحة التحكم», while the
  operator acts as platform staff. The design system's tenant shell example uses «لوحة المؤسسة», so
  the shipped label matches neither identity. Design-system rule 7 separates the platform and tenant
  consoles by identity label; keeping «المنصة» in a session would match the platform side. (The
  «المالك» role in these frames is a fixture artifact, §0.)
- **69:** the session bar groups eight items in one flat row; the tenant name has no more weight than
  the purpose. The 4px info edge is the only privilege signal. The sidebar marks no current location.
- **69–75:** the time shows the full date plus UTC for a 60-minute session («حتى 29 أكتوبر 2026، UTC
  10:50»). The time-zone rule is RT-401; the date could go.
- **73:** a successful renew is announced only to screen readers; sighted users must re-read the time.
- **75:** the origin-rejected error offers no in-place recovery. «أعد تحميل الصفحة» could be a button.
- **Directory:** tenant status is not shown. RT-843 added `status` to `TenantSummary` in Backend-Core,
  but the Admin Console pin does not have it yet (`src/generated/schema.d.ts`). A repin, then a status
  badge, would replace the static suspended-tenant note.

## 4. Follow-ups

| Slice | Covers | Kind | Jira |
|---|---|---|---|
| F1 | P1-1 no-access layout | CSS fix, one file | RT-929 |
| F2 | P1-2 "session gone" notice, and End `gone` | Flow and copy (copy needs owner approval) | RT-930 |
| F3 | Withdrawn: the «المالك» role was a fixture artifact (§0). The «لوحة التحكم» label is a minor observation (§3) | None | None |
| F4 | P2-1 single rate-limit surface | Shell and platform | Not opened |
| F5 | P2-2, P2-3 and the minor copy items | Directory and drawer polish (copy needs owner approval) | Not opened |
| F6 | Tenant status in the directory | Repin to Backend-Core with RT-843, then UI | Not opened |
