/**
 * Pre-authentication of `binViewReportSnapshot` callers (RT-1295).
 *
 * `registerJsonBodyParsers` reads a large snapshot body (up to 32 MiB) before
 * Nest runs the route's guards. This authorizer runs those same guards on the
 * request headers first, so only an authorized connector can make the API
 * buffer a large body or hold one of the two large-body slots
 * (`common/json-body-limits.ts`).
 *
 * It reuses the route's own guards, in the route's order, so the rules cannot
 * drift: `ConnectorAuthGuard` (opaque bearer, `connector` scope, linked to an
 * active registration; non-disclosing 401) then `ConnectorEnvironmentGuard`
 * (registration environment equals `DEPLOYMENT_ENVIRONMENT`; 403). The route's
 * guards still run again after parsing; this is an early gate, not a
 * replacement.
 *
 * A request carrying the dashboard session cookie is refused 401 here without
 * a lookup: `AuthGuard` prefers the cookie, and `ConnectorAuthGuard` refuses
 * every session principal, so the route would refuse it too. Short-circuiting
 * also keeps the cookie-only RT-430 / RT-414 origin path (which needs a route
 * handler) out of this pre-routing context.
 */
import { UnauthorizedException } from "@nestjs/common";

import type { SnapshotCallerAuthorizer } from "../common/json-body-limits";
import type { AuthTokenRepository } from "./auth-token.repository";
import { readSessionCookie, type AuthedRequest } from "./auth.guard";
import { ConnectorAuthGuard } from "./connector-auth.guard";
import { ConnectorEnvironmentGuard } from "./connector-environment.guard";
import { preRouteHttpContext } from "./pre-route-context";
import type { SessionRepository } from "./session.repository";

/**
 * The connector guards only call `switchToHttp().getRequest()`; there is no
 * route handler or class yet, so those accessors throw if a guard ever needs
 * them (fails closed as a refusal, never as an admit).
 */
function noRoute(): never {
  throw new UnauthorizedException("Unauthorized");
}

/** The production authorizer for `registerJsonBodyParsers` (main.ts). */
export function connectorSnapshotCallerAuthorizer(
  sessions: SessionRepository,
  authTokens: AuthTokenRepository,
): SnapshotCallerAuthorizer {
  const authGuard = new ConnectorAuthGuard(sessions, authTokens);
  const environmentGuard = new ConnectorEnvironmentGuard();
  return async (req, res) => {
    if (readSessionCookie(req as AuthedRequest) !== null) {
      throw new UnauthorizedException("Unauthorized");
    }
    const context = preRouteHttpContext(req, res, noRoute);
    await authGuard.canActivate(context);
    environmentGuard.canActivate(context);
  };
}
