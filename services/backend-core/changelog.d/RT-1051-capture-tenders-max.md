### Security
- RT-1051 `[GATED]`, owner decision 2026-11-05 (chat, recorded on Jira RT-1051): the
  capture-sale request `tenders` array is now bounded to 16 items (zod
  GHSA-mrhx-c7xc-m3w5, RT-1050), with the `boundedArray` length-first check: a longer
  array is refused with a single 400 `validation_error` before any tender is
  validated. Contract: `pos-sales/sales.yaml` 1.19.0-draft
  (`CaptureSaleRequest.tenders.maxItems: 16`). The POS pin is repinned in the same PR.
