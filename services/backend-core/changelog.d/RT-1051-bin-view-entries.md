### Security
- RT-1051: the ERPNext bin-view snapshot report (`binViewReportSnapshot`)
  `entries` array now uses the same length-first `boundedArray` check as the other
  request arrays, so an oversized report is refused before any entry is validated
  (zod GHSA-mrhx-c7xc-m3w5). The limit is unchanged (500, `maxItems` already in the
  contract); this array was missed by the first pass.
