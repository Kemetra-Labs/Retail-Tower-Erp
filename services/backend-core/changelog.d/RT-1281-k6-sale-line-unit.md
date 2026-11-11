### Fixed
- RT-1281 (found by the RT-317 S0 run, 2026-11-11): the k6 POS harness sent every sale line with
  unit `each`, which the lab ERPNext Connector does not map, so every k6 sale was refused at posting
  as `UnmappedUnit` (fail-closed). Lines now use `unit`, the unit real tills send; `LOAD_UNIT` or a
  per-product `unit` in `LOAD_PRODUCTS` overrides it. Harness only; no product code changed.
