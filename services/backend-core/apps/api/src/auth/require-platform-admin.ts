/**
 * The platform-admin check of the Console platform routes (RT-1353 unlock and mark-provisioned,
 * RT-1358 provisioner credentials): a human cookie session whose user has
 * `users.is_platform_admin`. Anything else is the generic 403 `forbidden`.
 */
import { ForbiddenException } from "@nestjs/common";

import type { MembershipRepository } from "../context/membership.repository";
import type { Principal } from "./auth.guard";

export async function requirePlatformAdminSession(
  memberships: Pick<MembershipRepository, "isPlatformAdmin">,
  principal: Principal | undefined,
): Promise<string> {
  if (principal?.kind !== "session" || !(await memberships.isPlatformAdmin(principal.userId))) {
    throw new ForbiddenException({ code: "forbidden", message: "Platform admin required" });
  }
  return principal.userId;
}
