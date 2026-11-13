/**
 * 0108_pending_signups (RT-1350 slice 2): [the `pending_signups` and
 * `user_consents` tables, their policies (pending_signups SELECT, INSERT,
 * UPDATE; user_consents SELECT, INSERT; no DELETE) and the forward-only guard
 * trigger on pending_signups].
 */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["pending_signups", "user_consents"];

export const MIGRATION: MigrationEntry = {
  id: "0108_pending_signups",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_trigger
          WHERE tgname = 'pending_signups_guard' AND NOT tgisinternal`,
      ),
    ],
    applied: ["2", "5", "1"],
    rolledBack: ["0", "0", "0"],
  },
};
