/**
 * The public surface of `memberships` (RT-1453): the only file other api modules import (besides
 * `memberships.module.ts`). Everything else in this directory is internal. Add an export here when
 * another module needs it; a port that touches the database takes the caller's `PoolClient`.
 * `tools/module-boundaries` enforces this.
 */
export { listSpecificAccessMembersOfStore } from "./store-members";
