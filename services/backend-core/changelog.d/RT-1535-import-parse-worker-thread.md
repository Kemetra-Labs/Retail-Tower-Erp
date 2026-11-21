### Security
- RT-1535: the product import upload (spec 049 S4) now runs the file parse (CSV and XLSX readers, magic-byte,
  zip and bomb scanners) in a Node `worker_threads` Worker with `resourceLimits` and a 20 s wall-clock timeout,
  instead of on the API main thread. A maximal 5,000 x 50 XLSX no longer stalls the event loop for seconds
  (POS sync, auth and console traffic of every tenant). A timeout, a heap-limit kill or a dead worker is the
  contract's existing 422 `file_unreadable`; nothing is written. Same outputs, no contract, migration or
  dependency change.
