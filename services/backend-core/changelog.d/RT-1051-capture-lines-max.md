### Security
- RT-1051 `[GATED]`, owner decision Jira RT-1051 comment 15572 (2026-11-05): the
  capture-sale request `lines` array is now bounded to 500 items (zod
  GHSA-mrhx-c7xc-m3w5, RT-1050). It uses the
  `boundedArray` length-first check, so a longer array is refused with a single 400
  `validation_error` before any line is validated. Contract: `pos-sales/sales.yaml`
  1.18.0-draft (`CaptureSaleRequest.lines.maxItems: 500`). The POS caps a cart at 30
  lines (RT-1052); the POS pin is repinned in the same PR.
  The capture-sale `tenders` array is bounded separately (RT-1051-capture-tenders-max).
