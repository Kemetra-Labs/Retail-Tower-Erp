### Fixed
- RT-1325 (RT-1125 R-21): one posting row whose work item cannot be built no longer fails the
  whole ERPNext posting feed pull with a 500. A row whose projection fails on a known per-row
  visibility fault (tenders, responsibilities, return tenders or frozen resolution not visible)
  is left out of the page and re-offered in the same transaction under the existing retry
  budget, ending as `permanently_rejected` / `retry_budget_exhausted` (repairable on the 017
  surface). It is never offered without its data and never skipped. Visibility failures on two or
  more rows of one page are treated as systemic and still fail the pull (no budget spent), as
  does a SQL or unknown error; missing-resolution rows always stay isolated. A row omitted because it did not resolve is now warn-logged. A
  re-run `failed_transient` ack whose first run spent the last retry echoes the dead-letter
  instead of answering 409.
