### Added
- RT-451 slice S2, first runtime PR (`[GATED: migration]`, owner approval of
  the revised M1 in RT-451 comment 16216; decisions OD-T1..OD-T7 in comments
  16215 and 16217): the tenant's tracked-selling switch.
  - Migration `0086_tracked_selling_tenant_switch` adds
    `tenant_inventory_settings.tracked_selling_enabled` (NOT NULL, default
    false: every tenant is OFF) with `tracked_selling_changed_at` / `_by` and
    two CHECKs (a change time and actor together; ON only with a change).
    Additive, no backfill, no new table or grant. M1's second part, the
    `tracked_line_validations` table, ships with the TLV in the next S2 PR.
  - The runtime of `getTrackedSellingSetting` / `setTrackedSellingSetting`
    (`GET` / `PUT /api/inventory/v1/settings/tracked-selling`), which drops
    their `contract-only` markers. Owner and tenant_admin read every field
    with the RT-50 Q13 preconditions evaluated on each read, fail closed (the
    four this build cannot confirm stay unmet, so switching on is refused
    with `409 tracked_selling_preconditions_unmet` until they ship); a
    store_manager reads on/off only. Switching off is always accepted, a
    repeat writes nothing, and a tenant that is on stays on when a
    precondition later fails. Each change is audited as
    `inventory.tracked_selling.update`. Both answer the non-disclosing 404
    after authentication and role while the deployment gate
    `POS_TRACKED_SELLING_ENABLED` is off.
  - The POS inventory safety feed answers `tracked_selling_enabled` (the gate
    AND the tenant's switch) on every snapshot and delta page, and
    `posListTrackedLots` now also needs the tenant's switch on (otherwise the
    same non-disclosing 404).
