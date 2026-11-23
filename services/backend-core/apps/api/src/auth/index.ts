/**
 * The `auth` module's port (RT-1453 module boundaries). Other modules import from here, not from
 * the files inside. It exposes only what a Console route needs to be guarded: the human session
 * guards (`DashboardAuthGuard`, and RT-1484 `SessionOnlyAdminGuard`, which also refuses every
 * bearer and checks a write's `Origin`) and the role gate (`@Roles` + `RolesGuard`). RT-1565 adds
 * `usersLiveAt`, the one read of `users` that sale attribution needs, on the caller's client.
 */
export type { AuthedRequest } from "./auth.guard";
export { DashboardAuthGuard } from "./dashboard-auth.guard";
export { Roles } from "./roles.decorator";
export { RolesGuard } from "./roles.guard";
export { SessionOnlyAdminGuard } from "./session-only-admin.guard";
export { usersLiveAt } from "./users-live-at";
