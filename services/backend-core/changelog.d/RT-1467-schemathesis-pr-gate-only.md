### Changed
- RT-1467 (CI-03): the sharded `bc/schemathesis` PR job runs the gate (`not_a_server_error`)
  only. The non-gating report (`positive_data_acceptance`) runs in the nightly API fuzz
  workflow, and the fan-in (`shards.py`, `MODES = ("gate",)`) no longer expects report output.
