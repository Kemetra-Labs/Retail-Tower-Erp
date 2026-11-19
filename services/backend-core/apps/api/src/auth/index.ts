/**
 * The `auth` module's port (RT-1453 module boundaries). Other modules import from here, not from
 * the files inside. It exposes only what a Console route needs to be guarded: the human session
 * guard and the role gate (`@Roles` + `RolesGuard`).
 */
export { DashboardAuthGuard } from "./dashboard-auth.guard";
export { Roles } from "./roles.decorator";
export { RolesGuard } from "./roles.guard";
