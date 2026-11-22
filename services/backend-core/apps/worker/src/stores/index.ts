/**
 * The worker's `stores` port (RT-1525; RT-1453 port convention). Other worker modules read stores
 * through here, never with their own SQL on `stores`.
 */
export { liveStoreNames } from "./live-store-names";
