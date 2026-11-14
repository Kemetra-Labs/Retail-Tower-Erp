/**
 * 0108_pending_signups (RT-1350 slice 2): [the `pending_signups` and
 * `user_consents` tables, their policies (pending_signups SELECT, INSERT,
 * UPDATE; user_consents SELECT, INSERT; no DELETE) and the forward-only guard
 * trigger on pending_signups].
 */
import { countTables, type MigrationEntry } from "../migration-probes";
import { SYSTEM_PRIVILEGE_POLICIES } from "./0111_system_privilege_policies";

const TABLES = ["pending_signups", "user_consents"];

export const MIGRATION: MigrationEntry = {
  id: "0108_pending_signups",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      // 0111 adds its own policies here by name; they are counted by 0111's own probe.
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ANY($1::text[]) AND NOT (policyname = ANY($2::text[]))`,
        [TABLES, SYSTEM_PRIVILEGE_POLICIES],
      ),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_trigger
          WHERE tgname = 'pending_signups_guard' AND NOT tgisinternal`,
      ),
    ],
    applied: ["2", "5", "1"],
    rolledBack: ["0", "0", "0"],
  },
};
