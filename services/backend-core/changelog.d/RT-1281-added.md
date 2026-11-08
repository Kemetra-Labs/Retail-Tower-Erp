### Added
- RT-1281: the Datadog agent profile now scrapes the worker's load-diagnosis metrics (queue lag,
  job duration and failures, outbox backlog and drain, DB pool) over the internal compose network;
  the worker listener binds the container network on 9091 with no published port. A
  "Retail Tower — load test" dashboard joins the monitoring-as-code. The k6 harness gains
  `pos-terminals.js` (1/3/10 POS terminal-equivalents at an owner-set rate), `offline-burst.js`,
  a read-only `scripts/reconcile-run.sql` (accepted vs stored vs posted, ERP posting lag), and
  sales that authenticate as a paired terminal with a cashier admission.
