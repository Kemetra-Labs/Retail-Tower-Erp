### Fixed
- RT-1387 (RT-1382 follow-up): the Schemathesis operator-envelope run no longer reports
  "could not run" for `pos-sales/sales.yaml`. Since RT-1343 added `voucher` to
  `CreditReversalRefundTender.method`, the Hypothesis `filter_too_much` health check stopped
  `recordCreditSaleReversal` early (191 cases lost). `tools/schemathesis/run.sh` now passes
  `--suppress-health-check=filter_too_much` in operator mode only; gate and report keep every
  health check.
