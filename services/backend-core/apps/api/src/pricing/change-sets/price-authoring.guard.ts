/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — the Pricing authoring gate as a guard (RT-1484 comment 17881,
 * follow-up 5: the gate is structural). It runs on every route of `PriceChangeSetsController`,
 * after `SessionOnlyAdminGuard`, `TenantContextGuard` and `RolesGuard`, so the session tenant is
 * known and a role outside `owner` / `tenant_admin` has already had its non-disclosing 404.
 *
 * A safe method (GET, HEAD) passes: reads stay open. Any other method of a tenant that is not on
 * `PRICING_AUTHORING_TENANT_ALLOWLIST` is `409 pricing_authority_legacy` (owner decision 1,
 * comment 17829; spec 044 §6.1) before the idempotency interceptor claims its key, so nothing is
 * written and nothing is held. A new write route is gated without a per-route decorator; the unit
 * spec walks the controller's routes and asserts each non-GET one is refused.
 */
import { HttpException, Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";

import type { TenantContextRequest } from "../../context";
import { isPricingAuthoringAllowed, PRICING_AUTHORING_CONFIG, type PricingAuthoringConfig } from "./price-authoring.config";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

const AUTHORING_REFUSAL = {
  code: "pricing_authority_legacy",
  message: "Price authoring is not enabled for this tenant.",
} as const;

@Injectable()
export class PricingAuthoringGuard implements CanActivate {
  constructor(@Inject(PRICING_AUTHORING_CONFIG) private readonly config: PricingAuthoringConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TenantContextRequest & { method?: string }>();
    if (SAFE_METHODS.has((request.method ?? "").toUpperCase())) return true;
    const tenantId = request.context?.tenantId ?? null;
    if (tenantId === null) throw new UnauthorizedException("Unauthorized");
    if (!isPricingAuthoringAllowed(this.config, tenantId)) throw new HttpException(AUTHORING_REFUSAL, 409);
    return true;
  }
}
