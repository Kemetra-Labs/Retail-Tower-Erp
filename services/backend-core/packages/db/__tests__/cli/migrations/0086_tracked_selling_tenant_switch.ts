/** 0086_tracked_selling_tenant_switch (RT-451 S2): [its three tenant_inventory_settings columns, their two CHECKs]. */
import { countColumns, countConstraints, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0086_tracked_selling_tenant_switch",
  probe: {
    measure: async (db) => [
      await countColumns(db, "tenant_inventory_settings", [
        "tracked_selling_enabled",
        "tracked_selling_changed_at",
        "tracked_selling_changed_by",
      ]),
      await countConstraints(db, [
        "tenant_inventory_settings_tracked_selling_change_pair",
        "tenant_inventory_settings_tracked_selling_on_changed",
      ]),
    ],
    applied: ["3", "2"],
    rolledBack: ["0", "0"],
  },
};
