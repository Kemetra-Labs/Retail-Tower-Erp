/**
 * The public surface of `device-health` (RT-1453): the only file other api modules import (besides
 * `device-health.module.ts`). Everything else in this directory is internal. A port that touches the
 * database takes the caller's `PoolClient`. `tools/module-boundaries` enforces this.
 */
export { readStoreDeviceFacts } from "./store-device-facts";
