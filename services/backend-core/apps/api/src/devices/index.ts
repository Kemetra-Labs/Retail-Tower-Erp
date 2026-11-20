/**
 * The devices module's public port (RT-1453 port convention). Other modules import from here, not
 * from the files inside. Pricing (RT-1484) reads the active-device count of its target Stores.
 */
export { activeDeviceCountsByStore } from "./device-lookups";
