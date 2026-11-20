### Added
- RT-1504 `[GATED: deps/lockfile]`, owner decision OD-9 A (RT-1489): the Backend-Core API package
  now declares `csv-parse` 7.0.3 and `read-excel-file` 9.3.17 (exact pins, plus their transitive
  `fflate`, `saxen`, `unzipper-esm` and `worker-f` in the lockfile) for the manual product import
  (spec 049, slice S3). No code imports them yet: the parsing runtime and the zip guards of spec
  049 section 8.5 are slice S4 (RT-1505).
