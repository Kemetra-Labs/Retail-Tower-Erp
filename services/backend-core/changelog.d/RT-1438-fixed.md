### Fixed
- RT-1438: `GET /api/pos/v1/shifts/stuck` no longer drops a shift whose opening cashier has a
  NULL or blank `display_name`. The list used to require `display_name IS NOT NULL`, so such a
  shift was eligible for a forced close (`IS_STUCK_SQL`) but invisible on the POS stuck-shifts
  screen. The row is now listed under the cashier's email. The response schema is unchanged
  (`cashier_display_name` stays a non-null string) and the eligibility rules are untouched.
