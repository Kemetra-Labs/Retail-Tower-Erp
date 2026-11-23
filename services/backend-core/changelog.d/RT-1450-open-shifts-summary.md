### Added
- RT-1450 `[GATED: contract]` (RT-1437 A1 "Health", follow-up of RT-1440): Console read
  `GET /api/v1/open-shifts/summary` (`consoleGetOpenShiftsSummary`,
  `console-force-actions.openapi.yaml` 1.3.0-draft, additive). It counts the tenant's open
  shifts per store and in total (`openShiftCount`, `staleShiftCount`, `eligibleShiftCount`),
  over exactly the shifts and verdicts the per-store `consoleListOpenShifts` read shows, judged
  at one instant. No new predicate or threshold. Same access as the per-store read.
