/** 0139_auth_tokens_pending_rotation (RT-1362 S2): the pending marker on auth_tokens (request id and kind columns), its composite FK to a credential.rotate request of the same tenant and registration, and its shape CHECK. */
import { countColumns, countConstraints, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0139_auth_tokens_pending_rotation",
  probe: {
    measure: async (db) => [
      await countColumns(db, "auth_tokens", ["pending_rotation_request_id", "pending_rotation_kind"]),
      await countConstraints(db, ["auth_tokens_pending_rotation_request_fk", "auth_tokens_pending_rotation_shape"]),
    ],
    applied: ["2", "2"],
    rolledBack: ["0", "0"],
  },
};
