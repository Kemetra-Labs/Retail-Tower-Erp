/**
 * RT-1298: how the registry writes are wired, read from the Nest metadata (no
 * boot, no database). The HTTP specs build their own module without the global
 * `FailClosedAuthGuard`, so this is what pins the part they cannot:
 *
 *   - the workflow's routes (register, withdraw) are `@Public()` for the global
 *     cookie guard and are guarded ONLY by `PromotionWriterGuard`, declared on the
 *     class and on no handler: a public route with a forgotten guard would be open
 *     to the world;
 *   - the activation route is NOT public and is guarded by the Console session
 *     (`SessionOnlyAdminGuard`) and then `PlatformAdminGuard`;
 *   - no handler of either controller carries a guard or a public marker of its
 *     own, so the class-level declaration is the whole story;
 *   - the three operations sit on the contract's paths and methods;
 *   - RT-1328: the registry read (`platformListPilotReleases`) sits on the
 *     session controller, never on the public workflow controller, so the
 *     cookie and platform-admin guards cover it.
 */
import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import "reflect-metadata";

import { PlatformAdminGuard } from "../../src/audit/platform-admin.guard";
import { SessionOnlyAdminGuard } from "../../src/auth/session-only-admin.guard";
import { IS_PUBLIC_KEY } from "../../src/auth/route-auth";
import { PilotReleaseActivationController } from "../../src/pos-pilot-releases/pilot-release-activation.controller";
import { PilotReleaseWritesController } from "../../src/pos-pilot-releases/pilot-release-writes.controller";
import { PromotionWriterGuard } from "../../src/pos-pilot-releases/promotion-writer.guard";

type Controller = { prototype: object };

/** The guard classes a controller (class level) declares, in order. */
const classGuards = (controller: object): unknown[] => (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined) ?? [];
/** The handler functions of a controller, by name. */
const handlers = (controller: Controller): Record<string, object> =>
  Object.fromEntries(
    Object.getOwnPropertyNames(controller.prototype)
      .filter((name) => name !== "constructor")
      .map((name) => [name, (controller.prototype as Record<string, object>)[name] as object]),
  );
/** The route a handler declares. */
const routeOf = (handler: object) => ({
  path: Reflect.getMetadata(PATH_METADATA, handler) as string,
  method: Reflect.getMetadata(METHOD_METADATA, handler) as number,
});

describe("RT-1298 registry write wiring", () => {
  it("serves register and withdraw to the promotion workflow only: public for the cookie guard, guarded by the OIDC guard alone", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, PilotReleaseWritesController)).toBe(true);
    expect(classGuards(PilotReleaseWritesController)).toEqual([PromotionWriterGuard]);
  });

  it("serves activate to a platform admin on the Console session: not public, session guard then platform-admin guard", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, PilotReleaseActivationController)).toBeUndefined();
    expect(classGuards(PilotReleaseActivationController)).toEqual([SessionOnlyAdminGuard, PlatformAdminGuard]);
  });

  it.each([
    ["the workflow controller", PilotReleaseWritesController],
    ["the activation controller", PilotReleaseActivationController],
  ])("puts no guard and no public marker on a handler of %s", (_label, controller) => {
    for (const [name, handler] of Object.entries(handlers(controller))) {
      expect([name, Reflect.getMetadata(GUARDS_METADATA, handler)]).toEqual([name, undefined]);
      expect([name, Reflect.getMetadata(IS_PUBLIC_KEY, handler)]).toEqual([name, undefined]);
    }
  });

  it("puts the three operations on the contract's paths and methods", () => {
    expect(Reflect.getMetadata(PATH_METADATA, PilotReleaseWritesController)).toBe("api/v1/platform/pos-pilot-releases");
    expect(Reflect.getMetadata(PATH_METADATA, PilotReleaseActivationController)).toBe("api/v1/platform/pos-pilot-releases");
    const writes = handlers(PilotReleaseWritesController);
    expect(routeOf(writes["register"] as object)).toEqual({ path: "/", method: RequestMethod.POST });
    expect(routeOf(writes["withdraw"] as object)).toEqual({ path: ":releaseId/withdraw", method: RequestMethod.POST });
    const activation = handlers(PilotReleaseActivationController);
    expect(routeOf(activation["activate"] as object)).toEqual({ path: ":releaseId/activate", method: RequestMethod.POST });
    // RT-1328: the read is a GET on the guarded session controller, not on the public one.
    expect(routeOf(activation["list"] as object)).toEqual({ path: "/", method: RequestMethod.GET });
  });

  it("keeps each controller to exactly its routes, so the class-level guard covers all of them", () => {
    expect(Object.keys(handlers(PilotReleaseWritesController)).sort()).toEqual(["register", "withdraw"]);
    expect(Object.keys(handlers(PilotReleaseActivationController)).sort()).toEqual(["activate", "list"]);
  });
});
