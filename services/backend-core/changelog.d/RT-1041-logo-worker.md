### Fixed
- RT-1041: the tenant logo decode and render (trim, resize, receipt dither, PNG encoding) now run
  in a `node:worker_threads` worker instead of on the API event loop, so a 4000 × 4000 upload no
  longer stalls every other request on that process. Logo jobs are bounded per process (one
  running, at most 4 running or waiting); one more is the existing retryable `429 rate_limited`
  with `Retry-After`. Output is byte-identical: same `version`, master and renditions, no
  `PIPELINE_VERSION` change. No new dependency.
