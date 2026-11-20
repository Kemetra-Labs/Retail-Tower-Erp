/**
 * The public surface of `connector-health` (RT-1453): the only file other api modules import (besides
 * `connector-health.module.ts`). Add an export here when another module needs it; a port that touches the database takes
 * the caller's `PoolClient`. `tools/module-boundaries` enforces this.
 */
export { latestConnectorEvidence } from "./connector-evidence";
